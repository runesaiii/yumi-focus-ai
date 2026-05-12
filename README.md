# Yumi Focus AI Agent

An agentic AI-powered Chrome extension that prevents task switching and helps users stay focused by enforcing structured work sessions.

## Features
- Task Lock Mode
- Distraction Detection
- Impulse Capture Queue
- Focus Timer (Pomodoro)
- Tab Monitoring
- Optional: Session persistence (Cosmos DB)
- Optional: Historical task search (Azure AI Search)

## Tech Stack
- Chrome Extension (Manifest v3, JavaScript)
- Azure App Service (Backend)
- Azure OpenAI (Optional AI layer)
- Azure Cosmos DB (Optional session storage)
- Azure AI Search (Optional historical search)

## App Service Deployment

The backend is ready to run on Azure App Service. It reads `PORT` from the environment, supports configurable CORS via `CORS_ORIGIN`, and includes rate limiting for the AI endpoints.

### Required App Settings
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (optional, defaults to `2024-02-15-preview`)
- `CORS_ORIGIN` (comma-separated allowed origins, or `*` for local testing only)

### Optional App Settings (Phase 2)
- `COSMOS_DB_CONNECTION_STRING` — Cosmos DB connection string for session persistence
- `COSMOS_DB_DATABASE` — Database name (default: `yumi`)
- `AI_SEARCH_ENDPOINT` — Azure AI Search endpoint URL
- `AI_SEARCH_ADMIN_KEY` — Azure AI Search admin key

## Setup

### Extension
1. Go to chrome://extensions/
2. Enable Developer Mode
3. Click "Load Unpacked"
4. Select the `/extension` folder

### Backend
1. Open a terminal in the `backend` folder.
2. Install dependencies:
   ```
   npm install
   ```
3. Run locally:
   ```
   npm start
   ```
4. Test the endpoint:
   ```
   curl -X POST http://localhost:3000/check -H "Content-Type: application/json" -d "{\"task\":\"write docs\",\"tabTitle\":\"Write docs in Notion\"}"
   ```

### Azure OpenAI
If you want `/check` to use Azure OpenAI, set these environment variables before starting the backend:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (optional, defaults to `2024-02-15-preview`)

For local development against the extension or browser, you can set `CORS_ORIGIN` to the exact origin of the client, such as `chrome-extension://<your-extension-id>` or `http://localhost:3000`.

If those variables are not set, the backend falls back to the local heuristic classifier so you can keep testing without Azure configured.

---

## Advanced Setup (Optional)

### Cosmos DB Session Persistence
1. Create a Cosmos DB account in Azure Portal
2. Create database `yumi` and container `sessions` with partition key `/userId`
3. Get the connection string from Keys section
4. Set `COSMOS_DB_CONNECTION_STRING` in App Service Configuration
5. Redeploy the backend

The backend will automatically persist session data to Cosmos DB at endpoints:
- `POST /sessions` — Store a session snapshot
- `GET /sessions/:sessionId` — Retrieve a stored session

### Azure AI Search for Historical Tasks
1. Create an Azure AI Search resource
2. Create an index named `tasks-index` with fields: `id`, `userId`, `task`, `timestamp`
3. Get the endpoint and admin key
4. Set `AI_SEARCH_ENDPOINT` and `AI_SEARCH_ADMIN_KEY` in App Service Configuration
5. Redeploy the backend

The backend will support semantic search at:
- `POST /search?query=<query>&userId=<userId>` — Search for tasks matching the query

---

## API Reference

### `/health`
Returns `{ "ok": true }` if the service is running.

### `/check`
Classifies whether a tab is relevant to the current task.
- **Request:** `POST { task, tabTitle, url }`
- **Response:** `{ isRelevant, confidence, reason, source }`
- **Source:** `"azure-openai-chat-completions"`, `"heuristic"`, etc.

### `/summary`
Generates a session summary and coaching feedback.
- **Request:** `POST { task, focusMinutesPlanned, actualFocusMs, distractionsSaved, tabsAdded }`
- **Response:** `{ summary, nextStep }`

### `/sessions` (Optional)
Persist session data to Cosmos DB.
- **Request:** `POST { userId, sessionId, sessionData }`
- **Response:** `{ success, sessionId }`

### `/search` (Optional)
Search historical tasks via Azure AI Search.
- **Request:** `POST { query, userId }`
- **Response:** `{ results }`

