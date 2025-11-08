const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({ region: "us-west-2" });
const BUCKET = process.env.BUCKET_NAME;

exports.handler = async () => {
  try {
    if (!BUCKET) {
      throw new Error("Bucket is not defined");
    }

    const command = new ListObjectsV2Command({ Bucket: BUCKET });
    const data = await s3.send(command);

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
          };
        })
    );
    
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: JSON.stringify(photos),
    };
    
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
