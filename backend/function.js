require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

// Optional Cosmos DB import (graceful fallback if not installed)
let CosmosClient;
try {
  CosmosClient = require("@azure/cosmos").CosmosClient;
} catch (e) {
  console.warn("[Cosmos] @azure/cosmos not installed; using mock session storage");
}

// Optional Azure AI Search import (graceful fallback if not installed)
let SearchClient, AzureKeyCredential;
try {
  SearchClient = require("@azure/search-documents").SearchClient;
  AzureKeyCredential = require("@azure/search-documents").AzureKeyCredential;
} catch (e) {
  console.warn("[Search] @azure/search-documents not installed; using mock search");
}

const app = express();
app.use(express.json());

function parseCorsOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedCorsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedCorsOrigins.includes("*")) {
        callback(null, true);
        return;
      }

      const isChromeExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
      const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
      const isExplicitlyAllowed = allowedCorsOrigins.includes(origin);

      if (isChromeExtensionOrigin || isLocalOrigin || isExplicitlyAllowed) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    }
  })
);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

// Initialize Cosmos DB client (optional)
let cosmosContainer = null;
let cosmoEnabled = false;

(async () => {
  if (CosmosClient && process.env.COSMOS_DB_CONNECTION_STRING) {
    try {
      const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
      const databaseId = process.env.COSMOS_DB_DATABASE || "yumi";
      const containerId = "sessions";
      
      const database = client.database(databaseId);
      cosmosContainer = database.container(containerId);
      
      // Verify the container exists (will throw if not)
      await cosmosContainer.read();
      cosmoEnabled = true;
      console.log(`[Cosmos] Connected to database "${databaseId}", container "${containerId}"`);
    } catch (error) {
      console.warn(`[Cosmos] Failed to initialize: ${error.message}`);
      console.warn("[Cosmos] Falling back to mock session storage");
    }
  } else if (CosmosClient) {
    console.warn("[Cosmos] COSMOS_DB_CONNECTION_STRING not set; using mock session storage");
  }
})();

// Initialize Azure AI Search client (optional)
let searchClient = null;
let searchEnabled = false;

