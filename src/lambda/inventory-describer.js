const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { DynamoDBClient, QueryCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getSignedUrl } = require("@aws-sdk/cloudfront-signer");


const s3 = new S3Client({ region: "us-west-2" });
const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const secretsManager = new SecretsManagerClient({ region: "us-west-2" });

const BUCKET = process.env.BUCKET_NAME;
const FAVORITES_TABLE = process.env.FAVORITES_TABLE;
const TAGS_TABLE = process.env.TAGS_TABLE;
const TAGS_GSI = 'tag-photoKey-index';
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

/**
 * Query the tag GSI to find all photoKeys that have been given a specific tag.
 * Optionally restrict results to keys that start with s3Prefix (for year/month combo).
 * Returns a deduplicated, sorted array of photoKeys.
 */
async function getPhotoKeysByTags(tags, s3Prefix) {
  const photoKeySet = new Set();

  for (const tag of tags) {
    let lastEvaluatedKey = undefined;
    do {
      const result = await dynamodb.send(new QueryCommand({
        TableName: TAGS_TABLE,
        IndexName: TAGS_GSI,
        KeyConditionExpression: 'tag = :tag',
        ExpressionAttributeValues: {
          ':tag': { S: tag }
        },
        ProjectionExpression: 'photoKey',
        ExclusiveStartKey: lastEvaluatedKey,
      }));
      (result.Items || []).forEach(item => photoKeySet.add(item.photoKey.S));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  }

  let photoKeys = Array.from(photoKeySet);

  // Apply year/month prefix filter if active
  if (s3Prefix) {
    photoKeys = photoKeys.filter(key => key.startsWith(s3Prefix));
  }

  // Exclude _a/_b variants (same rule as S3 path)
  photoKeys = photoKeys.filter(key => {
    const k = key.toLowerCase();
    return !k.includes('_a.') && !k.includes('_b.');
  });

  return photoKeys.sort(); // Stable sort for consistent pagination
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
    const year = queryParams.year ? queryParams.year.trim() : null;   // e.g. "1990"
    const month = queryParams.month ? queryParams.month.trim() : null; // e.g. "January" — only meaningful when year is also set
    const tags = queryParams.tags ? queryParams.tags.split(',').map(t => t.trim()).filter(Boolean) : null; // e.g. "birthday,family"

    // Build the S3 prefix from the active date filters.
    // Folder naming convention: YYYY_Month/  (e.g. 1990_January/)
    // - year + month  → exact folder prefix "1990_January"
    // - year only     → year prefix "1990_" (matches all months in that year)
    // - month only    → no usable prefix (month alone can't anchor a lexicographic prefix)
    const s3Prefix = year && month ? `${year}_${month}` : year ? `${year}_` : null;

    // Fetch this user's favorites and global favorite counts (needed by both tag and S3 paths)
    let userFavorites = new Set();
    let favoriteCounts = new Map();

    if (userId && FAVORITES_TABLE) {
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

      const allFavoritesResult = await dynamodb.send(new ScanCommand({
        TableName: FAVORITES_TABLE,
        ProjectionExpression: 'photoKey'
      }));
      (allFavoritesResult.Items || []).forEach(item => {
        const photoKey = item.photoKey.S;
        favoriteCounts.set(photoKey, (favoriteCounts.get(photoKey) || 0) + 1);
      });
    }

    // Pre-fetch the private key once to avoid multiple Secrets Manager calls
    if (CLOUDFRONT_DOMAIN && CLOUDFRONT_KEY_PAIR_ID) {
      await getPrivateKey();
    }

    // ── TAG FILTER PATH ──────────────────────────────────────────────────────
    // When tags are specified, bypass S3 listing entirely. Query the TagsTable
    // GSI to get the set of photoKeys that carry those tags, then generate
    // signed URLs for the paginated slice.
    if (tags && tags.length > 0 && TAGS_TABLE) {
      const tagOffset = nextToken
        ? parseInt(Buffer.from(nextToken, 'base64').toString('utf-8'), 10) || 0
        : 0;

      const allPhotoKeys = await getPhotoKeysByTags(tags, s3Prefix);
      const pageKeys = allPhotoKeys.slice(tagOffset, tagOffset + limit);
      const hasMore = tagOffset + limit < allPhotoKeys.length;

      const photos = await Promise.all(
        pageKeys.map(async (photoKey) => {
          try {
            const url = await getCloudFrontSignedUrl(photoKey, 3600);
            return {
              key: photoKey,
              url,
              isFavorite: userFavorites.has(photoKey),
              favoriteCount: favoriteCounts.get(photoKey) || 0,
            };
          } catch (error) {
            console.error(`Error generating URL for tag result ${photoKey}:`, error);
            return null;
          }
        })
      );

      const validPhotos = photos.filter(p => p !== null);

      const response = {
        photos: validPhotos,
        pagination: { limit, count: validPhotos.length, hasMore },
      };

      if (hasMore) {
        response.pagination.nextToken = Buffer.from(
          String(tagOffset + limit)
        ).toString('base64');
      }

      const origin = event.headers?.origin || event.headers?.Origin;
      const allowedOrigins = ['http://localhost:5173', 'https://albumsharesdd.netlify.app'];
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
    }

    // ── S3 LISTING PATH ──────────────────────────────────────────────────────
    // Default path: list photos from S3, using year/month prefix or random start.

    const listParams = {
      Bucket: BUCKET,
      MaxKeys: limit,
    };

    if (nextToken) {
      try {
        listParams.ContinuationToken = Buffer.from(nextToken, 'base64').toString('utf-8');
      } catch (error) {
        throw new Error("Invalid nextToken provided");
      }
      if (s3Prefix) {
        listParams.Prefix = s3Prefix;
      }
    } else if (s3Prefix) {
      listParams.Prefix = s3Prefix;
      console.log(`DEBUG: Filtering by prefix: ${s3Prefix}`);
    } else {
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
    if (!nextToken && !s3Prefix && listParams.StartAfter && (data.Contents || []).length < Math.min(limit / 2, 10)) {
      console.log(`DEBUG: Random start returned only ${(data.Contents || []).length} items, trying from beginning`);

      const fallbackParams = { Bucket: BUCKET, MaxKeys: limit };
      try {
        const fallbackData = await s3.send(new ListObjectsV2Command(fallbackParams));
        if ((fallbackData.Contents || []).length > (data.Contents || []).length) {
          finalData = fallbackData;
          console.log(`DEBUG: Using fallback data with ${(fallbackData.Contents || []).length} items`);
        }
      } catch (error) {
        console.error('Fallback query failed, using original results:', error);
      }
    }

    const imageObjects = (finalData.Contents || [])
      .filter(obj => {
        if (!obj.Key) return false;
        const key = obj.Key.trim().toLowerCase();
        const isImage = key.endsWith(".jpg") || key.endsWith(".jpeg") || key.endsWith(".png") || key.endsWith(".gif") || key.endsWith(".webp");
        if (!isImage) return false;
        if (key.includes('_a.') || key.includes('_b.')) return false;
        return true;
      });

    console.log(`DEBUG: Filtered ${imageObjects.length} photos (excluded ${(finalData.Contents || []).length - imageObjects.length} non-images and _a/_b variants)`);

    const photos = await Promise.all(
      imageObjects.map(async (obj) => {
        if (!CLOUDFRONT_DOMAIN || !CLOUDFRONT_KEY_PAIR_ID) {
          throw new Error("CloudFront configuration missing. Please configure CLOUDFRONT_DOMAIN and CLOUDFRONT_KEY_PAIR_ID.");
        }
        try {
          const photoUrl = await getCloudFrontSignedUrl(obj.Key, 3600);
          return {
            key: obj.Key,
            url: photoUrl,
            isFavorite: userFavorites.has(obj.Key),
            favoriteCount: favoriteCounts.get(obj.Key) || 0,
            lastModified: obj.LastModified,
            size: obj.Size,
          };
        } catch (error) {
          console.error(`Error generating CloudFront signed URL for ${obj.Key}:`, error);
          throw new Error(`Failed to generate signed URL: ${error.message}`);
        }
      })
    );

    // For first page only: inject a few of the user's favorites that weren't in the random S3 results
    if (!nextToken && userFavorites.size > 0) {
      const photosInResults = new Set(photos.map(p => p.key));
      const missingFavorites = Array.from(userFavorites).filter(fav => !photosInResults.has(fav));
      const favoritesToAdd = Math.min(3, missingFavorites.length);

      const missingFavoritePhotos = await Promise.all(
        missingFavorites.slice(0, favoritesToAdd).map(async (favoriteKey) => {
          try {
            const photoUrl = await getCloudFrontSignedUrl(favoriteKey, 3600);
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

      photos.unshift(...missingFavoritePhotos.filter(p => p !== null));
    }

    photos.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return Math.random() - 0.5;
    });

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
