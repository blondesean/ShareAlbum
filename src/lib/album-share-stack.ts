import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

export class AlbumShareStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Photo storage bucket
    const photoBucket = new s3.Bucket(this, 'PhotoBucket', {
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });



    // Frontend hosting bucket
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      websiteIndexDocument: 'index.html',
      publicReadAccess: false,
    });

    // CloudFront for frontend
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      }
    });

    // Create the User Pool
    const userPool = new cognito.UserPool(this, 'AlbumUserPool', {
      selfSignUpEnabled: true,
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

    // Create the User Pool Client
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
        callbackUrls: [
          'http://localhost:3000', // front-end dev
        ],
        logoutUrls: [
          'http://localhost:3000',
        ],
      },
    });

    // DynamoDB table for photo metadata
    const photoTable = new dynamodb.Table(this, 'PhotoTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const domain = new cognito.UserPoolDomain(this, 'AlbumUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'albumshare-' + this.account, // must be globally unique
      },
    });

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

    const photos = api.root.addResource('photos');
    photos.addMethod('GET', new apigateway.LambdaIntegration(listPhotosFunction));

    // Outputs for frontend use
    new CfnOutput(this, 'WebUrl', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'PhotoBucketName', { value: photoBucket.bucketName });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'PhotoTableName', { value: photoTable.tableName });
    new CfnOutput(this, 'CognitoLoginUrl', {
      value: domain.baseUrl() + '/login?client_id=' + userPoolClient.userPoolClientId +
        '&response_type=code&scope=email+openid+profile&redirect_uri=http://localhost:3000',
    });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
