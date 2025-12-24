const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { DynamoDBClient, QueryCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getSignedUrl } = require("@aws-sdk/cloudfront-signer");


const s3 = new S3Client({ region: "us-west-2" });
const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const secretsManager = new SecretsManagerClient({ region: "us-west-2" });

const BUCKET = process.env.BUCKET_NAME;
const FAVORITES_TABLE = process.env.FAVORITES_TABLE;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID;
const CLOUDFRONT_PRIVATE_KEY_SECRET_NAME = process.env.CLOUDFRONT_PRIVATE_KEY_SECRET_NAME;

// Cache the private key to avoid repeated Secrets Manager calls
let cachedPrivateKey = null;
let privateKeyPromise = null;

/**
 * Get CloudFront private key from Secrets Manager
 */
async function getPrivateKey() {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  // If we're already fetching the private key, wait for that promise
  if (privateKeyPromise) {
    return await privateKeyPromise;
  }

  if (!CLOUDFRONT_PRIVATE_KEY_SECRET_NAME) {
    throw new Error("CLOUDFRONT_PRIVATE_KEY_SECRET_NAME not configured");
  }

  // Create a promise to fetch the private key once
  privateKeyPromise = (async () => {
    try {
      const command = new GetSecretValueCommand({
        SecretId: CLOUDFRONT_PRIVATE_KEY_SECRET_NAME,
      });
      const response = await secretsManager.send(command);
      const secret = JSON.parse(response.SecretString);
      let rawPrivateKey = secret.privateKey || secret.placeholder;
      
      if (!rawPrivateKey || rawPrivateKey === '') {
        throw new Error("Private key not found in secret. Please populate the secret with the CloudFront private key.");
      }
      
      // Ensure proper newline formatting for the private key
      cachedPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');
      
      return cachedPrivateKey;
    } catch (error) {
      console.error("Error retrieving private key:", error);
      // Reset the promise so we can retry
      privateKeyPromise = null;
      throw new Error(`Failed to retrieve CloudFront private key: ${error.message}`);
    }
  })();

  return await privateKeyPromise;
}

/**
 * Generate a CloudFront signed URL using AWS SDK (official implementation)
 * @param {string} resourcePath - The path to the resource (e.g., photo.jpg)
 * @param {number} expiresIn - Expiration time in seconds (default: 1 hour)
 * @returns {string} Signed CloudFront URL
 */
async function getCloudFrontSignedUrl(resourcePath, expiresIn = 3600) {
  if (!CLOUDFRONT_DOMAIN || !CLOUDFRONT_KEY_PAIR_ID) {
    throw new Error("CloudFront domain or key pair ID not configured");
  }

  const privateKey = await getPrivateKey();
  
  // Remove leading slash if present
  const path = resourcePath.startsWith('/') ? resourcePath.substring(1) : resourcePath;
  
  // Create the base URL
  const url = `https://${CLOUDFRONT_DOMAIN}/${path}`;
  
  // Calculate expiration time (Date object)
  const dateLessThan = new Date(Date.now() + (expiresIn * 1000));
  
  try {
    // Use AWS SDK's official CloudFront signer
    const signedUrl = getSignedUrl({
      url,
      keyPairId: CLOUDFRONT_KEY_PAIR_ID,
      dateLessThan,
      privateKey,
    });
    
    return signedUrl;
  } catch (error) {
    console.error(`Error generating CloudFront signed URL:`, error);
    throw new Error(`Failed to generate CloudFront signed URL: ${error.message}`);
  }
}

/**
 * Generate a random S3 key to start pagination from
 * This creates better distribution across the entire photo collection
 * @returns {string|null} Random key to start after, or null to start from beginning
 */
function generateRandomStartKey() {
  // 15% chance to start from the very beginning for variety
  if (Math.random() < 0.15) {
    return null;
  }
  
  // Define the actual folder patterns found in the S3 bucket
  const strategies = [
    // Strategy 1: YYYY_Month format (most common pattern)
    () => {
      const years = [1962, 1976, 1980, 1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2015, 2025];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      
      const year = years[Math.floor(Math.random() * years.length)];
      const month = months[Math.floor(Math.random() * months.length)];
      return `${year}_${month}`;
    },
    
    // Strategy 2: Memory folders (descriptive names)
    () => {
      const memoryFolders = [
        'older_duncan_memories',
        'older_sherman_memories', 
        'early_duncan_memories',
        'hunting_memories',
        'julia_memories'
      ];
      return memoryFolders[Math.floor(Math.random() * memoryFolders.length)];
    },
    
    // Strategy 3: Special folders
    () => {
      const specialFolders = ['Christmas_Cards', 'Misc', 'CDs', 'iPhones'];
      return specialFolders[Math.floor(Math.random() * specialFolders.length)];
    },
    
    // Strategy 4: Random year prefix (to catch year-based folders)
    () => {
      const years = [1962, 1976, 1980, 1987, 1988, 1989, 1990, 1991, 1992, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2015, 2025];
      return years[Math.floor(Math.random() * years.length)].toString();
    },
    
    // Strategy 5: Single character for broad distribution
    () => {
      const chars = '123456789abcdefghijklmnopqrstuvwxyz'; // Start with numbers since many folders start with years
      return chars.charAt(Math.floor(Math.random() * chars.length));
    }
  ];
  
  // Give more weight to the YYYY_Month pattern since it's most common
  const weights = [0.8, 0.05, 0.05, 0.05, 0.05]; // 80% chance for YYYY_Month
  const random = Math.random();
  let cumulativeWeight = 0;
  
  for (let i = 0; i < strategies.length; i++) {
    cumulativeWeight += weights[i];
    if (random < cumulativeWeight) {
      return strategies[i]();
    }
  }
  
  // Fallback (shouldn't reach here)
  return strategies[0]();
}

