# Yumi Focus AI Agent

An agentic AI-powered Chrome extension that prevents task switching and helps users stay focused by enforcing structured work sessions.

## Features
- Task Lock Mode
- Distraction Detection
- Impulse Capture Queue
- Focus Timer (Pomodoro)
- Tab Monitoring

## Tech Stack
- Chrome Extension (JavaScript)
- Azure Functions (Backend)
- Azure OpenAI (Optional AI layer)

## App Service Deployment

The backend is ready to run on Azure App Service. It reads `PORT` from the environment, supports configurable CORS via `CORS_ORIGIN`, and includes rate limiting for the AI endpoints.

Required App Settings:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (optional)
- `CORS_ORIGIN` (comma-separated allowed origins, or `*` for local testing only)

## Setup

### Extension
1. Go to chrome://extensions/
2. Enable Developer Mode
3. Click "Load Unpacked"
4. Select the `/extension` folder

### Backend
1. Open a terminal in the `backend` folder.
2. Install dependencies:
   npm install
3. Run locally:
   npm start
4. Test the endpoint:
   curl -X POST http://localhost:3000/check -H "Content-Type: application/json" -d "{\"task\":\"write docs\",\"tabTitle\":\"Write docs in Notion\"}"

### Azure OpenAI
If you want `/check` to use Azure OpenAI, set these environment variables before starting the backend:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION` (optional, defaults to `2024-02-15-preview`)

For local development against the extension or browser, you can set `CORS_ORIGIN` to the exact origin of the client, such as `chrome-extension://<your-extension-id>` or `http://localhost:3000`.

If those variables are not set, the backend falls back to the local heuristic classifier so you can keep testing without Azure configured.