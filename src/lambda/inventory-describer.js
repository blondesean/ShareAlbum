const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DynamoDBClient, QueryCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({ region: "us-west-2" });
const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const BUCKET = process.env.BUCKET_NAME;
const FAVORITES_TABLE = process.env.FAVORITES_TABLE;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;

exports.handler = async (event) => {
  try {
    if (!BUCKET) {
      throw new Error("Bucket is not defined");
    }

    // Get user ID from Cognito authorizer
    const userId = event.requestContext?.authorizer?.claims?.sub;

    const command = new ListObjectsV2Command({ Bucket: BUCKET });
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

    // Generate CloudFront URLs for each photo (or signed S3 URLs as fallback)
    const photos = await Promise.all(
      (data.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith(".jpg"))
        .map(async (obj) => {
          let url;
          
          if (CLOUDFRONT_DOMAIN) {
            // Use CloudFront URL (cached, faster)
            url = `https://${CLOUDFRONT_DOMAIN}/${obj.Key}`;
          } else {
            // Fallback to signed S3 URL
            const getObjectCommand = new GetObjectCommand({
              Bucket: BUCKET,
              Key: obj.Key,
            });
            url = await getSignedUrl(s3, getObjectCommand, { expiresIn: 3600 });
          }
          
          return {
            key: obj.Key,
            url: url,
            isFavorite: userFavorites.has(obj.Key),
            favoriteCount: favoriteCounts.get(obj.Key) || 0,
          };
        })
    );
    
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
      },
      body: JSON.stringify(photos),
    };
    
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:5173",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