if (SearchClient && AzureKeyCredential && process.env.AI_SEARCH_ENDPOINT && process.env.AI_SEARCH_ADMIN_KEY) {
  try {
    const credential = new AzureKeyCredential(process.env.AI_SEARCH_ADMIN_KEY);
    searchClient = new SearchClient(
      process.env.AI_SEARCH_ENDPOINT,
      "tasks-index",
      credential
    );
    searchEnabled = true;
    console.log(`[Search] Connected to Azure AI Search at ${process.env.AI_SEARCH_ENDPOINT}`);
  } catch (error) {
    console.warn(`[Search] Failed to initialize: ${error.message}`);
  }
} else if (SearchClient && AzureKeyCredential) {
  console.warn("[Search] AI_SEARCH_ENDPOINT or AI_SEARCH_ADMIN_KEY not set; using mock search");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function sanitizeInput(value, maxLength = 500) {
  return String(value || "")
    .slice(0, maxLength)
    .replace(/[<>\"'`;]/g, "")
    .trim();
}

function redactURLToDomain(value) {
  try {
    const u = new URL(String(value));
    return u.hostname || "[unknown]";
  } catch (err) {
    return "[unknown]";
  }
}

function buildChatCompletionCandidates(endpoint, deployment, apiVersion, promptBody) {
  const normalizedEndpoint = stripTrailingSlash(endpoint);
  const encodedDeployment = encodeURIComponent(deployment);

  return [
    {
      name: "azure-openai-chat-completions",
      url: `${normalizedEndpoint}/openai/deployments/${encodedDeployment}/chat/completions?api-version=${apiVersion}`,
      body: { ...promptBody }
    },
    {
      name: "foundry-openai-v1",
      url: `${normalizedEndpoint}/openai/v1/chat/completions`,
      body: { ...promptBody, model: deployment }
    },
    {
      name: "foundry-model-inference",
      url: `${normalizedEndpoint}/models/chat/completions`,
      body: { ...promptBody, model: deployment }
    }
  ];
}

async function postChatCompletion(endpoint, apiKey, deployment, apiVersion, promptBody) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const candidates = buildChatCompletionCandidates(endpoint, deployment, apiVersion, promptBody);
  const headers = {
    "Content-Type": "application/json",
    "api-key": apiKey
  };

  let lastError = null;

  for (const candidate of candidates) {
    const response = await fetch(candidate.url, {
      method: "POST",
      headers,
      body: JSON.stringify(candidate.body)
    });

    if (response.ok) {
      return {
        data: await response.json(),
        source: candidate.name
      };
    }

    const errorText = await response.text().catch(() => "");
    lastError = new Error(
      `Azure OpenAI request failed for ${candidate.name} with status ${response.status}${errorText ? `: ${errorText}` : ""}`
    );

    if (response.status !== 401 && response.status !== 404) {
      throw lastError;
    }
  }

  throw lastError || new Error("Azure OpenAI request failed.");
}

function heuristicCheck(task, tabTitle, url) {
  const taskText = normalizeText(task);
  const titleText = normalizeText(tabTitle);
  const urlText = normalizeText(url);

  if (!taskText || (!titleText && !urlText)) {
    return {
      isRelevant: false,
      confidence: 0.2,
      reason: "Missing task or tab details."
    };
  }

  if (titleText.includes(taskText) || urlText.includes(taskText)) {
    return {
      isRelevant: true,
      confidence: 0.92,
      reason: "Tab title or URL directly matches the task."
    };
  }

  const taskWords = taskText.split(/\s+/).filter(Boolean);
  const titleWords = titleText.split(/\s+/).filter(Boolean);
  const overlap = taskWords.filter((word) => titleWords.includes(word)).length;
  const overlapScore = taskWords.length ? overlap / taskWords.length : 0;

  return {
    isRelevant: overlapScore >= 0.34,
    confidence: Number((0.35 + overlapScore * 0.5).toFixed(2)),
    reason: overlapScore >= 0.34 ? "Task and tab share several keywords." : "Tab does not look strongly related to the task."
  };
}

async function checkWithAzureOpenAI(task, tabTitle, url) {
  console.log("[Azure] Starting checkWithAzureOpenAI with env:", { endpoint: process.env.AZURE_OPENAI_ENDPOINT?.substring(0, 30), deployment: process.env.AZURE_OPENAI_DEPLOYMENT, hasApiKey: !!process.env.AZURE_OPENAI_API_KEY });
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || "");
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || "");
  const deployment = String(process.env.AZURE_OPENAI_DEPLOYMENT || "");
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview");

  if (typeof fetch !== "function") {
    return null;
  }

  if (!endpoint || !apiKey || !deployment) {
    return null;
  }

  const prompt = [
    "You are a focus-session relevance classifier.",
    "Return only JSON with keys: isRelevant (boolean), confidence (number from 0 to 1), reason (short string).",
    `Task: ${sanitizeInput(task, 400)}`,
    `Tab title: ${sanitizeInput(tabTitle, 300)}`,
    `URL domain: ${redactURLToDomain(url)}`
  ].join("\n");

  const { data, source } = await postChatCompletion(endpoint, apiKey, deployment, apiVersion, {
    temperature: 0,
    max_tokens: 120,
    messages: [
      { role: "system", content: "You classify whether a tab is relevant to a task." },
      { role: "user", content: prompt }
    ]
  });

  const content = data?.choices?.[0]?.message?.content || "";
  let parsed = null;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return null;
  }

  // Validate parsed structure and sanitize outputs
  if (!parsed || typeof parsed.isRelevant !== "boolean") {
    return null;
  }

  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;
  const reason = sanitizeInput(String(parsed.reason || "Azure OpenAI classification."), 300);

  return {
    isRelevant: parsed.isRelevant,
    confidence,
    reason,
    source
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/check", apiLimiter);
app.use("/summary", apiLimiter);

// Mock session storage (replace with Cosmos DB when configured)
const sessionStore = new Map();

function getModelForRequest(isHighPriority = false) {
  // Multi-model routing: use gpt-4 for high-priority, gpt-3.5 for standard
  return isHighPriority ? "gpt-4" : "gpt-3.5-turbo";
}

// Session persistence endpoints (Cosmos DB with fallback to mock)
async function indexSessionToSearch(sessionId, userId, sessionData, ts) {
  if (!searchEnabled || !searchClient) {
    return false;
  }

  const task = String(sessionData?.task || sessionData?.label || "").trim();
  if (!task) {
    return false;
  }

  const document = {
    "@search.action": "upload",
    id: sessionId,
    userId,
    task,
    label: String(sessionData?.label || task).trim(),
    timestamp: new Date(ts).toISOString(),
    ts,
    url: String(sessionData?.url || "").trim()
  };

  await searchClient.uploadDocuments([document]);
  return true;
}

app.post("/sessions", async (req, res) => {
  const { userId, sessionId, sessionData } = req.body;
  if (!userId || !sessionId || !sessionData) {
    return res.status(400).json({ error: "Missing userId, sessionId, or sessionData" });
  }

  const ts = Date.now();

  try {
    if (cosmoEnabled && cosmosContainer) {
      // Store in Cosmos DB
      await cosmosContainer.items.create({
        id: sessionId,
        userId,
        ...sessionData,
        ts
      });
      try {
        await indexSessionToSearch(sessionId, userId, sessionData, ts);
      } catch (searchError) {
        console.warn("[Search] Failed to index session:", searchError.message);
      }
      return res.json({ success: true, sessionId, stored: "cosmos-db" });
    } else {
      // Fallback to mock storage
      sessionStore.set(sessionId, { userId, sessionData, ts });
      return res.json({ success: true, sessionId, stored: "mock" });
    }
  } catch (error) {
    console.warn("Session storage failed:", error.message);
    res.status(500).json({ error: "Failed to store session" });
  }
});

app.get("/sessions/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const { userId } = req.query;

  try {
    if (cosmoEnabled && cosmosContainer) {
      if (!userId) {
        return res.status(400).json({ error: "Missing userId query parameter" });
      }
      // Retrieve from Cosmos DB using partition key (userId)
      const { resource: item } = await cosmosContainer.item(sessionId, userId).read();
      if (!item) {
        return res.status(404).json({ error: "Session not found" });
      }
      return res.json(item);
    } else {
      // Fallback to mock storage
      const storedSession = sessionStore.get(sessionId);
      if (!storedSession) {
        return res.status(404).json({ error: "Session not found" });
      }
      return res.json(storedSession);
    }
  } catch (error) {
    console.warn("Session retrieval failed:", error.message);
    res.status(500).json({ error: "Failed to retrieve session" });
  }
});

