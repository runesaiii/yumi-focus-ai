# Azure Phase 2 Setup Automation Script
# This script creates Cosmos DB and Azure AI Search resources for Yumi Focus AI
# Prerequisites: Azure CLI installed and logged in (az login), PowerShell 7+

param(
    [string]$ResourceGroup = "yumi-rg",
    [string]$Location = "eastus",
    [string]$CosmosAccountName = "yumi-cosmos-$([DateTimeOffset]::Now.ToUnixTimeSeconds())",
    [string]$SearchServiceName = "yumi-search-$([DateTimeOffset]::Now.ToUnixTimeSeconds())",
    [string]$CosmosDbName = "yumi",
    [string]$ContainerName = "sessions",
    [string]$PartitionKey = "userId",
    [string]$SearchIndexName = "tasks-index"
)

# Color output helper
function Write-Info { Write-Host $args -ForegroundColor Cyan }
function Write-Success { Write-Host $args -ForegroundColor Green }
function Write-Warning { Write-Host $args -ForegroundColor Yellow }
function Write-Error { Write-Host $args -ForegroundColor Red }

Write-Info "🚀 Yumi Focus AI - Phase 2 Azure Setup Automation`n"

# Check prerequisites
Write-Info "📋 Checking prerequisites..."
$azVersion = az --version 2>$null | Select-Object -First 1
if (-not $azVersion) {
    Write-Error "❌ Azure CLI not found. Please install: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli"
    exit 1
}
Write-Success "✅ Azure CLI found`n"

# Check if logged in
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Info "Logging in to Azure..."
    az login
    $account = az account show | ConvertFrom-Json
}
Write-Success "✅ Logged in as: $($account.user.name)`n"

# Create resource group if it doesn't exist
Write-Info "📁 Setting up Resource Group: $ResourceGroup"
$rgCheck = az group exists --resource-group $ResourceGroup | ConvertFrom-Json
if (-not $rgCheck) {
    Write-Info "Creating Resource Group..."
    az group create --name $ResourceGroup --location $Location | Out-Null
}
Write-Success "✅ Resource Group ready`n"

# === COSMOS DB SETUP ===
Write-Info "🗄️  Setting up Cosmos DB..."
Write-Info "Creating Cosmos DB account (this takes 2-3 minutes)..."

$cosmosCmd = @(
    "az cosmosdb create",
    "--resource-group $ResourceGroup",
    "--name $CosmosAccountName",
    "--locations regionName=$Location failoverPriority=0",
    "--default-consistency-level Session",
    "--enable-public-network true"
)

try {
    Invoke-Expression ($cosmosCmd -join " ") | Out-Null
    Write-Success "✅ Cosmos DB account created: $CosmosAccountName"
} catch {
    Write-Error "❌ Failed to create Cosmos DB: $_"
    exit 1
}

# Get Cosmos DB endpoint
Write-Info "Retrieving Cosmos DB endpoint..."
$cosmosAccount = az cosmosdb show --resource-group $ResourceGroup --name $CosmosAccountName | ConvertFrom-Json
$cosmosEndpoint = $cosmosAccount.documentEndpoint
Write-Success "✅ Endpoint: $cosmosEndpoint"

# Get Cosmos DB keys
Write-Info "Retrieving Cosmos DB keys..."
$cosmosKeys = az cosmosdb keys list --resource-group $ResourceGroup --name $CosmosAccountName | ConvertFrom-Json
$cosmosKey = $cosmosKeys.primaryMasterKey
$cosmosConnectionString = "AccountEndpoint=$cosmosEndpoint;AccountKey=$cosmosKey;"
Write-Success "✅ Keys retrieved`n"

# Create database
Write-Info "Creating Cosmos DB database: $CosmosDbName"
$dbCmd = @(
    "az cosmosdb sql database create",
    "--resource-group $ResourceGroup",
    "--account-name $CosmosAccountName",
    "--name $CosmosDbName",
    "--throughput 400"
)
try {
    Invoke-Expression ($dbCmd -join " ") | Out-Null
    Write-Success "✅ Database created: $CosmosDbName"
} catch {
    Write-Error "❌ Failed to create database: $_"
    exit 1
}

# Create container
Write-Info "Creating Cosmos DB container: $ContainerName (partition key: /$PartitionKey)"
$containerCmd = @(
    "az cosmosdb sql container create",
    "--resource-group $ResourceGroup",
    "--account-name $CosmosAccountName",
    "--database-name $CosmosDbName",
    "--name $ContainerName",
    "--partition-key-path /$PartitionKey",
    "--throughput 400"
)
try {
    Invoke-Expression ($containerCmd -join " ") | Out-Null
    Write-Success "✅ Container created: $ContainerName`n"
} catch {
    Write-Error "❌ Failed to create container: $_"
    exit 1
}

# === AZURE AI SEARCH SETUP ===
Write-Info "🔍 Setting up Azure AI Search..."
Write-Info "Creating search service (this takes 1-2 minutes)..."

$searchCmd = @(
    "az search service create",
    "--resource-group $ResourceGroup",
    "--name $SearchServiceName",
    "--sku free",
    "--replica-count 1",
    "--partition-count 1"
)

try {
    Invoke-Expression ($searchCmd -join " ") | Out-Null
    Write-Success "✅ Search service created: $SearchServiceName"
} catch {
    # Try standard tier if free tier fails
    Write-Warning "Free tier unavailable, trying Standard tier..."
    $searchCmd = $searchCmd -replace "sku free", "sku standard"
    try {
        Invoke-Expression ($searchCmd -join " ") | Out-Null
        Write-Success "✅ Search service created (Standard tier): $SearchServiceName"
    } catch {
        Write-Error "❌ Failed to create search service: $_"
        exit 1
    }
}

