require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

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