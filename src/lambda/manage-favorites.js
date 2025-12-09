const { DynamoDBClient, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const TABLE_NAME = process.env.TABLE_NAME;

exports.handler = async (event) => {
  try {
    // Get user ID from Cognito authorizer
    const userId = event.requestContext.authorizer.claims.sub;
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const photoKey = body.photoKey;

    if (!photoKey) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ error: "photoKey is required" }),
      };
    }

    // Add or remove favorite based on HTTP method
    if (event.httpMethod === 'POST') {
      // Add favorite
      await dynamodb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: { S: userId },
          photoKey: { S: photoKey },
          createdAt: { N: Date.now().toString() },
        },
      }));

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ message: "Favorite added" }),
      };
    } else if (event.httpMethod === 'DELETE') {
      // Remove favorite
      await dynamodb.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: {
          userId: { S: userId },
          photoKey: { S: photoKey },
        },
      }));

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ message: "Favorite removed" }),
      };
    }

    return {
      statusCode: 405,
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:5173",
      },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:5173",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
