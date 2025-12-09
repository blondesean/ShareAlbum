const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");

const s3 = new S3Client({ region: "us-west-2" });
const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const BUCKET = process.env.BUCKET_NAME;
const FAVORITES_TABLE = process.env.FAVORITES_TABLE;

exports.handler = async (event) => {
  try {
    if (!BUCKET) {
      throw new Error("Bucket is not defined");
    }

    // Get user ID from Cognito authorizer
    const userId = event.requestContext?.authorizer?.claims?.sub;

    const command = new ListObjectsV2Command({ Bucket: BUCKET });
    const data = await s3.send(command);

    // Get user's favorites if authenticated
    let userFavorites = new Set();
    if (userId && FAVORITES_TABLE) {
      const favoritesResult = await dynamodb.send(new QueryCommand({
        TableName: FAVORITES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': { S: userId }
        }
      }));
      
      userFavorites = new Set(
        (favoritesResult.Items || []).map(item => item.photoKey.S)
      );
    }

    // Generate signed URLs for each photo (valid for 1 hour)
    const photos = await Promise.all(
      (data.Contents || [])
        .filter(obj => obj.Key && obj.Key.endsWith(".jpg"))
        .map(async (obj) => {
          const getObjectCommand = new GetObjectCommand({
            Bucket: BUCKET,
            Key: obj.Key,
          });
          const signedUrl = await getSignedUrl(s3, getObjectCommand, { expiresIn: 3600 });
          
          return {
            key: obj.Key,
            url: signedUrl,
            isFavorite: userFavorites.has(obj.Key),
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
