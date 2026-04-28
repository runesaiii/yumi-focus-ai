let currentTask = "";
let startTime = null;
const BACKEND_CHECK_URL = "http://localhost:3000/check";
const BACKEND_SUMMARY_URL = "http://localhost:3000/summary";

let sessionLog = {
  distractionsSaved: [],
  tabsAddedToFocus: [],
  pauseCount: 0,
  startTime: null,
  endTime: null
};

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

function tabMatchesQueueItem(tab, item) {
  const queueItem = normalizeQueueItem(item);
  const tabTitle = String(tab?.title || "").toLowerCase();
  const tabUrl = String(tab?.url || "").toLowerCase();
  const queueLabel = String(queueItem.label || "").toLowerCase();
  const queueUrl = String(queueItem.url || "").toLowerCase();

  if (queueUrl) {
    if (tabUrl === queueUrl || tabUrl.startsWith(queueUrl)) return true;
    try {
      const queueHost = new URL(queueUrl).hostname.replace(/^www\./, "");
      const tabHost = new URL(tabUrl).hostname.replace(/^www\./, "");
      if (queueHost && tabHost && queueHost === tabHost) return true;
    } catch (error) {
      // Ignore URL parsing errors and fall back to title/label matching.
    }
  }

  if (queueLabel) {
    return tabTitle.includes(queueLabel) || tabUrl.includes(queueLabel);
  }

  return false;
}

function getSuggestionFromTab(tab) {
  const title = String(tab?.title || "").trim();
  if (title) return title;
  try {
    const hostname = new URL(String(tab?.url || "")).hostname;
    return hostname;
  } catch (error) {
    return "";
  }
}

async function classifyTabForTask(task, tab) {
  try {
    const response = await fetch(BACKEND_CHECK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        task,
        tabTitle: String(tab?.title || ""),
        url: String(tab?.url || "")
      })
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    return null;
  }
}

chrome.storage.local.get(["currentTask", "startTime"], (data) => {
  currentTask = data.currentTask || "";
  startTime = data.startTime || null;
});

// Listen for tab switching
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  const data = await chrome.storage.local.get(["sessionActive", "focusTabIds", "currentTask", "queue"]);

  const sessionActive = Boolean(data.sessionActive);
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];
  const task = String(data.currentTask || "").trim();
  const queue = Array.isArray(data.queue) ? data.queue : [];

  // If not in session, check if tab matches queued task
  if (!sessionActive && queue.length && tab?.id && tabMatchesQueueItem(tab, queue[0])) {
    await removeQueueItem(0);
    // Auto-open popup when moving to next queued task
    chrome.action.openPopup();
    return;
  }

  if (!sessionActive || !focusTabIds.length || !task) return;
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  if (focusTabIds.includes(tab.id)) return;

  const classification = await classifyTabForTask(task, tab);
  const tabLooksRelevant = Boolean(classification?.isRelevant);

  // User clicked on a distraction tab - lock them out by auto-switching back
  const suggestion = getSuggestionFromTab(tab);

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showWarning,
      args: [task, suggestion, tabLooksRelevant, classification?.reason || ""]
    });

    const action = result?.[0]?.result;

    if (action?.action === "save" && action?.label) {
      // Save to queue for later
      await addQueueItem(action.label, String(tab.url || ""));
      sessionLog.distractionsSaved.push(action.label);
    } else if (action?.action === "addToFocus") {
      // Add this tab to the focus group
      if (!focusTabIds.includes(tab.id)) {
        focusTabIds.push(tab.id);
        await chrome.storage.local.set({ focusTabIds });
        sessionLog.tabsAddedToFocus.push(String(tab.title || ""));
      }
      return; // Keep user on this tab since they added it to focus
    }
  } catch (error) {
    // Ignore script injection errors on pages where execution is not allowed.
  }

  // Auto-switch back to a focus tab (hard lock)
  if (focusTabIds.length > 0) {
    const focusTabId = focusTabIds[0];
    try {
      await chrome.tabs.update(focusTabId, { active: true });
    } catch (error) {
      // Tab may have been closed, ignore
    }
  }
});

// Note: Removed chrome.tabs.onCreated listener - let onActivated handle new tabs naturally