exports.handler = async (event) => {
  try {
    if (!BUCKET) {
      throw new Error("Bucket is not defined");
    }

    // Get user ID from Cognito authorizer
    const userId = event.requestContext?.authorizer?.claims?.sub;

    // Parse pagination parameters from query string
    const queryParams = event.queryStringParameters || {};
    const limit = Math.min(parseInt(queryParams.limit) || 25, 100); // Default 25, max 100
    const nextToken = queryParams.nextToken || null;
    const tags = queryParams.tags ? queryParams.tags.split(',').map(t => t.trim()) : null; // Filter by tags

    // Build S3 ListObjectsV2 command with pagination
    const listParams = {
      Bucket: BUCKET,
      MaxKeys: limit,
    };

    // Add continuation token if provided, otherwise use random starting point
    if (nextToken) {
      try {
        // Decode the nextToken (base64 encoded S3 continuation token)
        listParams.ContinuationToken = Buffer.from(nextToken, 'base64').toString('utf-8');
      } catch (error) {
        throw new Error("Invalid nextToken provided");
      }
    } else {
      // For the first page, start from a random point in the S3 bucket
      // This provides true random discovery across the entire photo collection
      
      // Generate a random starting key to achieve uniform distribution
      // S3 keys are lexicographically ordered, so we generate a random prefix
      const randomStartKey = generateRandomStartKey();
      
      if (randomStartKey) {
        listParams.StartAfter = randomStartKey;
        console.log(`DEBUG: Starting after random key: ${randomStartKey}`);
      } else {
        console.log(`DEBUG: Starting from beginning (random choice)`);
      }
    }

    const command = new ListObjectsV2Command(listParams);
    const data = await s3.send(command);

    // If we started from a random point but got very few results, try from the beginning
    let finalData = data;
    if (!nextToken && listParams.StartAfter && (data.Contents || []).length < Math.min(limit / 2, 10)) {
      console.log(`DEBUG: Random start returned only ${(data.Contents || []).length} items, trying from beginning`);
      
      const fallbackParams = {
        Bucket: BUCKET,
        MaxKeys: limit,
      };
      
      try {
        const fallbackCommand = new ListObjectsV2Command(fallbackParams);
        const fallbackData = await s3.send(fallbackCommand);
        
        // Use fallback data if it has more results
        if ((fallbackData.Contents || []).length > (data.Contents || []).length) {
          finalData = fallbackData;
          console.log(`DEBUG: Using fallback data with ${(fallbackData.Contents || []).length} items`);
        }
      } catch (error) {
        console.error('Fallback query failed, using original results:', error);
      }
    }

    // Get user's favorites and all favorite counts if authenticated
    let userFavorites = new Set();
    let favoriteCounts = new Map();
    
    if (userId && FAVORITES_TABLE) {
      // Get current user's favorites
      const userFavoritesResult = await dynamodb.send(new QueryCommand({
        TableName: FAVORITES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': { S: userId }
        }
      }));
      
      userFavorites = new Set(
        (userFavoritesResult.Items || []).map(item => item.photoKey.S)
      );

      // Get all favorites to count per photo (scan entire table)
      const allFavoritesResult = await dynamodb.send(new ScanCommand({
        TableName: FAVORITES_TABLE,
        ProjectionExpression: 'photoKey'
      }));

      // Count favorites per photo
      (allFavoritesResult.Items || []).forEach(item => {
        const photoKey = item.photoKey.S;
        favoriteCounts.set(photoKey, (favoriteCounts.get(photoKey) || 0) + 1);
      });
    }

    // Pre-fetch the private key once to avoid multiple Secrets Manager calls
    if (CLOUDFRONT_DOMAIN && CLOUDFRONT_KEY_PAIR_ID) {
      await getPrivateKey(); // This will cache the key for all subsequent calls
    }

    // Filter for image files only - handle potential whitespace/special characters
    // Also exclude _a.jpg and _b.jpg variants completely
    const imageObjects = (finalData.Contents || [])
      .filter(obj => {
        if (!obj.Key) return false;
        const key = obj.Key.trim().toLowerCase();
        
        // Check if it's an image file
        const isImage = key.endsWith(".jpg") || key.endsWith(".jpeg") || key.endsWith(".png") || key.endsWith(".gif") || key.endsWith(".webp");
        if (!isImage) return false;
        
        // Exclude _a.jpg and _b.jpg variants completely
        if (key.includes('_a.') || key.includes('_b.')) {
          return false;
        }
        
        return true;
      });

    // Note: No need for complex duplicate filtering since we're excluding _a/_b variants entirely
    const filteredPhotos = imageObjects;
    
    console.log(`DEBUG: Filtered ${imageObjects.length} photos (excluded ${(finalData.Contents || []).length - imageObjects.length} non-images and _a/_b variants)`);

    // Generate CloudFront signed URLs for each photo (secure, cached, cost-effective)
    // URLs expire after 1 hour, ensuring only authenticated users can access photos
    const photos = await Promise.all(
      filteredPhotos.map(async (obj) => {
        let photoUrl;
        
        // Use CloudFront signed URLs if configured, otherwise fallback to error
        if (CLOUDFRONT_DOMAIN && CLOUDFRONT_KEY_PAIR_ID) {
          try {
            photoUrl = await getCloudFrontSignedUrl(obj.Key, 3600); // 1 hour expiration
          } catch (error) {
            console.error(`Error generating CloudFront signed URL for ${obj.Key}:`, error);
            // If CloudFront signing fails (e.g., private key not configured), throw error
            throw new Error(`Failed to generate signed URL: ${error.message}`);
          }
        } else {
          throw new Error("CloudFront configuration missing. Please configure CLOUDFRONT_DOMAIN and CLOUDFRONT_KEY_PAIR_ID.");
        }
        
        return {
          key: obj.Key,
          url: photoUrl,
          isFavorite: userFavorites.has(obj.Key),
          favoriteCount: favoriteCounts.get(obj.Key) || 0,
          lastModified: obj.LastModified,
          size: obj.Size,
        };
      })
    );

    // For first page only: Add a few missing favorites (not all) that weren't in the random S3 results
    if (!nextToken && userFavorites.size > 0) {
      const photosInResults = new Set(photos.map(p => p.key));
      const missingFavorites = Array.from(userFavorites).filter(fav => !photosInResults.has(fav));
      
      // Only add 2-3 missing favorites, not all of them, to leave room for random discovery
      const favoritesToAdd = Math.min(3, missingFavorites.length);
      
      // Generate URLs for a few missing favorites
      const missingFavoritePhotos = await Promise.all(
        missingFavorites.slice(0, favoritesToAdd).map(async (favoriteKey) => {
          let photoUrl;
          try {
            photoUrl = await getCloudFrontSignedUrl(favoriteKey, 3600);
            return {
              key: favoriteKey,
              url: photoUrl,
              isFavorite: true,
              favoriteCount: favoriteCounts.get(favoriteKey) || 0,
            };
          } catch (error) {
            console.error(`Error generating URL for favorite ${favoriteKey}:`, error);
            return null;
          }
        })
      );
      
      // Add valid favorite photos to the beginning
      const validMissingFavorites = missingFavoritePhotos.filter(p => p !== null);
      photos.unshift(...validMissingFavorites);
      
      console.log(`DEBUG: Added ${validMissingFavorites.length} missing favorites out of ${missingFavorites.length} total missing`);
    }

    // Sort photos: favorites first, then random order for discovery
    photos.sort((a, b) => {
      // If one is favorite and other isn't, favorite comes first
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      
      // If both are favorites or both are not favorites, randomize
      return Math.random() - 0.5;
    });

    // For the first page, trim to requested limit after sorting (favorites first, then random)
    const finalPhotos = nextToken ? photos : photos.slice(0, limit);

    console.log(`DEBUG: Final photos sample:`, finalPhotos.slice(0, 3).map(p => ({ key: p.key, isFavorite: p.isFavorite })));

    // Prepare response with pagination metadata
    const response = {
      photos: finalPhotos,
      pagination: {
        limit,
        count: finalPhotos.length,
        hasMore: finalData.IsTruncated && finalData.NextContinuationToken ? true : false,
      }
    };

    // Add nextToken if there are more results
    if (finalData.IsTruncated && finalData.NextContinuationToken) {
      response.pagination.nextToken = Buffer.from(finalData.NextContinuationToken, 'utf-8').toString('base64');
    }
    
    // Determine the appropriate CORS origin
    const origin = event.headers?.origin || event.headers?.Origin;
    const allowedOrigins = [
      'http://localhost:5173',
      'https://albumsharesdd.netlify.app'
    ];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:5173';

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Credentials": "false",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
      body: JSON.stringify(response),
    };
    
  } catch (err) {
    console.error(err);
    // Determine the appropriate CORS origin for error responses
    const origin = event.headers?.origin || event.headers?.Origin;
    const allowedOrigins = [
      'http://localhost:5173',
      'https://albumsharesdd.netlify.app'
    ];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:5173';

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Credentials": "false",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