app.post("/search", async (req, res) => {
  const { query, userId } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Missing query" });
  }

  try {
    if (searchEnabled && searchClient) {
      // Search Azure AI Search
      try {
        const results = await searchClient.search(query, {
          filter: userId ? `userId eq '${userId.replace(/'/g, "''")}'` : undefined,
          top: 20
        });

        const resultsList = [];
        for await (const result of results.results) {
          resultsList.push({
            type: "task",
            label: result.document.task || result.document.label || "Unnamed task",
            url: result.document.url || "",
            timestamp: result.document.timestamp || result.document.ts,
            score: result.score
          });
        }

        return res.json({ results: resultsList, source: "azure-ai-search", count: resultsList.length });
      } catch (searchError) {
        console.warn(`[Search] AI Search query failed: ${searchError.message}`);
        // Fall through to mock search below
      }
    }

    // Fallback: Simple keyword matching across stored sessions
    const results = [];
    sessionStore.forEach((session) => {
      if (!userId || session.userId === userId) {
        const data = session.sessionData;
        if (data.task?.toLowerCase().includes(query.toLowerCase())) {
          results.push({ 
            type: "task", 
            label: data.task, 
            timestamp: session.ts,
            score: 0.8
          });
        }
        if (Array.isArray(data.queue)) {
          data.queue.forEach(item => {
            if (item.label?.toLowerCase().includes(query.toLowerCase())) {
              results.push({ 
                type: "queued", 
                label: item.label, 
                url: item.url, 
                timestamp: session.ts,
                score: 0.6
              });
            }
          });
        }
      }
    });
    
    res.json({ results, source: "mock-search", count: results.length });
  } catch (error) {
    console.warn("Search failed:", error.message);
    res.status(500).json({ error: "Search failed", results: [], source: "error" });
  }
});

