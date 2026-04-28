const taskInput = document.getElementById("task");
const focusMinutesInput = document.getElementById("focusMinutes");
const newTaskInput = document.getElementById("newTask");
const sessionStatus = document.getElementById("sessionStatus");
const timerDisplay = document.getElementById("timerDisplay");
const adjustMinutesInput = document.getElementById("adjustMinutes");
const startSection = document.getElementById("startSection");
const sessionSection = document.getElementById("sessionSection");
const distractionSection = document.getElementById("distractionSection");
const queueToggleBtn = document.getElementById("queueToggleBtn");

let timerInterval = null;

// Toggle Queued Tasks section visibility
queueToggleBtn.addEventListener("click", () => {
  const isHidden = distractionSection.style.display === "none";
  distractionSection.style.display = isHidden ? "block" : "none";
  queueToggleBtn.textContent = isHidden ? "Hide Queue" : "Queued Tasks";
});

function isRestrictedUrl(url) {
  const value = String(url || "");
  return (
    !value ||
    value.startsWith("chrome://") ||
    value.startsWith("edge://") ||
    value.startsWith("chrome-extension://") ||
    value.startsWith("about:")
  );
}

function normalizeQueueItem(item) {
  if (typeof item === "string") {
    return { label: item, url: "" };
  }

  return {
    label: String(item?.label || "").trim(),
    url: String(item?.url || "").trim()
  };
}

async function getQueue() {
  const data = await chrome.storage.local.get("queue");
  return Array.isArray(data.queue) ? data.queue : [];
}

async function addQueueItem(label, url) {
  const cleanLabel = String(label || "").trim();
  if (!cleanLabel) return;

  const queue = await getQueue();
  queue.push({ label: cleanLabel, url: String(url || "") });
  await chrome.storage.local.set({ queue });
}

async function removeQueueItem(index) {
  const queue = await getQueue();
  queue.splice(index, 1);
  await chrome.storage.local.set({ queue });
}

async function removeQueueItemByValue(targetItem) {
  const queue = await getQueue();
  const targetLabel = String(targetItem?.label || "").trim();
  const targetUrl = String(targetItem?.url || "").trim();

  const nextQueue = queue.filter((item) => {
    const normalizedItem = normalizeQueueItem(item);
    return !(
      normalizedItem.label === targetLabel &&
      normalizedItem.url === targetUrl
    );
  });

  await chrome.storage.local.set({ queue: nextQueue });
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

async function getTabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

async function openOrFocusTabForQueueItem(item) {
  const queueItem = normalizeQueueItem(item);
  const existingTabs = await chrome.tabs.query({});
  const searchLabel = queueItem.label.toLowerCase();
  const searchUrl = queueItem.url.toLowerCase();

  const matchingTab = existingTabs.find((tab) => {
    const title = String(tab.title || "").toLowerCase();
    const url = String(tab.url || "").toLowerCase();
    return (
      (searchUrl && url.startsWith(searchUrl)) ||
      (searchLabel && title.includes(searchLabel)) ||
      (searchLabel && url.includes(searchLabel))
    );
  });

  if (matchingTab) {
    await chrome.tabs.update(matchingTab.id, { active: true });
    return matchingTab;
  }

  if (queueItem.url && !isRestrictedUrl(queueItem.url)) {
    return await chrome.tabs.create({ url: queueItem.url });
  }

  return null;
}

async function promptNextQueuedTask() {
  const queue = await getQueue();
  const firstItem = normalizeQueueItem(queue[0]);
  const nextLabel = firstItem.label || "No queued task";

  const shouldContinue = confirm(`Move to next saved task?\nNext: ${nextLabel}`);

  if (shouldContinue && firstItem.label) {
    await openOrFocusTabForQueueItem(firstItem);
    await removeQueueItem(0);
    await renderQueue();
  }

  await renderUI();
}

function startTimerDisplay() {
  if (timerInterval) clearInterval(timerInterval);

  timerInterval = setInterval(async () => {
    const data = await chrome.storage.local.get([
      "sessionActive",
      "sessionPaused",
      "pauseStartedAt",
      "pausedRemainingMs",
      "endTime",
      "startTime",
      "focusMinutes",
      "currentTask",
      "focusTabIds"
    ]);

    if (!data.sessionActive || !data.endTime) {
      clearInterval(timerInterval);
      timerDisplay.textContent = "";
      return;
    }

    const pausedRemaining = Number(data.pausedRemainingMs || 0);
    const remaining = data.sessionPaused
      ? Math.max(0, pausedRemaining)
      : Math.max(0, Number(data.endTime || 0) - Date.now());

    if (data.sessionPaused) {
      timerDisplay.textContent = `Paused: ${formatTime(remaining)}`;
      return;
    }

    timerDisplay.textContent = `Time left: ${formatTime(remaining)}`;

    if (remaining <= 0) {
      clearInterval(timerInterval);
    }
  }, 500);
}

document.getElementById("start").addEventListener("click", async () => {
  const task = taskInput.value.trim();
  const focusMinutes = Number.parseInt(focusMinutesInput.value, 10) || 25;

  if (!task) {
    alert("Please enter a task before starting focus mode.");
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || isRestrictedUrl(tab.url)) {
    alert("Navigate to a website tab first, then start focus mode.");
    return;
  }

  const now = Date.now();
  const endTime = now + focusMinutes * 60 * 1000;

  await chrome.storage.local.set({
    currentTask: task,
    focusMinutes,
    startTime: now,
    endTime,
    focusTabIds: [tab.id],
    focusTabUrl: String(tab.url || ""),
    focusTabTitle: String(tab.title || ""),
    sessionActive: true,
    sessionPaused: false,
    pauseStartedAt: null,
    pausedRemainingMs: null
  });

  await renderUI();
  startTimerDisplay();
});

document.getElementById("addTabBtn").addEventListener("click", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || isRestrictedUrl(tab.url)) {
    alert("Navigate to a website tab first.");
    return;
  }

  const data = await chrome.storage.local.get("focusTabIds");
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];

  if (!focusTabIds.includes(tab.id)) {
    focusTabIds.push(tab.id);
    await chrome.storage.local.set({ focusTabIds });
    await renderUI();
    alert(`Added "${tab.title}" to focus group.`);
  } else {
    alert("This tab is already in your focus group.");
  }
});

