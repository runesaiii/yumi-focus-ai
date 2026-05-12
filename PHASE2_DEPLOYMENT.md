# Phase 2 Deployment Guide - 24 Hour Quick Start

This guide walks through deploying Phase 2 (Cosmos DB + Azure AI Search) in under 2 hours.

## 📋 Prerequisites

- Azure CLI installed: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli
- PowerShell 7+ (on Windows, macOS, or Linux)
- Logged into Azure: `az login`
- Git with remotes configured

## 🚀 Quick Start (5 Steps)

### Step 1: Run the Azure Setup Script (10 minutes)

This automates all resource creation:

```powershell
cd yumi-focus-ai
./setup-azure-phase2.ps1
```

**What this does:**
- Creates Cosmos DB account & database
- Creates the "sessions" container
- Creates Azure AI Search resource
- Creates the "tasks-index" search index
- Outputs all connection strings and keys

**Output:**
```
COSMOS_DB_CONNECTION_STRING=AccountEndpoint=https://...;AccountKey=...;
AI_SEARCH_ENDPOINT=https://yumi-search-xxxx.search.windows.net
AI_SEARCH_ADMIN_KEY=xxxxxxxxxxxxxxxxxxxxx
```

### Step 2: Add Environment Variables to App Service (5 minutes)

1. Go to [Azure Portal](https://portal.azure.com) → Your App Service → **Configuration**
2. Click **New application setting** and add:

```
COSMOS_DB_CONNECTION_STRING = [paste from script output]
COSMOS_DB_DATABASE = yumi
AI_SEARCH_ENDPOINT = [paste from script output]
AI_SEARCH_ADMIN_KEY = [paste from script output]
```

3. Click **Save** and wait for the app to restart

### Step 3: Deploy Backend Updates (5 minutes)

```bash
cd backend
npm install
```

Then push the changes:

```bash
git add .
git commit -m "Add Phase 2: Cosmos DB and AI Search integration"
git push origin main
```

The GitHub Actions workflow will automatically redeploy your backend.

### Step 4: Verify Deployment (5 minutes)

Wait for the GitHub Actions workflow to complete, then test:

```powershell
# Test session storage
$session = @{
    userId = "test-user"
    sessionId = "session-001"
    sessionData = @{
        task = "Write documentation"
        focusMinutes = 25
        distractionsSaved = @("Twitter", "Slack")
    }
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "https://yumi-focus-ai.azurewebsites.net/sessions" `
    -Method Post `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $session

# Test search
$search = @{
    query = "documentation"
    userId = "test-user"
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "https://yumi-focus-ai.azurewebsites.net/search" `
    -Method Post `
    -Headers @{ "Content-Type" = "application/json" } `
    -Body $search
```

### Step 5: Verify Extension Works (5 minutes)

1. Go to `chrome://extensions/`
2. Click your Yumi Focus AI extension
3. Start a focus session
4. Complete the session
5. Check logs: Open DevTools (F12) → Extension icon → Inspect popup
6. Verify session was persisted (you should see a successful POST to `/sessions`)

## 📊 What Changed

### Backend Updates
- **function.js**: Now integrates real Cosmos DB and AI Search clients
  - Falls back to mock storage if credentials aren't configured
  - Logs whether using real or mock storage on startup
  - POST /sessions now stores to Cosmos DB
  - GET /sessions/:sessionId now retrieves from Cosmos DB
  - POST /search now queries Azure AI Search

- **package.json**: Added Azure SDK dependencies:
  - `@azure/cosmos@^4.1.1`
  - `@azure/search-documents@^12.0.0`

### Extension (No Changes Required)
- Already calling the backend endpoints
- Sessions automatically persisted when focus session completes
- Search UI ready to use

## ✅ Validation Checklist

- [ ] Azure setup script ran successfully
- [ ] Environment variables added to App Service
- [ ] GitHub Actions deployment completed
- [ ] /health endpoint returns `{ ok: true }`
- [ ] /sessions POST returns `{ success: true, stored: "cosmos-db" }`
- [ ] /search POST returns results array
- [ ] Extension starts focus session
- [ ] Extension completes session without errors
- [ ] Console logs show "Session persisted: session-xxx"

## 🆘 Troubleshooting

### "Failed to create Cosmos DB"
- Ensure you're logged in: `az login`
- Ensure resource group exists
- Check Azure subscription quota

### "Search service creation failed"
- Free tier may be unavailable in your region
- Script automatically tries Standard tier
- Check Azure Portal for deployment status

### "/sessions returns 'stored: mock'"
- Verify COSMOS_DB_CONNECTION_STRING is set in App Service Configuration
- Redeploy after setting env vars
- Check Application Insights logs for connection errors

### "Search returns 0 results"
- First time searching may not have data yet
- Create a focus session, complete it, then search
- Verify AI_SEARCH_ENDPOINT and AI_SEARCH_ADMIN_KEY are set

### Cannot find extension after loading
- Run `npm install` in backend folder
- Verify package.json has the new dependencies
- Redeploy to Azure

## 📈 Cost Impact

| Service | Tier | Monthly Cost |
|---------|------|--------------|
| Cosmos DB | Provisioned 400 RU/s | ~$25 |
| AI Search | Free/Standard | ~$50 |
| App Service | Standard B1 | ~$55 |
| **Total** | | ~$130 |

*Costs are estimates; see Azure Portal for exact pricing*

## 🎯 Phase 2 Completion

After this guide, you will have:

✅ Session data persisting to Cosmos DB  
✅ Search capability via Azure AI Search  
✅ Multi-model routing logic in backend  
✅ Search UI in extension  
✅ Production-ready configuration  

**Ready for submission in under 2 hours!**

---

## Advanced: Indexer Setup (Optional)

To automatically sync new sessions from Cosmos DB to search index:

1. Go to Azure AI Search → **Indexers**
2. Click **Create indexer**
3. Configure:
   - Data source: Azure Cosmos DB (use connection string)
   - Collection: sessions
   - Index: tasks-index
   - Field mappings:
     - `id` → `id`
     - `userId` → `userId`
     - `sessionData/task` → `task`
     - `ts` → `timestamp`

This will auto-sync every session to search results!

---

Need help? See [PHASE2_SETUP.md](PHASE2_SETUP.md) for detailed explanations.
