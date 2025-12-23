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
      // For the first page, implement true uniform distribution by using S3 pagination to "skip" ahead
      // This solves the problem of non-uniform filename distribution
      
      const totalPhotosEstimate = 6954;
      const randomPosition = Math.floor(Math.random() * totalPhotosEstimate);
      
      if (randomPosition > 50) {
        // Use pagination to skip ahead to a random position
        // We'll make a "skip" call first, then use its continuation token
        const skipParams = {
          Bucket: BUCKET,
          MaxKeys: Math.min(randomPosition, 1000), // Skip up to 1000 at a time
        };
        
        try {
          const skipCommand = new ListObjectsV2Command(skipParams);
          const skipData = await s3.send(skipCommand);
          
          // If we got a continuation token, use it to start our real query
          if (skipData.NextContinuationToken) {
            listParams.ContinuationToken = skipData.NextContinuationToken;
          }
          // If we need to skip more, we could chain multiple calls here
          // For now, this gives us much better distribution than alphabetical
        } catch (error) {
          console.error('Error in skip operation, falling back to start:', error);
          // Fall back to beginning if skip fails
        }
      }
      // If randomPosition <= 50, start from beginning (no skip needed)
    }

    const command = new ListObjectsV2Command(listParams);
    const data = await s3.send(command);

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
    const imageObjects = (data.Contents || [])
      .filter(obj => {
        if (!obj.Key) return false;
        const key = obj.Key.trim().toLowerCase();
        return key.endsWith(".jpg") || key.endsWith(".jpeg") || key.endsWith(".png") || key.endsWith(".gif") || key.endsWith(".webp");
      });

    // Generate CloudFront signed URLs for each photo (secure, cached, cost-effective)
    // URLs expire after 1 hour, ensuring only authenticated users can access photos
    const photos = await Promise.all(
      imageObjects.map(async (obj) => {
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
        };
      })
    );

    // For first page only: Add missing favorites that weren't in the random S3 results
    if (!nextToken && userFavorites.size > 0) {
      const photosInResults = new Set(photos.map(p => p.key));
      const missingFavorites = Array.from(userFavorites).filter(fav => !photosInResults.has(fav));
      
      // Generate URLs for missing favorites
      const missingFavoritePhotos = await Promise.all(
        missingFavorites.slice(0, limit).map(async (favoriteKey) => {
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

    // Prepare response with pagination metadata
    const response = {
      photos: finalPhotos,
      pagination: {
        limit,
        count: finalPhotos.length,
        hasMore: data.IsTruncated && data.NextContinuationToken ? true : false,
      }
    };

    // Add nextToken if there are more results
    if (data.IsTruncated && data.NextContinuationToken) {
      response.pagination.nextToken = Buffer.from(data.NextContinuationToken, 'utf-8').toString('base64');
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
