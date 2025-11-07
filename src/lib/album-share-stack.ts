import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
// import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
// import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
// import * as cognito from 'aws-cdk-lib/aws-cognito';
// import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export class AlbumShareStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ========================================
    // CORE INFRASTRUCTURE (Currently Active)
    // ========================================

    // Photo storage bucket - stores your uploaded photos
    const photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      removalPolicy: RemovalPolicy.RETAIN, // keeps bucket even if stack is deleted
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // private bucket
      enforceSSL: true,
    });

    // ========================================
    // FUTURE FEATURES (Commented Out)
    // ========================================

    // // Frontend hosting bucket - for deploying React app to AWS
    // const webBucket = new s3.Bucket(this, 'WebBucket', {
    //   removalPolicy: RemovalPolicy.DESTROY,
    //   autoDeleteObjects: true,
    //   websiteIndexDocument: 'index.html',
    //   publicReadAccess: false,
    // });

    // // CloudFront - CDN for hosting React app on AWS
    // const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
    //   defaultBehavior: {
    //     origin: new origins.S3Origin(webBucket),
    //     viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
    //   }
    // });

    // // Cognito User Pool - for user authentication (login/signup)
    // const userPool = new cognito.UserPool(this, 'AlbumUserPool', {
    //   selfSignUpEnabled: true,
    //   signInAliases: { email: true },
    //   autoVerify: { email: true },
    //   passwordPolicy: {
    //     minLength: 8,
    //     requireLowercase: true,
    //     requireUppercase: false,
    //     requireDigits: true,
    //     requireSymbols: false,
    //   },
    // });

    // // Cognito User Pool Client - connects your React app to Cognito
    // const userPoolClient = new cognito.UserPoolClient(this, 'AlbumUserPoolClient', {
    //   userPool,
    //   generateSecret: false,
    //   authFlows: {
    //     userPassword: true,
    //     userSrp: true,
    //   },
    //   oAuth: {
    //     flows: {
    //       authorizationCodeGrant: true,
    //     },
    //     scopes: [
    //       cognito.OAuthScope.OPENID,
    //       cognito.OAuthScope.EMAIL,
    //       cognito.OAuthScope.PROFILE,
    //     ],
    //     callbackUrls: [
    //       'http://localhost:3000',
    //     ],
    //     logoutUrls: [
    //       'http://localhost:3000',
    //     ],
    //   },
    // });

    // // DynamoDB - for storing photo metadata (tags, descriptions, etc.)
    // const photoTable = new dynamodb.Table(this, 'PhotoTable', {
    //   partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    //   sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    //   billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    // });

    // // Cognito Domain - for hosted login UI
    // const domain = new cognito.UserPoolDomain(this, 'AlbumUserPoolDomain', {
    //   userPool,
    //   cognitoDomain: {
    //     domainPrefix: 'albumshare-' + this.account,
    //   },
    // });

    // Lambda function for listing photos
    const listPhotosFunction = new lambda.Function(this, 'ListPhotosFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'list-photos.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        BUCKET_NAME: photoBucket.bucketName,
      },
    });

    // Grant Lambda permission to read from S3 bucket
    photoBucket.grantRead(listPhotosFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, 'PhotoApi', {
      restApiName: 'Photo Service',
      description: 'API for photo album sharing',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Public endpoint - no authentication required
    const photos = api.root.addResource('photos');
    photos.addMethod('GET', new apigateway.LambdaIntegration(listPhotosFunction));

    // // Secure endpoint - requires authentication (for later)
    // const photosResource = api.root.addResource("photos-secure");
    // photosResource.addMethod(
    //   "GET",
    //   new apigateway.LambdaIntegration(listPhotosFunction),
    //   {
    //     authorizationType: apigateway.AuthorizationType.IAM,
    //   }
    // );

    // ========================================
    // OUTPUTS - Values you need in your React app
    // ========================================
    
    new CfnOutput(this, 'ApiUrl', { 
      value: api.url,
      description: 'API Gateway endpoint - use this in your React app'
    });
    
    new CfnOutput(this, 'PhotoBucketName', { 
      value: photoBucket.bucketName,
      description: 'S3 bucket name - upload photos here'
    });

    // // Future outputs (commented out for now)
    // new CfnOutput(this, 'WebUrl', { value: distribution.distributionDomainName });
    // new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    // new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    // new CfnOutput(this, 'PhotoTableName', { value: photoTable.tableName });
    // new CfnOutput(this, 'CognitoLoginUrl', {
    //   value: domain.baseUrl() + '/login?client_id=' + userPoolClient.userPoolClientId +
    //     '&response_type=code&scope=email+openid+profile&redirect_uri=http://localhost:3000',
    // });
  }
}
