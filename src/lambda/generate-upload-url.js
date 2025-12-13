const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({ region: "us-west-2" });
const BUCKET = process.env.BUCKET_NAME;

// Helper function to get appropriate CORS origin
function getCorsOrigin(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowedOrigins = [
    'http://localhost:5173',
    'https://albumsharesdd.netlify.app'
  ];
  return allowedOrigins.includes(origin) ? origin : 'http://localhost:5173';
}

exports.handler = async (event) => {
  const corsOrigin = getCorsOrigin(event);
  
  try {
    // Get user ID from Cognito authorizer
    const userId = event.requestContext.authorizer.claims.sub;
    
    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const fileName = body.fileName;
    const fileType = body.fileType;

    if (!fileName || !fileType) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Allow-Credentials": "false",
        },
        body: JSON.stringify({ 
          error: "fileName and fileType are required" 
        }),
      };
    }

    // Validate file type (only allow images)
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(fileType.toLowerCase())) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Allow-Credentials": "false",
        },
        body: JSON.stringify({ 
          error: "Only image files are allowed (JPEG, PNG, GIF, WebP)" 
        }),
      };
    }

    // Generate unique key: timestamp_userId_originalFileName
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `${timestamp}_${userId.substring(0, 8)}_${sanitizedFileName}`;

    // Create presigned URL for upload (valid for 5 minutes)
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: fileType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Credentials": "false",
      },
      body: JSON.stringify({
        uploadUrl: uploadUrl,
        key: key,
        expiresIn: 300 // 5 minutes
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": corsOrigin,
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Credentials": "false",
      },
      body: JSON.stringify({ error: err.message }),
    };
  }
};