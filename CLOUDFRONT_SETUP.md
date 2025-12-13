# CloudFront Signed URLs Setup Guide

This guide will help you set up CloudFront signed URLs for secure, cost-effective photo delivery in your ShareAlbum application.

## Overview

CloudFront signed URLs provide:
- **Security**: Only authenticated users can access photos via time-limited signed URLs
- **Cost Savings**: CloudFront caching reduces S3 data transfer costs by up to 85%
- **Performance**: Global CDN edge locations deliver photos faster worldwide
- **CORS Support**: Proper CORS headers for seamless frontend integration

## Current System Status

✅ **CloudFront Distribution**: Configured with S3 origin and CORS headers  
✅ **CDK Integration**: Automated public key and key group creation  
✅ **Lambda Integration**: Signed URL generation with 1-hour expiration  
✅ **Secrets Manager**: Secure private key storage with caching  
✅ **API Gateway**: Cognito-authenticated endpoints  

## Prerequisites

1. AWS CLI configured with appropriate permissions
2. OpenSSL installed (for key generation)
3. CDK stack ready for deployment

## Step 1: Generate CloudFront Key Pair

CloudFront key pairs can only be created by the AWS root account. If you're not the root account, you'll need to ask your AWS administrator to create the key pair.

### Option A: Using AWS Console (Root Account Only)

1. Go to [CloudFront Console](https://console.aws.amazon.com/cloudfront/)
2. Navigate to **Public Keys** in the left sidebar
3. Click **Create public key**
4. Give it a name (e.g., `album-share-key-pair`)
5. Upload your public key (see below for how to generate it)
6. Note the **Key pair ID** - you'll need this

### Option B: Generate Key Pair Locally

You can generate an RSA key pair using OpenSSL from **any directory** on your local machine.

#### For Windows Users:

**Option B1: Install OpenSSL for Windows**

1. **Install OpenSSL** (choose one method):
   - **Using Chocolatey** (if you have it):
     ```powershell
     choco install openssl
     ```
   - **Using Git for Windows** (if installed): OpenSSL is included with Git. Use Git Bash:
     ```bash
     # Open Git Bash, then:
     openssl genrsa -out cloudfront-private-key.pem 2048
     openssl rsa -pubout -in cloudfront-private-key.pem -out cloudfront-public-key.pem
     ```
   - **Download manually**: Get OpenSSL from [slproweb.com](https://slproweb.com/products/Win32OpenSSL.html) (install the "Light" version)

2. **After installing**, open PowerShell and navigate to a secure location:
   ```powershell
   # Create a secure directory
   New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.aws-keys"
   cd "$env:USERPROFILE\.aws-keys"
   
   # Generate private key
   openssl genrsa -out cloudfront-private-key.pem 2048
   
   # Generate public key
   openssl rsa -pubout -in cloudfront-private-key.pem -out cloudfront-public-key.pem
   
   # View the public key
   Get-Content cloudfront-public-key.pem
   ```

**Option B2: Use AWS Console (Easier for Windows)**

If you prefer not to install OpenSSL, you can use the AWS Console method (Option A above) which doesn't require any local tools.

#### For Linux/Mac Users:

**Recommended**: Create a secure directory for your keys (outside of your project to avoid accidentally committing them):

```bash
# Navigate to a secure location (e.g., your home directory or a dedicated keys folder)
cd ~
mkdir -p .aws-keys
cd .aws-keys

# Generate private key
openssl genrsa -out cloudfront-private-key.pem 2048

# Generate public key
openssl rsa -pubout -in cloudfront-private-key.pem -out cloudfront-public-key.pem

# View the public key (you'll need this)
cat cloudfront-public-key.pem
```

**Important**: 
- The public key must be in PEM format and start with `-----BEGIN PUBLIC KEY-----`
- **Never commit these key files to version control** - add them to `.gitignore` if generating in your project directory
- Store the private key securely and delete it from your local machine after uploading to Secrets Manager (optional but recommended)

## Step 2: Provide Public Key to CDK Stack

**Important**: The CDK stack automatically creates the CloudFront public key and key group. You just need to place your public key file in the correct location.

### Simple File Placement Method (Recommended)

1. **Copy your public key file** to the project root directory:
   ```bash
   # Copy your generated public key to the project root
   cp ~/.aws-keys/cloudfront-public-key.pem ShareAlbum/cloudfront-public-key.pem
   ```

2. **Deploy the stack** from the src directory:
   ```bash
   cd ShareAlbum/src
   cdk deploy
   ```

**What happens automatically:**
- ✅ CDK reads the public key from `cloudfront-public-key.pem`
- ✅ CDK creates the CloudFront public key resource
- ✅ CDK creates the key group and associates it with your distribution
- ✅ CDK configures the distribution to require signed URLs
- ✅ The Key Pair ID is automatically set in Lambda environment variables

### Alternative: Context Parameter Method

If you prefer to keep the key elsewhere, use the context parameter:

```bash
# Navigate to your project's src directory
cd ShareAlbum/src

# Deploy with public key path
cdk deploy -c cloudfrontPublicKey="$(cat /path/to/your/cloudfront-public-key.pem)"
```

## Step 3: Store Private Key in AWS Secrets Manager

Store your private key securely in Secrets Manager. **You can run this from any directory**, but make sure to use the correct path to your private key file:

### For Windows (PowerShell):

```powershell
# Get the secret name from CDK output
$SECRET_NAME = aws cloudformation describe-stacks `
  --stack-name AlbumShareStack `
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontPrivateKeySecretName`].OutputValue' `
  --output text

# Read the private key and escape it for JSON
$privateKey = Get-Content "$env:USERPROFILE\.aws-keys\cloudfront-private-key.pem" -Raw
$privateKeyEscaped = $privateKey -replace '"', '\"' -replace "`n", '\n' -replace "`r", ''
$json = "{`"privateKey`":`"$privateKeyEscaped`"}"