app.post("/check", async (req, res) => {
  const task = String(req.body?.task || req.body?.currentTask || "").trim();
  const tabTitle = String(req.body?.tabTitle || "").trim();
  const url = String(req.body?.url || "").trim();

  try {
    const aiResult = await checkWithAzureOpenAI(task, tabTitle, url);
    if (aiResult) {
      return res.json(aiResult);
    }
  } catch (error) {
    console.warn("Azure OpenAI classification failed, falling back to heuristic.", error.message);
  }

  const result = heuristicCheck(task, tabTitle, url);
  res.json({
    ...result,
    source: "heuristic"
  });
});

app.post("/summary", async (req, res) => {
  const task = String(req.body?.task || "").trim();
  const focusMinutesPlanned = Number.parseInt(req.body?.focusMinutesPlanned, 10) || 25;
  const actualFocusMs = Number(req.body?.actualFocusMs || 0);
  const distractionsSaved = Array.isArray(req.body?.distractionsSaved) ? req.body.distractionsSaved : [];
  const tabsAdded = Array.isArray(req.body?.tabsAdded) ? req.body.tabsAdded : [];

  const actualFocusMinutes = Math.round(actualFocusMs / 1000 / 60);

  if (!task) {
    return res.json({
      summary: "No task recorded for this session.",
      nextStep: "Start a new focus session with a clear task."
    });
  }

  const prompt = [
    "You are a focus session coach. Write a 2-3 sentence reflection on this focus session.",
    `Task: ${sanitizeInput(task, 400)}`,
    `Planned: ${focusMinutesPlanned} minutes, Actual: ${actualFocusMinutes} minutes`,
    `Distractions saved for later: ${distractionsSaved.length > 0 ? distractionsSaved.map(d => sanitizeInput(d)).join(", ") : "none"}`,
    `Tabs added to focus group: ${tabsAdded.length > 0 ? tabsAdded.map(t => sanitizeInput(t)).join(", ") : "none"}`,
    "Provide encouragement and suggest one next step. Keep it brief and actionable."
  ].join("\n");

  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || "");
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || "");
  const deployment = String(process.env.AZURE_OPENAI_DEPLOYMENT || "");
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview");

  let summaryText = "";

  if (endpoint && apiKey && deployment && typeof fetch === "function") {
    try {
      const { data, source } = await postChatCompletion(endpoint, apiKey, deployment, apiVersion, {
        temperature: 0.7,
        max_tokens: 200,
        messages: [
          { role: "system", content: "You are a supportive focus coach." },
          { role: "user", content: prompt }
        ]
      });
      summaryText = String(data?.choices?.[0]?.message?.content || "").trim();

      if (!summaryText) {
        console.warn(`Azure OpenAI summary returned no content from ${source}; using fallback.`);
      }
    } catch (error) {
      console.warn("Azure OpenAI summary failed, using fallback.", error.message);
    }
  }

  if (!summaryText) {
    const distractionPhrase = distractionsSaved.length > 0
      ? `You saved ${distractionsSaved.length} distraction${distractionsSaved.length > 1 ? "s" : ""} for later.`
      : "You stayed focused without distractions!";
    const tabPhrase = tabsAdded.length > 0
      ? `You added ${tabsAdded.length} tab${tabsAdded.length > 1 ? "s" : ""} to your focus group.`
      : "";
    summaryText = `Great work on "${task}"! ${distractionPhrase} ${tabPhrase}`.trim();
  }

  res.json({
    summary: summaryText,
    nextStep: "Time to check your queued tasks or start a new focus session."
  });
});

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});