document.getElementById("adjustBtn").addEventListener("click", async () => {
  const changeMinutes = Number.parseInt(adjustMinutesInput.value, 10);
  if (!Number.isFinite(changeMinutes) || changeMinutes === 0) {
    alert("Enter a valid positive or negative number of minutes.");
    return;
  }

  const data = await chrome.storage.local.get(["endTime", "sessionPaused", "pausedRemainingMs"]);
  const currentEndTime = Number(data.endTime || 0);
  const changeMs = changeMinutes * 60 * 1000;

  if (data.sessionPaused) {
    const currentPausedRemaining = Number(data.pausedRemainingMs || 0);
    const newPausedRemaining = Math.max(0, currentPausedRemaining + changeMs);
    await chrome.storage.local.set({ pausedRemainingMs: newPausedRemaining });
  } else {
    const newEndTime = Math.max(Date.now(), currentEndTime + changeMs);
    await chrome.storage.local.set({ endTime: newEndTime });
  }

  adjustMinutesInput.value = "";
  await renderUI();
  startTimerDisplay();
  alert(`${changeMinutes > 0 ? "Added" : "Removed"} ${Math.abs(changeMinutes)} minute(s).`);
});

document.getElementById("pauseBtn").addEventListener("click", async () => {
  const data = await chrome.storage.local.get([
    "sessionPaused",
    "pauseStartedAt",
    "endTime",
    "pausedRemainingMs"
  ]);
  const isPaused = Boolean(data.sessionPaused);

  if (isPaused) {
    const resumedDuration = Number(data.pausedRemainingMs || 0);
    const currentEndTime = Date.now() + resumedDuration;
    await chrome.storage.local.set({
      endTime: currentEndTime,
      sessionPaused: false,
      pauseStartedAt: null,
      pausedRemainingMs: null
    });
    alert("Session resumed.");
  } else {
    const currentEndTime = Number(data.endTime || 0);
    const frozenRemaining = Math.max(0, currentEndTime - Date.now());
    await chrome.storage.local.set({
      sessionPaused: true,
      pauseStartedAt: Date.now(),
      pausedRemainingMs: frozenRemaining
    });
    alert("Session paused. Click Resume to continue.");
  }

  await renderUI();
  startTimerDisplay();
});

