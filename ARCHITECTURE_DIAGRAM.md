# ShareAlbum System Architecture

## High-Level Architecture Diagram

```mermaid
graph TB
    %% Frontend
    FE[React Frontend<br/>localhost:5173] 
    
    %% Authentication
    COGNITO[AWS Cognito<br/>User Pool]
    
    %% API Layer
    APIGW[API Gateway<br/>mtkjcuwe3g.execute-api.us-west-2.amazonaws.com]
    
    %% Lambda Functions
    LAMBDA1[Lambda: Inventory Describer<br/>Lists photos + generates signed URLs]
    LAMBDA2[Lambda: Manage Favorites<br/>Add/remove favorites]
    LAMBDA3[Lambda: Manage Tags<br/>Add/remove/list tags]
    LAMBDA4[Lambda: Generate Upload URL<br/>Presigned S3 upload URLs]
    
    %% Storage
    S3[S3 Bucket<br/>album-share-photo-bucket<br/>Private - No public access]
    DDB1[DynamoDB: Favorites<br/>userId + photoKey]
    DDB2[DynamoDB: Tags<br/>photoKey + userIdTag]
    
    %% CloudFront
    CF[CloudFront Distribution<br/>d1jdah4uujf7m0.cloudfront.net<br/>+ CORS Headers<br/>+ Signed URLs Required]
    
    %% Secrets
    SECRETS[AWS Secrets Manager<br/>CloudFront Private Key]
    
    %% Key Management
    CFKEY[CloudFront Public Key<br/>K1Z1RZVGH84X8O]
    KEYGROUP[CloudFront Key Group<br/>Trusted Key Groups]
    
    %% User Flow
    FE -->|1. Login| COGNITO
    COGNITO -->|2. JWT Token| FE
    FE -->|3. API Calls<br/>Authorization: Bearer token| APIGW
    
    %% API Gateway Routes
    APIGW -->|GET /photos| LAMBDA1
    APIGW -->|POST/DELETE /favorites| LAMBDA2
    APIGW -->|GET/POST/DELETE /tags| LAMBDA3
    APIGW -->|POST /upload-url| LAMBDA4
    
    %% Lambda Operations
    LAMBDA1 -->|List objects| S3
    LAMBDA1 -->|Query favorites| DDB1
    LAMBDA1 -->|Get private key| SECRETS
    LAMBDA1 -->|Generate signed URLs| CF
    
    LAMBDA2 -->|Read/Write| DDB1
    LAMBDA3 -->|Read/Write| DDB2
    LAMBDA4 -->|Generate presigned URLs| S3
    
    %% Photo Delivery
    FE -->|4. Load images<br/>Signed URLs with CORS| CF
    CF -->|Cached/Fetch| S3
    
    %% CloudFront Security
    CF -.->|Validates signature| CFKEY
    CFKEY -.->|Part of| KEYGROUP
    KEYGROUP -.->|Trusted by| CF
    
    %% Styling
    classDef frontend fill:#e1f5fe
    classDef aws fill:#ff9800
    classDef lambda fill:#4caf50
    classDef storage fill:#2196f3
    classDef security fill:#f44336
    
    class FE frontend
    class COGNITO,APIGW,CF aws
    class LAMBDA1,LAMBDA2,LAMBDA3,LAMBDA4 lambda
    class S3,DDB1,DDB2 storage
    class SECRETS,CFKEY,KEYGROUP security
```

## Data Flow Diagrams

### 1. User Authentication Flow
```mermaid
sequenceDiagram
    participant U as User
    participant FE as React Frontend
    participant C as Cognito
    
    U->>FE: Access app
    FE->>C: Redirect to login
    C->>U: Show login form
    U->>C: Enter credentials
    C->>FE: Return JWT token
    FE->>FE: Store token
    Note over FE: Ready for API calls
```

### 2. Photo Loading Flow
```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as API Gateway
    participant L as Lambda
    participant S3 as S3 Bucket
    participant SM as Secrets Manager
    participant CF as CloudFront
    
    FE->>API: GET /photos (with JWT)
    API->>L: Invoke Inventory Describer
    L->>S3: List objects
    L->>SM: Get CloudFront private key
    L->>L: Generate signed URLs
    L->>API: Return photo list with signed URLs
    API->>FE: Photo metadata + signed URLs
    
    loop For each photo
        FE->>CF: Request image (signed URL)
        CF->>CF: Validate signature
        CF->>S3: Fetch image (if not cached)
        S3->>CF: Return image
        CF->>FE: Serve image with CORS headers
    end
```

