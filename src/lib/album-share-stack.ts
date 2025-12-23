import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from "aws-cdk-lib/aws-iam";
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as fs from "fs";
import * as path from "path";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

import { CfnPublicKey, CfnKeyGroup } from 'aws-cdk-lib/aws-cloudfront';

export class AlbumShareStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ========================================
    // CORE INFRASTRUCTURE (Currently Active)
    // ========================================

    // Photo storage bucket - stores your uploaded photos
    const photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      bucketName: `album-share-photo-bucket-${this.account}-${this.region}`,
      removalPolicy: RemovalPolicy.RETAIN, // keeps bucket even if stack is deleted
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // private bucket, accessed via CloudFront
      enforceSSL: true,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedOrigins: [
            'http://localhost:5173', // Your React dev server
            'https://albumsharesdd.netlify.app' // Production Netlify domain
          ],
          exposedHeaders: ['ETag'],
        },
      ],
    });

    // CloudFront signed URLs setup for secure photo access
    // Secret to store the CloudFront private key (user must populate this after generating key pair)
    const cloudfrontPrivateKeySecret = new secretsmanager.Secret(this, 'CloudFrontPrivateKeySecret', {
      secretName: `album-share-cloudfront-private-key-${this.account}`,
      description: 'Private key for CloudFront signed URLs - populate after generating key pair',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ privateKey: '' }),
        generateStringKey: 'placeholder',
        excludeCharacters: '',
      },
    });

    // CloudFront public key (user must provide public key after generating key pair)
    // Key Location
    const cloudfrontPublicKeyValue = fs.readFileSync(
      path.join(__dirname, "..", "..", "cloudfront-public-key.pem"),
      "utf8"
    ).replace(/\r\n/g, "\n").trim();
    
    const cloudfrontPublicKey = new CfnPublicKey(this, 'CloudFrontPublicKey', {
      publicKeyConfig: {
        // Use a stable callerReference that doesn't change on each deployment
        callerReference: `album-share-public-key-${this.account}`,
        name: `album-share-public-key-${this.account}`,
        encodedKey: cloudfrontPublicKeyValue,
        comment: 'Public key for CloudFront signed URLs',
      },
    });

    // CloudFront key group
    const cloudfrontKeyGroup = new CfnKeyGroup(this, 'CloudFrontKeyGroup', {
      keyGroupConfig: {
        name: `album-share-key-group-${this.account}`,
        items: [cloudfrontPublicKey.ref],
        comment: 'Key group for CloudFront signed URLs',
      },
    });



    // DynamoDB table for favorites (userId + photoKey)
    const favoritesTable = new dynamodb.Table(this, 'FavoritesTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'photoKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // DynamoDB table for tags (photoKey + userId + tag)
    const tagsTable = new dynamodb.Table(this, 'TagsTable', {
      partitionKey: { name: 'photoKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userIdTag', type: dynamodb.AttributeType.STRING }, // format: "userId#tagName"
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Lambda function that lists photos and signed URLs (environment set after CloudFront creation)
    const InventoryDescriber = new lambda.Function(this, 'InventoryDescriber', {
      functionName: "Album-Share-Inventory-Describer",
      description: "List the photos contained in the bucket and provides signed URLs",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'inventory-describer.handler',
      code: lambda.Code.fromAsset('lambda'),
      timeout: Duration.seconds(30), // Increase timeout for CloudFront signed URL generation
      environment: {
        BUCKET_NAME: photoBucket.bucketName,
        FAVORITES_TABLE: favoritesTable.tableName,
        CLOUDFRONT_KEY_PAIR_ID: cloudfrontPublicKey.attrId,
        CLOUDFRONT_PRIVATE_KEY_SECRET_NAME: cloudfrontPrivateKeySecret.secretName,
      },
    });

    // Grant Lambda permission to read from S3 bucket and favorites table
    photoBucket.grantRead(InventoryDescriber);
    favoritesTable.grantReadData(InventoryDescriber);
    
    // Grant Lambda permission to read the CloudFront private key from Secrets Manager
    cloudfrontPrivateKeySecret.grantRead(InventoryDescriber);

    // API Gateway
    const api = new apigateway.RestApi(this, "PhotoApiAS", {
      restApiName: "Photo Service",
      description: "API Gateway for Photoshare",
      defaultCorsPreflightOptions: {
        allowOrigins: [
          "http://localhost:5173",
          "https://albumsharesdd.netlify.app"
        ],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "X-Amz-Date",
          "Authorization",
          "X-Api-Key",
          "X-Amz-Security-Token",
          "X-Amz-User-Agent",
          "x-amz-content-sha256",
        ],
      },
    });

    // Add CORS headers to API Gateway *error* responses too (so the browser doesn't mask 401/403/5xx as "CORS")
    api.addGatewayResponse("Default4xx", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'", // Allow all origins for error responses
        "Access-Control-Allow-Headers":
          "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,x-amz-content-sha256'",
        "Access-Control-Allow-Methods": "'GET,POST,DELETE,OPTIONS'",
      },
    });

    api.addGatewayResponse("Default5xx", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: {
        "Access-Control-Allow-Origin": "'*'", // Allow all origins for error responses
        "Access-Control-Allow-Headers":
          "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent,x-amz-content-sha256'",
        "Access-Control-Allow-Methods": "'GET,POST,DELETE,OPTIONS'",
      },
    });
    
    //Create IAM role that will be used to give permissions to the react agent
    const reactAlbumReaderRole = new iam.Role(this, "ReactAlbumReaderRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      description: "Role used by React app (via API Gateway) to read photo data for album share, preventing it from being public",
    });

    //This user will need to read from the bucket
    photoBucket.grantRead(reactAlbumReaderRole);

    //Add the complimentary User that will assume the reading role
    const reactUser = new iam.User(this, "ReactUser", {
      userName: "react-album-user",
    });

    //Allow this user to assume roles necessary
    reactUser.addToPolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [reactAlbumReaderRole.roleArn],
    }))

    // Allow the React user to call the API Gateway GET /photos endpoint
    reactUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: ["arn:aws:execute-api:us-west-2:129045776282:mtkjcuwe3g/*"],
    }));

    //Naturally this user will user the react reader role - trust policy
    reactAlbumReaderRole.assumeRolePolicy?.addStatements(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      principals: [reactUser],
    }));

    // ==========================
    // Cognito User Pool (MVP)
    // ==========================

    const userPool = new cognito.UserPool(this, 'AlbumUserPool', {
      selfSignUpEnabled: false, // Only admins can create users
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'AlbumUserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        // Local dev and production URLs
        callbackUrls: [
          'http://localhost:5173',
          'https://albumsharesdd.netlify.app'
        ],
        logoutUrls: [
          'http://localhost:5173',
          'https://albumsharesdd.netlify.app'
        ],
      },
    });

    const albumUserPoolAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "AlbumUserPoolAuthorizer", {
        cognitoUserPools: [userPool],
    });

    // Lambda function for managing favorites
    const manageFavoritesFunction = new lambda.Function(this, 'ManageFavoritesFunction', {
      functionName: "Album-Share-Manage-Favorites",
      description: "Add or remove photo favorites for users",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'manage-favorites.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        TABLE_NAME: favoritesTable.tableName,
      },
    });

    // Grant Lambda permission to read/write favorites table
    favoritesTable.grantReadWriteData(manageFavoritesFunction);

    // Photos end point - Cognito authentication
    const photos = api.root.addResource('photos');
    photos.addMethod('GET', new apigateway.LambdaIntegration(InventoryDescriber), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Lambda function for managing tags
    const manageTagsFunction = new lambda.Function(this, 'ManageTagsFunction', {
      functionName: "Album-Share-Manage-Tags",
      description: "Add, remove, or list tags for photos",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'manage-tags.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        TABLE_NAME: tagsTable.tableName,
      },
    });

    // Grant Lambda permission to read/write tags table
    tagsTable.grantReadWriteData(manageTagsFunction);

    // Lambda function for generating upload URLs
    const generateUploadUrlFunction = new lambda.Function(this, 'GenerateUploadUrlFunction', {
      functionName: "Album-Share-Generate-Upload-URL",
      description: "Generate presigned URLs for photo uploads",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'generate-upload-url.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        BUCKET_NAME: photoBucket.bucketName,
      },
    });

    // Grant Lambda permission to write to S3 bucket
    photoBucket.grantWrite(generateUploadUrlFunction);

    // Favorites endpoint - POST to add, DELETE to remove
    const favorites = api.root.addResource('favorites');
    favorites.addMethod('POST', new apigateway.LambdaIntegration(manageFavoritesFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    favorites.addMethod('DELETE', new apigateway.LambdaIntegration(manageFavoritesFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Tags endpoint - POST to add, DELETE to remove, GET to list
    const tags = api.root.addResource('tags');
    tags.addMethod('POST', new apigateway.LambdaIntegration(manageTagsFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    tags.addMethod('DELETE', new apigateway.LambdaIntegration(manageTagsFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    tags.addMethod('GET', new apigateway.LambdaIntegration(manageTagsFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Upload endpoint - POST to get presigned upload URL
    const upload = api.root.addResource('upload-url');
    upload.addMethod('POST', new apigateway.LambdaIntegration(generateUploadUrlFunction), {
        authorizer: albumUserPoolAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const userPoolDomain = new cognito.UserPoolDomain(this, 'AlbumUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: `albumshare-${this.account}`, // must be globally unique per region
      },
    });

    // Create a response headers policy for CORS
    const corsResponseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'CorsResponseHeadersPolicy', {
      responseHeadersPolicyName: `album-share-cors-policy-${this.account}`,
      comment: 'CORS policy for album photos',
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: [
          'http://localhost:5173', 
          'https://localhost:5173',
          'https://albumsharesdd.netlify.app'
        ],
        accessControlExposeHeaders: ['*'],
        accessControlMaxAge: Duration.seconds(86400), // 24 hours
        originOverride: true,
      },
    });

    // CloudFront distribution for photo delivery with signed URLs required
    const photoDistribution = new cloudfront.Distribution(this, 'PhotoDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(photoBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, // cache images for 24 hours
        responseHeadersPolicy: corsResponseHeadersPolicy, // Add CORS headers
        trustedKeyGroups: [cloudfront.KeyGroup.fromKeyGroupId(this, 'ImportedKeyGroup', cloudfrontKeyGroup.attrId)],
      },
      comment: 'CDN for album photos with signed URLs and CORS support',
    });

    // Add CloudFront domain to Lambda environment after distribution is created
    InventoryDescriber.addEnvironment('CLOUDFRONT_DOMAIN', photoDistribution.distributionDomainName);



    // ========================================
    // Resource List
    // ========================================
    
    new CfnOutput(this, 'ApiUrl', { 
      value: api.url,
      description: 'API Gateway endpoint for React'
    });
    
    new CfnOutput(this, 'PhotoBucketName', { 
      value: photoBucket.bucketName,
      description: 'S3 bucket name'
    });

    new CfnOutput(this, 'FavoritesTableName', {
      value: favoritesTable.tableName,
      description: 'DynamoDB table for favorites'
    });

    new CfnOutput(this, 'TagsTableName', {
      value: tagsTable.tableName,
      description: 'DynamoDB table for tags'
    });

    new CfnOutput(this, 'CloudFrontDomain', {
      value: photoDistribution.distributionDomainName,
      description: 'CloudFront domain for photo delivery'
    });



    new CfnOutput(this, 'CloudFrontPublicKeyId', {
      value: cloudfrontPublicKey.attrId,
      description: 'CloudFront public key ID - use this when generating key pairs'
    });

    new CfnOutput(this, 'CloudFrontPrivateKeySecretName', {
      value: cloudfrontPrivateKeySecret.secretName,
      description: 'Secrets Manager secret name - populate this with your CloudFront private key after generating key pair'
    });

    new CfnOutput(this, "ReactAlbumUserName", {
      value: reactUser.userName,
      description: "IAM user name for React app access",
    });

    // Outputs so you can copy these into React later
    new CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool client ID for the web app',
    });

    new CfnOutput(this, 'CognitoLoginUrlDev', {
      value: userPoolDomain.baseUrl() +
        '/login?client_id=' +
        userPoolClient.userPoolClientId +
        '&response_type=code&scope=email+openid+profile&redirect_uri=http://localhost:5173',
      description: 'Hosted UI login URL for local development',
    });

    new CfnOutput(this, 'CognitoLoginUrlProd', {
      value: userPoolDomain.baseUrl() +
        '/login?client_id=' +
        userPoolClient.userPoolClientId +
        '&response_type=code&scope=email+openid+profile&redirect_uri=https://albumsharesdd.netlify.app',
      description: 'Hosted UI login URL for production (Netlify)',
    });

  }
}
