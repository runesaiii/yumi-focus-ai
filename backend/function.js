const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
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
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
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
    `Task: ${task}`,
    `Tab title: ${tabTitle}`,
    `URL: ${url}`
  ].join("\n");

  const response = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: "You classify whether a tab is relevant to a task." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Azure OpenAI request failed with status ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  let parsed = null;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return null;
  }

  return {
    isRelevant: Boolean(parsed.isRelevant),
    confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : 0.5,
    reason: String(parsed.reason || "Azure OpenAI classification."),
    source: "azure-openai"
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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
    `Task: ${task}`,
    `Planned: ${focusMinutesPlanned} minutes, Actual: ${actualFocusMinutes} minutes`,
    `Distractions saved for later: ${distractionsSaved.length > 0 ? distractionsSaved.join(", ") : "none"}`,
    `Tabs added to focus group: ${tabsAdded.length > 0 ? tabsAdded.join(", ") : "none"}`,
    "Provide encouragement and suggest one next step. Keep it brief and actionable."
  ].join("\n");

  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || "");
  const deployment = String(process.env.AZURE_OPENAI_DEPLOYMENT || "");
  const apiVersion = String(process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview");

  let summaryText = "";

  if (endpoint && apiKey && deployment && typeof fetch === "function") {
    try {
      const response = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey
        },
        body: JSON.stringify({
          temperature: 0.7,
          max_tokens: 200,
          messages: [
            { role: "system", content: "You are a supportive focus coach." },
            { role: "user", content: prompt }
          ]
        })
      });

      if (response.ok) {
        const data = await response.json();
        summaryText = String(data?.choices?.[0]?.message?.content || "").trim();
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
    nextStep: "Check your queued tasks or start a new focus session."
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});