# Get Search service details
Write-Info "Retrieving search service details..."
$searchService = az search service show --resource-group $ResourceGroup --name $SearchServiceName | ConvertFrom-Json
$searchEndpoint = "https://$($searchService.name).search.windows.net"
Write-Success "✅ Endpoint: $searchEndpoint"

# Get Search admin key
Write-Info "Retrieving search admin key..."
$searchKeys = az search admin-key show --resource-group $ResourceGroup --service-name $SearchServiceName | ConvertFrom-Json
$searchAdminKey = $searchKeys.primaryKey
Write-Success "✅ Admin key retrieved`n"

# Create search index using REST API
Write-Info "Creating search index: $SearchIndexName"
$indexPayload = @{
    name = $SearchIndexName
    fields = @(
        @{ name = "id"; type = "Edm.String"; key = $true; retrievable = $true; searchable = $true }
        @{ name = "userId"; type = "Edm.String"; retrievable = $true; searchable = $true; filterable = $true }
        @{ name = "task"; type = "Edm.String"; retrievable = $true; searchable = $true }
        @{ name = "label"; type = "Edm.String"; retrievable = $true; searchable = $true }
        @{ name = "timestamp"; type = "Edm.DateTimeOffset"; retrievable = $true; filterable = $true }
        @{ name = "ts"; type = "Edm.DateTimeOffset"; retrievable = $true; filterable = $true }
        @{ name = "url"; type = "Edm.String"; retrievable = $true }
    )
} | ConvertTo-Json -Depth 10

$headers = @{
    "api-key" = $searchAdminKey
    "Content-Type" = "application/json"
}

try {
    $response = Invoke-RestMethod `
        -Uri "$searchEndpoint/indexes?api-version=2024-07-01" `
        -Method Post `
        -Headers $headers `
        -Body $indexPayload
    Write-Success "✅ Search index created: $SearchIndexName`n"
} catch {
    if ($_.Exception.Response.StatusCode -eq 409) {
        Write-Success "✅ Search index already exists: $SearchIndexName`n"
    } else {
        Write-Warning "⚠️  Index creation warning: $_"
    }
}

# === SUMMARY & OUTPUT ===
Write-Info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"
Write-Success "✅ Phase 2 Azure Resources Created Successfully!`n"

Write-Info "📌 COSMOS DB CONFIGURATION`n"
Write-Host "Resource Group: $ResourceGroup"
Write-Host "Account Name: $CosmosAccountName"
Write-Host "Database: $CosmosDbName"
Write-Host "Container: $ContainerName"
Write-Host "Partition Key: /$PartitionKey"
Write-Host ""

Write-Info "🔑 Add these to your App Service Configuration:`n"
Write-Host "COSMOS_DB_CONNECTION_STRING="
Write-Host "$cosmosConnectionString" -ForegroundColor Yellow
Write-Host ""
Write-Host "COSMOS_DB_DATABASE=$CosmosDbName"
Write-Host "COSMOS_DB_CONTAINER=$ContainerName"
Write-Host ""

Write-Info "🔍 AZURE AI SEARCH CONFIGURATION`n"
Write-Host "Service Name: $SearchServiceName"
Write-Host "Location: $Location"
Write-Host ""

Write-Info "🔑 Add these to your App Service Configuration:`n"
Write-Host "AI_SEARCH_ENDPOINT="
Write-Host "$searchEndpoint" -ForegroundColor Yellow
Write-Host ""
Write-Host "AI_SEARCH_ADMIN_KEY="
Write-Host "$searchAdminKey" -ForegroundColor Yellow
Write-Host ""

Write-Info "📋 NEXT STEPS`n"
Write-Host @"
1. Copy the connection strings and keys above

2. Add them to your App Service Configuration:
   - Go to Azure Portal > App Service > Configuration
   - Click "New application setting" for each:
     * COSMOS_DB_CONNECTION_STRING
     * COSMOS_DB_DATABASE
     * AI_SEARCH_ENDPOINT
     * AI_SEARCH_ADMIN_KEY

3. Redeploy your backend:
   git add .
   git commit -m "Add Phase 2 Cosmos DB and AI Search integration"
   git push origin main

4. Test the endpoints:
   - POST https://your-app.azurewebsites.net/sessions
   - GET https://your-app.azurewebsites.net/sessions/{sessionId}
   - POST https://your-app.azurewebsites.net/search

🎉 Your Yumi Focus AI is now ready for Phase 2!
"@

Write-Host ""
Write-Info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n"

# Save config to file
$configPath = Join-Path $PSScriptRoot "azure-phase2-config.json"
$config = @{
    cosmosAccountName = $CosmosAccountName
    cosmosEndpoint = $cosmosEndpoint
    cosmosConnectionString = $cosmosConnectionString
    cosmosDatabase = $CosmosDbName
    cosmosContainer = $ContainerName
    searchServiceName = $SearchServiceName
    searchEndpoint = $searchEndpoint
    searchAdminKey = $searchAdminKey
    resourceGroup = $ResourceGroup
    location = $Location
    createdAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
} | ConvertTo-Json

Set-Content -Path $configPath -Value $config
Write-Success "✅ Configuration saved to: azure-phase2-config.json`n"

Write-Success "Setup complete! 🎉`n"
