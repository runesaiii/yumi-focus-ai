# Phase 2 Setup Guide: Cosmos DB & Azure AI Search

This guide walks through setting up Cosmos DB for session persistence and Azure AI Search for historical task retrieval.

## 1. Cosmos DB Setup

### 1.1 Create Cosmos DB Account

1. Go to [Azure Portal](https://portal.azure.com)
2. Click **Create a resource** → Search for **Azure Cosmos DB**
3. Click **Create**
4. Fill in:
   - **Subscription**: Select your subscription
   - **Resource Group**: Use the same group as your App Service (e.g., `yumi-rg`)
   - **Account Name**: `yumi-cosmos` (must be globally unique)
   - **API**: Select **Core (SQL)**
   - **Location**: Same as your App Service region (e.g., `East US`)
   - **Capacity mode**: Select **Provisioned throughput** (start with 400 RU/s for testing)
5. Click **Review + Create** → **Create**
6. Wait for deployment to complete (2-3 minutes)

### 1.2 Create Database and Container

1. Once deployed, go to the Cosmos DB account
2. Click **Data Explorer** in the left menu
3. Click **New Container**
4. Fill in:
   - **Database id**: `yumi` (or click "Create new")
   - **Container id**: `sessions`
   - **Partition key**: `/userId`
   - **Throughput**: 400 RU/s (minimum for provisioned)
5. Click **OK**

### 1.3 Get Connection String

1. Click **Keys** in the left menu
2. Copy the **Primary Connection String** (looks like `AccountEndpoint=https://...;AccountKey=...`)
3. In your App Service Configuration:
   - Click **Configuration** → **New application setting**
   - Name: `COSMOS_DB_CONNECTION_STRING`
   - Value: Paste the connection string
4. Click **Save**

### 1.4 Redeploy Backend

After updating the configuration:
```bash
# In your repo root or backend folder
git add .
git commit -m "Add Cosmos DB connection string"
git push origin main
```

The GitHub Actions workflow will automatically redeploy the backend with the new environment variable.

---

## 2. Azure AI Search Setup

### 2.1 Create Azure AI Search Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Click **Create a resource** → Search for **Azure AI Search**
3. Click **Create**
4. Fill in:
   - **Subscription**: Select your subscription
   - **Resource Group**: Use the same group as your App Service
   - **Service name**: `yumi-search` (must be globally unique)
   - **Location**: Same as your App Service
   - **Pricing tier**: **Standard** (or **Free** for testing if eligible)
5. Click **Review + Create** → **Create**
6. Wait for deployment (1-2 minutes)

### 2.2 Create Search Index

1. Once deployed, go to the Search Service
2. Click **Indexes** in the left menu
3. Click **Create index**
4. Name the index: `tasks-index`
5. Add fields:
   - `id` — **Edm.String**, Retrievable ✓, Searchable ✓, **Key** ✓
   - `userId` — **Edm.String**, Retrievable ✓, Searchable ✓, Filterable ✓
   - `task` — **Edm.String**, Retrievable ✓, Searchable ✓
   - `timestamp` — **Edm.DateTimeOffset**, Retrievable ✓, Filterable ✓
   - `url` — **Edm.String**, Retrievable ✓
6. Click **Create**

### 2.3 Get Search Credentials

1. Click **Keys** in the left menu
2. Copy the **Primary admin key**
3. Note the **Search service URI** (looks like `https://yumi-search.search.windows.net`)

### 2.4 Update App Service Configuration

1. In your App Service, click **Configuration**
2. Add two new application settings:
   - Name: `AI_SEARCH_ENDPOINT`
     Value: `https://yumi-search.search.windows.net`
   - Name: `AI_SEARCH_ADMIN_KEY`
     Value: (Paste the primary admin key)
3. Click **Save**

### 2.5 Create Indexer (Optional: Auto-sync from Cosmos DB)

To automatically index new sessions from Cosmos DB:

1. Go back to the Search Service
2. Click **Indexers** in the left menu
3. Click **Create indexer**
4. Fill in:
   - **Name**: `cosmos-sessions-indexer`
   - **Data source**: Create new → Select **Azure Cosmos DB**
     - Connection string: (Paste your Cosmos DB connection string)
     - Database: `yumi`
     - Collection: `sessions`
   - **Target index**: `tasks-index`
   - **Field mappings**:
     - `id` → `id`
     - `userId` → `userId`
     - `sessionData/task` → `task`
     - `ts` → `timestamp`
     - `sessionData/url` → `url`
5. Click **Create**

---

## 3. Backend Integration

### 3.1 Update function.js (TODO Items)

The backend code is already prepared with TODO comments. When you're ready:

**For Cosmos DB:**
```javascript
// Replace these lines in POST /sessions and GET /sessions/:sessionId
const { CosmosClient } = require("@azure/cosmos");
const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_DB_ENDPOINT,
  key: process.env.COSMOS_DB_KEY
});
const container = cosmosClient.database("yumi").container("sessions");
```

**For Azure AI Search:**
```javascript
// Replace these lines in POST /search
const { SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const credential = new AzureKeyCredential(process.env.AI_SEARCH_ADMIN_KEY);
const searchClient = new SearchClient(
  process.env.AI_SEARCH_ENDPOINT,
  "tasks-index",
  credential
);
```

### 3.2 Install Required Packages

```bash
cd backend
npm install @azure/cosmos @azure/search-documents
npm install
```

### 3.3 Update function.js

Replace the TODO blocks in:
- `POST /sessions` (line ~20)
- `GET /sessions/:sessionId` (line ~40)
- `POST /search` (line ~60)

Then redeploy:
```bash
git add .
git commit -m "Integrate Cosmos DB and Azure AI Search"
git push origin main
```

---

## 4. Testing the Integration

### 4.1 Test Session Persistence

```bash
# Store a session
curl -X POST https://yumi-focus-ai.azurewebsites.net/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "sessionId": "session-001",
    "sessionData": {
      "task": "Write documentation",
      "focusMinutes": 25,
      "distractionsSaved": ["Twitter", "Slack"]
    }
  }'

# Retrieve the session
curl https://yumi-focus-ai.azurewebsites.net/sessions/session-001
```

### 4.2 Test Search

```bash
# Search for tasks
curl -X POST https://yumi-focus-ai.azurewebsites.net/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "documentation",
    "userId": "test-user"
  }'
```

---

## 5. Multi-Model Comparison (Phase 2, Part 3)

The backend already includes `getModelForRequest(isHighPriority)` function:
- **High priority**: Uses `gpt-4` (more accurate, slower, more expensive)
- **Standard**: Uses `gpt-3.5-turbo` (faster, cheaper)

To enable this:

1. Update the `/check` endpoint to accept an `isHighPriority` parameter
2. Pass it to `getModelForRequest()` to select the model
3. Log the model choice in the response for analytics

---

## 6. Troubleshooting

### Issue: "Connection string not valid"
- **Fix**: Double-check you copied the entire connection string from the Keys section
- **Verify**: Connection string should contain both `AccountEndpoint` and `AccountKey`

### Issue: Search endpoint returns 404
- **Fix**: Verify the index name is exactly `tasks-index`
- **Verify**: Admin key has permission (should be a primary admin key, not query key)

### Issue: Indexer not syncing from Cosmos DB
- **Fix**: Check that the data source connection string is correct
- **Fix**: Run the indexer manually: Click the indexer, then **Run** button

### Issue: "Quota exceeded" on Search Service
- **Fix**: Upgrade pricing tier from Free to Standard
- **Fix**: Or reduce the number of indexes/indexers

---

## 7. Cost Estimates (Azure)

| Service | Tier | Cost/Month |
|---------|------|-----------|
| Cosmos DB | Provisioned 400 RU/s | ~$20 |
| AI Search | Standard | ~$200-300 (for production) |
| App Service | Standard (B1) | ~$55 |
| **Total** | | ~$275-355 |

For testing/development:
- Cosmos DB: ~$15 (lower throughput)
- AI Search: Free tier (if eligible, or ~$50 standard tier minimum)
- App Service: ~$55
- **Dev Total**: ~$70-120

---

## Next Steps

1. ✅ Create Cosmos DB account and container
2. ✅ Create Azure AI Search resource
3. ⏳ Update `function.js` with Cosmos DB and Search client code
4. ⏳ Redeploy backend
5. ⏳ Test endpoints with PowerShell script
6. ⏳ Verify sessions persisting to Cosmos DB
7. ⏳ Verify search returning historical tasks