# Store the private key
aws secretsmanager put-secret-value `
  --secret-id $SECRET_NAME `
  --secret-string $json
```

### For Linux/Mac:

```bash
# Get the secret name from CDK output
SECRET_NAME=$(aws cloudformation describe-stacks \
  --stack-name AlbumShareStack \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontPrivateKeySecretName`].OutputValue' \
  --output text)

# Store the private key (adjust path to where you saved your private key)
aws secretsmanager put-secret-value \
  --secret-id $SECRET_NAME \
  --secret-string "{\"privateKey\":\"$(cat ~/.aws-keys/cloudfront-private-key.pem | tr -d '\n')\"}"
```

**Important**: 
- The private key must include the full PEM format including headers
- Adjust the path to match where you saved your private key
- On Windows, use `$env:USERPROFILE` instead of `~`
- The commands above handle newlines automatically

## Step 4: Verify CloudFront Distribution Configuration

After deploying the stack, verify the configuration:

1. Go to CloudFront Console → **Distributions** → Your distribution → **Behaviors**
2. Edit the default behavior
3. Verify that **Restrict viewer access** is set to **Yes**
4. Verify that your **Key group** is selected (not trusted signers)
5. If not configured automatically, update it and save

**Note**: The CDK stack should configure this automatically, but verify it's set correctly.

## Step 4: Verify Setup

1. **Deploy your updated stack:**
   ```bash
   cd ShareAlbum/src
   cdk deploy
   ```

2. **Check CDK outputs** for important values:
   ```bash
   # View all stack outputs
   aws cloudformation describe-stacks --stack-name AlbumShareStack --query 'Stacks[0].Outputs'
   ```

3. **Test the API endpoint** (requires Cognito authentication):
   ```bash
   # First authenticate with Cognito to get a JWT token
   # Then test the photos endpoint:
   curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     https://YOUR_API_GATEWAY_URL/photos
   ```

4. **Verify signed URLs** in the response:
   ```json
   {
     "photos": [
       {
         "key": "photo.jpg",
         "url": "https://d1234567890.cloudfront.net/photo.jpg?Expires=1234567890&Signature=...&Key-Pair-Id=K1Z1RZVGH84X8O",
         "isFavorite": false,
         "favoriteCount": 0
       }
     ]
   }
   ```

5. **Test image loading** in your React app:
   - Signed URLs should load images successfully
   - URLs expire after 1 hour for security
   - CORS headers should allow frontend access

## Troubleshooting

### Error: "Private key not found in secret"
**Cause**: Private key not stored in AWS Secrets Manager  
**Solution**: 
- Ensure you completed Step 3 (storing private key in Secrets Manager)
- Verify the secret JSON format: `{"privateKey":"-----BEGIN RSA PRIVATE KEY-----\n..."}`
- Check the secret name matches the CDK output

### Error: "CloudFront domain or key pair ID not configured"
**Cause**: Lambda environment variables not set  
**Solution**: 
- Redeploy the CDK stack: `cdk deploy`
- Check Lambda function environment variables in AWS Console
- Verify CDK outputs show the CloudFront domain and key pair ID

### Photos not loading / CORS errors
**Cause**: CloudFront CORS configuration or signed URL issues  
**Solution**: 
- Verify CloudFront distribution has CORS response headers policy
- Check that signed URLs are not expired (1-hour limit)
- Ensure your React app origin is in the CORS allow list

### Invalid signature errors
**Cause**: Key mismatch or format issues  
**Solution**: 
- Verify private key format includes proper PEM headers
- Ensure the Key-Pair-Id in signed URLs matches CloudFront public key ID
- Check that public and private keys are from the same pair

### CDK deployment fails with "Public key file not found"
**Cause**: Missing `cloudfront-public-key.pem` file  
**Solution**: 
- Ensure the public key file is in the project root: `ShareAlbum/cloudfront-public-key.pem`
- Verify file permissions and content format
- Check file path in CDK stack code

### Lambda timeout errors
**Cause**: Secrets Manager calls taking too long  
**Solution**: 
- Private key is cached after first retrieval
- Check AWS region configuration
- Verify Secrets Manager permissions for Lambda role

## Architecture Overview

```mermaid
graph TB
    subgraph "User Request Flow"
        USER[User] --> REACT[React App]
        REACT --> API[API Gateway]
        API --> LAMBDA[Inventory Lambda]
    end
    
    subgraph "CloudFront Signed URL Generation"
        LAMBDA --> SM[Secrets Manager<br/>Private Key]
        LAMBDA --> CF[CloudFront<br/>Public Key]
        LAMBDA --> SIGN[Generate Signed URL]
    end
    
    subgraph "Photo Delivery"
        REACT --> CFCDN[CloudFront CDN]
        CFCDN --> S3[S3 Bucket<br/>Private Photos]
    end
    
    subgraph "Security Layer"
        COGNITO[Cognito Auth] --> API
        SIGN --> EXPIRE[1-hour expiration]
        CFCDN --> VALIDATE[Signature Validation]
    end
    
    classDef security fill:#f44336,color:#fff
    classDef aws fill:#ff9800,color:#fff
    classDef user fill:#2196f3,color:#fff
    
    class COGNITO,EXPIRE,VALIDATE security
    class API,LAMBDA,SM,CF,CFCDN,S3 aws
    class USER,REACT user
```

## Security Features

- 🔐 **Cognito Authentication**: Only authenticated users can request signed URLs
- ⏰ **Time-Limited URLs**: All signed URLs expire after 1 hour
- 🔑 **Private Key Security**: Keys stored in AWS Secrets Manager, cached in Lambda memory
- 🚫 **No Public Access**: S3 bucket blocks all public access
- 🛡️ **Signature Validation**: CloudFront validates every request signature
- 🔄 **Key Rotation**: Easy key rotation through Secrets Manager updates

## Performance Optimizations

- ⚡ **Edge Caching**: CloudFront caches images at 200+ global edge locations
- 🚀 **Private Key Caching**: Lambda caches private key to avoid repeated Secrets Manager calls
- 📦 **Batch Processing**: Multiple signed URLs generated efficiently in single Lambda execution
- 🎯 **Optimized Cache Policy**: 24-hour cache duration for images
- 🌐 **CORS Headers**: Proper CORS configuration for seamless frontend integration

## Cost Benefits

| Feature | Cost Savings |
|---------|-------------|
| **CloudFront Caching** | Up to 85% reduction in S3 data transfer costs |
| **Edge Locations** | Reduced latency = better user experience |
| **Private Key Caching** | Fewer Secrets Manager API calls |
| **DynamoDB On-Demand** | Pay only for actual usage |
| **Lambda Efficiency** | Sub-second execution times |

Monitor costs in AWS Cost Explorer to track your savings over time.

## System Monitoring

### CloudWatch Metrics to Monitor

1. **CloudFront Metrics**:
   - Cache Hit Rate (target: >80%)
   - Origin Requests (should decrease over time)
   - 4xx/5xx Error Rates

2. **Lambda Metrics**:
   - Duration (should be <1000ms)
   - Error Rate (target: <1%)
   - Concurrent Executions

3. **S3 Metrics**:
   - Data Transfer (should decrease with CloudFront)
   - Request Count (should decrease with caching)

### Health Check Commands

```bash
# Check CloudFront distribution status
aws cloudfront get-distribution --id YOUR_DISTRIBUTION_ID

# Verify Secrets Manager secret
aws secretsmanager describe-secret --secret-id YOUR_SECRET_NAME

# Test Lambda function
aws lambda invoke --function-name Album-Share-Inventory-Describer response.json

# Check API Gateway health
curl -H "Authorization: Bearer YOUR_TOKEN" https://YOUR_API_URL/photos
```

### Performance Benchmarks

- **First Load**: ~2-3 seconds (includes authentication)
- **Cached Load**: ~200-500ms (CloudFront edge cache)
- **Signed URL Generation**: ~100-200ms per batch
- **Private Key Retrieval**: ~50ms (cached after first call)

---

*Last Updated: December 2024 - Reflects current ShareAlbum CloudFront implementation*