### 3. Photo Upload Flow
```mermaid
sequenceDiagram
    participant FE as Frontend
    participant API as API Gateway
    participant L as Lambda
    participant S3 as S3 Bucket
    
    FE->>API: POST /upload-url (with JWT)
    API->>L: Invoke Generate Upload URL
    L->>S3: Generate presigned upload URL
    L->>API: Return presigned URL
    API->>FE: Presigned upload URL
    FE->>S3: Upload file directly to S3
    S3->>FE: Upload confirmation
```

## Component Details

### AWS Resources Created

| Component | Resource Name | Purpose |
|-----------|---------------|---------|
| **S3 Bucket** | `album-share-photo-bucket-129045776282-us-west-2` | Private photo storage |
| **CloudFront** | `d1jdah4uujf7m0.cloudfront.net` | CDN with signed URLs + CORS |
| **API Gateway** | `mtkjcuwe3g.execute-api.us-west-2.amazonaws.com` | REST API endpoints |
| **Cognito User Pool** | `us-west-2_wWKJ8mrfJ` | User authentication |
| **DynamoDB Tables** | `FavoritesTable`, `TagsTable` | User data storage |
| **Lambda Functions** | 4 functions for different operations | Business logic |
| **Secrets Manager** | CloudFront private key storage | Secure key management |

### Security Model

```mermaid
graph LR
    subgraph "Authentication Layer"
        JWT[JWT Tokens]
        COGNITO[Cognito User Pool]
    end
    
    subgraph "Authorization Layer"
        APIGW[API Gateway<br/>Cognito Authorizer]
        IAM[IAM Roles & Policies]
    end
    
    subgraph "Data Protection"
        S3PRIVATE[S3 Private Bucket]
        CFSIGNED[CloudFront Signed URLs]
        ENCRYPTION[Encryption at Rest]
    end
    
    JWT --> APIGW
    COGNITO --> JWT
    APIGW --> IAM
    IAM --> S3PRIVATE
    S3PRIVATE --> CFSIGNED
    CFSIGNED --> ENCRYPTION
```

### Cost Optimization Features

1. **CloudFront Caching**: 24-hour cache reduces S3 requests
2. **DynamoDB On-Demand**: Pay per request, no provisioned capacity
3. **Lambda**: Pay per execution, automatic scaling
4. **S3 Intelligent Tiering**: Automatic cost optimization for storage

### Performance Features

1. **CloudFront Edge Locations**: Global CDN for fast image delivery
2. **Lambda Caching**: Private key cached in memory
3. **Signed URL Expiration**: 1-hour expiration reduces key retrieval
4. **Optimized Cache Policies**: Separate policies for API vs images

## Network Architecture

```mermaid
graph TB
    subgraph "Internet"
        USER[Users]
    end
    
    subgraph "AWS Region: us-west-2"
        subgraph "Public Subnets"
            APIGW[API Gateway]
            CF[CloudFront]
        end
        
        subgraph "Private Resources"
            LAMBDA[Lambda Functions]
            S3[S3 Bucket]
            DDB[DynamoDB]
            SECRETS[Secrets Manager]
        end
        
        subgraph "Global"
            COGNITO[Cognito]
            CFEDGE[CloudFront Edge Locations]
        end
    end
    
    USER --> CFEDGE
    USER --> APIGW
    CFEDGE --> CF
    CF --> S3
    APIGW --> LAMBDA
    LAMBDA --> S3
    LAMBDA --> DDB
    LAMBDA --> SECRETS
```

## Monitoring & Observability

- **CloudWatch Logs**: Lambda function logs
- **CloudWatch Metrics**: API Gateway, Lambda, CloudFront metrics
- **X-Ray Tracing**: Distributed tracing (can be enabled)
- **CloudFront Analytics**: Cache hit rates, geographic distribution

---

*This diagram represents the current state of your ShareAlbum system as deployed.*