const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getSignedUrl } = require("@aws-sdk/cloudfront-signer");

const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const secretsManager = new SecretsManagerClient({ region: "us-west-2" });

const FAVORITES_TABLE = process.env.FAVORITES_TABLE;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const CLOUDFRONT_KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID;
const CLOUDFRONT_PRIVATE_KEY_SECRET_NAME = process.env.CLOUDFRONT_PRIVATE_KEY_SECRET_NAME;

// Cache the private key to avoid repeated Secrets Manager calls
let cachedPrivateKey = null;

/**
 * Get CloudFront private key from Secrets Manager
 */
async function getPrivateKey() {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  const command = new GetSecretValueCommand({
    SecretId: CLOUDFRONT_PRIVATE_KEY_SECRET_NAME,
  });
  const response = await secretsManager.send(command);
  const secret = JSON.parse(response.SecretString);
  cachedPrivateKey = secret.privateKey || secret.placeholder;
  
  if (!cachedPrivateKey || cachedPrivateKey === '') {
    throw new Error("Private key not found in secret");
  }
  
  return cachedPrivateKey.replace(/\\n/g, '\n');
}

/**
 * Generate CloudFront signed URL
 */
async function getCloudFrontSignedUrl(resourcePath, expiresIn = 3600) {
  const privateKey = await getPrivateKey();
  const path = resourcePath.startsWith('/') ? resourcePath.substring(1) : resourcePath;
  const url = `https://${CLOUDFRONT_DOMAIN}/${path}`;
  const dateLessThan = new Date(Date.now() + (expiresIn * 1000));
  
  return getSignedUrl({
    url,
    keyPairId: CLOUDFRONT_KEY_PAIR_ID,
    dateLessThan,
    privateKey,
  });
}

exports.handler = async (event) => {
  try {
    // Get user ID from Cognito authorizer
    const userId = event.requestContext?.authorizer?.claims?.sub;
    
    if (!userId) {
      throw new Error("User not authenticated");
    }

    // Parse query parameters
    const queryParams = event.queryStringParameters || {};
    const limit = Math.min(parseInt(queryParams.limit) || 50, 100); // Default 50, max 100

    // Get all favorites with counts
    const allFavoritesResult = await dynamodb.send(new ScanCommand({
      TableName: FAVORITES_TABLE,
      ProjectionExpression: 'photoKey'
    }));

    // Count favorites per photo
    const favoriteCounts = new Map();
    (allFavoritesResult.Items || []).forEach(item => {
      const photoKey = item.photoKey.S;
      favoriteCounts.set(photoKey, (favoriteCounts.get(photoKey) || 0) + 1);
    });

    // Sort by favorite count (most favorited first) and exclude _a/_b variants
    const sortedFavorites = Array.from(favoriteCounts.entries())
      .filter(([photoKey, count]) => {
        // Exclude _a.jpg and _b.jpg variants
        const key = photoKey.toLowerCase();
        return !key.includes('_a.') && !key.includes('_b.');
      })
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .slice(0, limit); // Apply limit

    // Generate signed URLs for favorites
    const favorites = await Promise.all(
      sortedFavorites.map(async ([photoKey, count]) => {
        try {
          const url = await getCloudFrontSignedUrl(photoKey, 3600);
          return {
            key: photoKey,
            url: url,
            favoriteCount: count,
            isFavorite: true
          };
        } catch (error) {
          console.error(`Error generating URL for favorite ${photoKey}:`, error);
          return null;
        }
      })
    );

    // Filter out failed URLs
    const validFavorites = favorites.filter(f => f !== null);

    // Determine CORS origin
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
      body: JSON.stringify({
        favorites: validFavorites,
        count: validFavorites.length,
        totalFavoritePhotos: favoriteCounts.size
      }),
    };
    
  } catch (err) {
    console.error(err);
    
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