function showWarning(taskName, defaultSuggestion, tabLooksRelevant, aiReason) {
  const relevanceLine = tabLooksRelevant
    ? `\n\nAI thinks this tab may be related to your task.`
    : `\n\nAI thinks this tab is probably a distraction.`;
  const reasonLine = aiReason ? `\nReason: ${aiReason}` : "";
  const shouldSave = confirm(
    `⚠️ You are currently focusing on: ${taskName}${relevanceLine}${reasonLine}\n\n[OK] Save for later\n[Cancel] Show more options`
  );

  if (shouldSave) {
    // User chose to save for later
    const suggested = String(defaultSuggestion || "").trim();
    const label = prompt("What should I save for later?", suggested);

    if (!label || !label.trim()) {
      return { action: "ignore" };
    }

    return {
      action: "save",
      label: label.trim()
    };
  } else {
    // Show second confirm for add to focus or cancel
    const shouldAdd = confirm(
      `Would you like to add this tab to your focus group instead?\n\n[OK] Add to focus\n[Cancel] Just ignore`
    );

    if (shouldAdd) {
      return { action: "addToFocus" };
    } else {
      return { action: "ignore" };
    }
  }
}

function showFocusComplete(taskName, nextTaskLabel) {
  const continueCurrent = confirm(
    `🎉 Focus session complete for: ${taskName}\n\nPress OK to continue focusing on this tab.\nPress Cancel to move to your next saved task.`
  );

  return {
    continueCurrent,
    nextTaskLabel: String(nextTaskLabel || "")
  };
}

// Timer checker
setInterval(() => {
  chrome.storage.local
    .get(["sessionActive", "sessionPaused", "endTime", "focusMinutes", "currentTask", "queue"])
    .then(async (data) => {
      if (!data.sessionActive || !data.endTime) return;

      const sessionPaused = Boolean(data.sessionPaused);
      if (sessionPaused) return;

      const endTime = Number(data.endTime || 0);
      if (!endTime || Date.now() < endTime) return;

      const task = String(data.currentTask || "Current task");
      const queue = Array.isArray(data.queue) ? data.queue : [];
      const firstItem = normalizeQueueItem(queue[0]);
      const nextLabel = firstItem.label || "No queued task";
      const focusMinutes = Number.parseInt(data.focusMinutes, 10) || 25;

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab?.id || isRestrictedUrl(tab.url)) {
        await chrome.storage.local.set({ sessionActive: false });
        return;
      }

      try {
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: showFocusComplete,
          args: [task, nextLabel]
        });

        const action = result?.[0]?.result;
        if (action?.continueCurrent) {
          const now = Date.now();
          await chrome.storage.local.set({
            startTime: now,
            endTime: now + focusMinutes * 60 * 1000,
            sessionActive: true
          });
          return;
        }

        if (firstItem.label) {
          if (firstItem.url && !isRestrictedUrl(firstItem.url)) {
            const allTabs = await chrome.tabs.query({});
            const matchingTab = allTabs.find(
              (t) => t.url === firstItem.url || t.url?.startsWith(firstItem.url.split("?")[0])
            );

            if (matchingTab) {
              await chrome.tabs.update(matchingTab.id, { active: true });
            } else {
              await chrome.tabs.create({ url: firstItem.url });
            }
          } else {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (label) => {
                alert(`Next saved task: ${label}`);
              },
              args: [firstItem.label]
            });
          }
        }

        await removeQueueItem(0);
        // Auto-open popup when moving to next task
        chrome.action.openPopup();
      } catch (error) {
        // Ignore injection errors on pages that do not allow scripts.
      }

      // Store the session log for later retrieval
      sessionLog.endTime = Date.now();
      sessionLog.startTime = Number(data.startTime || 0);
      await chrome.storage.local.set({ lastSessionLog: sessionLog });

      await chrome.storage.local.set({
        sessionActive: false,
        startTime: null,
        endTime: null,
        focusTabIds: [],
        sessionPaused: false
      });

      // Reset session log for next session
      sessionLog = {
        distractionsSaved: [],
        tabsAddedToFocus: [],
        pauseCount: 0,
        startTime: null,
        endTime: null
      };
    });
}, 5000);