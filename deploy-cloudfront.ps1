# CloudFront Deployment Script
# This script helps deploy with the CloudFront public key

Write-Host "CloudFront Deployment Helper" -ForegroundColor Cyan
Write-Host "============================" -ForegroundColor Cyan
Write-Host ""

# Check if key file exists
$keyPath = "G:\Programming\ShareAlbum\ShareAlbum\cloudfront-public-key.pem"
if (-not (Test-Path $keyPath)) {
    Write-Host "ERROR: Public key file not found at: $keyPath" -ForegroundColor Red
    Write-Host "Please ensure you've generated the key pair first." -ForegroundColor Yellow
    exit 1
}

# Read the public key
Write-Host "Reading public key from: $keyPath" -ForegroundColor Green
$publicKey = Get-Content $keyPath -Raw

# Validate key format
if ($publicKey -notmatch "BEGIN PUBLIC KEY") {
    Write-Host "WARNING: Key format might be incorrect. Expected '-----BEGIN PUBLIC KEY-----'" -ForegroundColor Yellow
}

# Navigate to src directory
$srcDir = "G:\Programming\ShareAlbum\ShareAlbum\src"
if (-not (Test-Path $srcDir)) {
    Write-Host "ERROR: Source directory not found: $srcDir" -ForegroundColor Red
    exit 1
}

Set-Location $srcDir
Write-Host "Changed to directory: $srcDir" -ForegroundColor Green
Write-Host ""

# Deploy with the public key
Write-Host "Deploying CDK stack with CloudFront public key..." -ForegroundColor Cyan
Write-Host ""

try {
    cdk deploy -c cloudfrontPublicKey="$publicKey"
    Write-Host ""
    Write-Host "Deployment completed successfully!" -ForegroundColor Green
} catch {
    Write-Host ""
    Write-Host "Deployment failed. Error details:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "1. Public key format is incorrect"
    Write-Host "2. CloudFront service limits (too many public keys)"
    Write-Host "3. IAM permissions missing"
    Write-Host "4. Stack already exists with conflicting resources"
    exit 1
}