document.getElementById("doneBtn").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["currentTask", "focusMinutes", "startTime"]);
  const task = String(data.currentTask || "");
  const focusMinutesPlanned = Number.parseInt(data.focusMinutes, 10) || 25;
  const startTime = Number(data.startTime || 0);
  const actualFocusMs = Math.max(0, Date.now() - startTime);

  const lastLog = await chrome.storage.local.get("lastSessionLog");
  const sessionLog = lastLog?.lastSessionLog || { distractionsSaved: [], tabsAddedToFocus: [] };

  await chrome.storage.local.set({ sessionActive: false, sessionPaused: false });

  let summaryShown = false;
  try {
    const summaryResponse = await fetch("http://localhost:3000/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        focusMinutesPlanned,
        actualFocusMs,
        distractionsSaved: sessionLog.distractionsSaved,
        tabsAdded: sessionLog.tabsAddedToFocus
      })
    });

    if (summaryResponse.ok) {
      const summary = await summaryResponse.json();
      document.getElementById("summaryText").textContent = summary.summary || "Session complete!";
      document.getElementById("nextStepText").textContent = summary.nextStep || "";
      document.getElementById("summarySection").style.display = "block";
      summaryShown = true;
    }
  } catch (error) {
    console.warn("Failed to fetch summary:", error);
  }

  await renderUI();
  clearInterval(timerInterval);

  if (!summaryShown) {
    await promptNextQueuedTask();
  }
});

document.getElementById("summaryCloseBtn").addEventListener("click", async () => {
  document.getElementById("summarySection").style.display = "none";
  await promptNextQueuedTask();
});

document.getElementById("save").addEventListener("click", async () => {
  const newTask = newTaskInput.value.trim();
  if (!newTask) return;

  await addQueueItem(newTask, "");
  newTaskInput.value = "";
  await renderQueue();
});

async function renderUI() {
  const data = await chrome.storage.local.get([
    "sessionActive",
    "currentTask",
    "focusTabTitle",
    "focusMinutes",
    "focusTabIds",
    "sessionPaused",
    "pauseStartedAt",
    "pausedRemainingMs",
    "endTime"
  ]);

  const sessionActive = Boolean(data.sessionActive);

  if (!sessionActive) {
    startSection.style.display = "block";
    sessionSection.style.display = "none";
    timerDisplay.textContent = "";
    return;
  }

  startSection.style.display = "none";
  sessionSection.style.display = "block";

  const task = String(data.currentTask || "");
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];
  const isPaused = Boolean(data.sessionPaused);
  const remaining = isPaused
    ? Math.max(0, Number(data.pausedRemainingMs || 0))
    : Math.max(0, Number(data.endTime || 0) - Date.now());

  sessionStatus.textContent = `Task: ${task} | Tabs in focus: ${focusTabIds.length} ${isPaused ? "(Paused)" : ""}`;
  timerDisplay.textContent = isPaused ? `PAUSED - ${formatTime(remaining)}` : `Time left: ${formatTime(remaining)}`;

  document.getElementById("pauseBtn").textContent = isPaused ? "Resume" : "Pause";
}

async function renderQueue() {
  const queue = await getQueue();
  const list = document.getElementById("queue");
  list.innerHTML = "";

  queue.forEach((rawItem, index) => {
    const item = normalizeQueueItem(rawItem);
    if (!item.label) return;

    const li = document.createElement("li");
    li.className = "queue-item";

    const text = document.createElement("span");
    text.textContent = item.url ? `${item.label} (${item.url})` : item.label;

    const delButton = document.createElement("button");
    delButton.type = "button";
    delButton.textContent = "Delete";
    delButton.addEventListener("click", async () => {
      await removeQueueItemByValue(item);
      await renderQueue();
    });

    li.appendChild(text);
    li.appendChild(delButton);
    list.appendChild(li);
  });
}

renderUI();
renderQueue();
startTimerDisplay();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (
    changes.queue ||
    changes.sessionActive ||
    changes.sessionPaused ||
    changes.endTime ||
    changes.pausedRemainingMs ||
    changes.currentTask ||
    changes.focusTabIds
  ) {
    renderUI();
    renderQueue();
  }
});