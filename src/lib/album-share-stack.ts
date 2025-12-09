import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AuthorizationType } from "aws-cdk-lib/aws-apigateway";
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from "aws-cdk-lib/aws-iam";
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class AlbumShareStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {7
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
    });

    // CloudFront distribution for photo delivery
    const photoDistribution = new cloudfront.Distribution(this, 'PhotoDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(photoBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, // cache images for 24 hours
      },
      comment: 'CDN for album photos',
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

    // Lambda function that lists photos and signed URLs
    const InventoryDescriber = new lambda.Function(this, 'InventoryDescriber', {
      functionName: "Album-Share-Inventory-Describer",
      description: "List the photos contained in the bucket and provides signed URLs",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'inventory-describer.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        BUCKET_NAME: photoBucket.bucketName,
        FAVORITES_TABLE: favoritesTable.tableName,
        CLOUDFRONT_DOMAIN: photoDistribution.distributionDomainName,
      },
    });

    // Grant Lambda permission to read from S3 bucket and favorites table
    photoBucket.grantRead(InventoryDescriber);
    favoritesTable.grantReadData(InventoryDescriber);

    // API Gateway
    const api = new apigateway.RestApi(this, 'PhotoApiAS', {
      restApiName: 'Photo Service',
      description: 'API Gateway for Photoshare',
      defaultCorsPreflightOptions: {
        allowOrigins: ["http://localhost:5173"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "X-Amz-Date",
          "Authorization",
          "X-Api-Key",
          "X-Amz-Security-Token",
          "X-Amz-User-Agent",
          "x-amz-content-sha256"
        ],
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
        // For now we assume local dev React on 5173
        callbackUrls: ['http://localhost:5173'],
        logoutUrls: ['http://localhost:5173'],
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

    const userPoolDomain = new cognito.UserPoolDomain(this, 'AlbumUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: `albumshare-${this.account}`, // must be globally unique per region
      },
    });

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

    new CfnOutput(this, 'CognitoLoginUrl', {
      value: userPoolDomain.baseUrl() +
        '/login?client_id=' +
        userPoolClient.userPoolClientId +
        '&response_type=code&scope=email+openid+profile&redirect_uri=http://localhost:5173',
      description: 'Hosted UI login URL for local dev',
    });

  }
}
