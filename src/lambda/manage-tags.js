const { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({ region: "us-west-2" });
const TABLE_NAME = process.env.TABLE_NAME;

exports.handler = async (event) => {
  try {
    // Get user ID from Cognito authorizer
    const userId = event.requestContext.authorizer.claims.sub;
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const photoKey = body.photoKey;
    const tag = body.tag;

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

    // POST: Add a tag
    if (event.httpMethod === 'POST') {
      if (!tag || tag.trim().length === 0) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "http://localhost:5173",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
          },
          body: JSON.stringify({ error: "tag is required" }),
        };
      }

      const userIdTag = `${userId}#${tag.trim()}`;

      await dynamodb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          photoKey: { S: photoKey },
          userIdTag: { S: userIdTag },
          userId: { S: userId },
          tag: { S: tag.trim() },
          createdAt: { N: Date.now().toString() },
        },
      }));

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ message: "Tag added", tag: tag.trim() }),
      };
    } 
    
    // DELETE: Remove a tag
    else if (event.httpMethod === 'DELETE') {
      if (!tag || tag.trim().length === 0) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "http://localhost:5173",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
          },
          body: JSON.stringify({ error: "tag is required" }),
        };
      }

      const userIdTag = `${userId}#${tag.trim()}`;

      await dynamodb.send(new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: {
          photoKey: { S: photoKey },
          userIdTag: { S: userIdTag },
        },
      }));

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ message: "Tag removed" }),
      };
    }
    
    // GET: List all tags for a photo
    else if (event.httpMethod === 'GET') {
      const result = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'photoKey = :photoKey',
        ExpressionAttributeValues: {
          ':photoKey': { S: photoKey }
        }
      }));

      const tags = (result.Items || []).map(item => ({
        userId: item.userId.S,
        tag: item.tag.S,
        createdAt: parseInt(item.createdAt.N)
      }));

      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "http://localhost:5173",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({ tags }),
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
