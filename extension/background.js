let currentTask = "";
let startTime = null;
let transitioningToNextTask = false;
const BACKEND_BASE_URL = "https://yumi-focus-ai.azurewebsites.net";
const BACKEND_CHECK_URL = `${BACKEND_BASE_URL}/check`;
const BACKEND_SUMMARY_URL = `${BACKEND_BASE_URL}/summary`;
const BACKEND_SESSIONS_URL = `${BACKEND_BASE_URL}/sessions`;
const BACKEND_SEARCH_URL = `${BACKEND_BASE_URL}/search`;
const recentlyHandledTabIds = new Set();

let sessionLog = {
  distractionsSaved: [],
  tabsAddedToFocus: [],
  pauseCount: 0,
  startTime: null,
  endTime: null,
  completionPromptActive: false
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
  const cleanUrl = String(url || "").trim();

  const existingIndex = queue.findIndex((item) => {
    const existing = normalizeQueueItem(item);
    return existing.label.toLowerCase() === cleanLabel.toLowerCase();
  });

  if (existingIndex !== -1) {
    const existing = normalizeQueueItem(queue[existingIndex]);
    if (!existing.url && cleanUrl) {
      queue[existingIndex] = { label: cleanLabel, url: cleanUrl };
      await chrome.storage.local.set({ queue });
    }
    return;
  }

  queue.push({ label: cleanLabel, url: cleanUrl });
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
  const { aiConsent } = await chrome.storage.local.get('aiConsent');
  if (!aiConsent?.allowed) return null;
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

async function persistSessionToBackend(sessionData) {
  // Optional: Store completed session to backend (Cosmos DB when configured)
  try {
    const stored = await chrome.storage.local.get(["userId"]);
    const userId = stored.userId || "anonymous"; // allow configurable userId, fallback to anonymous
    const sessionId = `session-${Date.now()}`;
    
    const response = await fetch(BACKEND_SESSIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        sessionId,
        sessionData
      })
    });

    if (response.ok) {
      console.log("[Sessions] Session persisted:", sessionId);
      return sessionId;
    }
  } catch (error) {
    // Silent fail; session persistence is optional
    console.warn("[Sessions] Persistence failed (optional feature):", error.message);
  }
  return null;
}

chrome.storage.local.get(["currentTask", "startTime"], (data) => {
  currentTask = data.currentTask || "";
  startTime = data.startTime || null;
});

// Listen for tab switching
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Skip warning if we're in the middle of transitioning to next task
  if (transitioningToNextTask) return;

  // Prevent double-handling when the same new tab was already processed by onCreated.
  if (recentlyHandledTabIds.has(activeInfo.tabId)) return;

  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  if (!tab?.id) return;
  const data = await chrome.storage.local.get(["sessionActive", "focusTabIds", "currentTask", "queue", "pendingAutoOpenTaskUrl", "pendingAutoOpenTaskLabel", "intentionallyLinkedTaskLabel"]);

  const sessionActive = Boolean(data.sessionActive);
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];
  const task = String(data.currentTask || "").trim();

  // If an intentional open/find is in progress and NO active session, skip all processing
  if (data.pendingAutoOpenTaskLabel && !sessionActive) {
    if (data.pendingAutoOpenTaskUrl && String(tab?.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
      await chrome.storage.local.set({ pendingAutoOpenTaskUrl: null, pendingAutoOpenTaskLabel: null });
    }
    return;
  }

  if (data.pendingAutoOpenTaskUrl && String(tab?.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
    await chrome.storage.local.set({ 
      pendingAutoOpenTaskUrl: null, 
      pendingAutoOpenTaskLabel: null,
      intentionallyLinkedTaskLabel: null
    });
    // If there's an active session, continue to show warning below
    // Otherwise skip to avoid processing this intentional tab
    if (!sessionActive) return;
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

// Listen for new tabs being created during a focus session
chrome.tabs.onCreated.addListener(async (tab) => {
  const data = await chrome.storage.local.get(["sessionActive", "focusTabIds", "currentTask", "pendingAutoOpenTaskUrl", "pendingAutoOpenTaskLabel", "intentionallyLinkedTaskLabel"]);
  
  const sessionActive = Boolean(data.sessionActive);
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];
  const task = String(data.currentTask || "").trim();
  
  // If an intentional open is in progress and NO active session, skip all processing
  if (data.pendingAutoOpenTaskLabel && !sessionActive) {
    if (data.pendingAutoOpenTaskUrl && String(tab.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
      await chrome.storage.local.set({ pendingAutoOpenTaskUrl: null, pendingAutoOpenTaskLabel: null });
    }
    return;
  }
  
  if (!sessionActive || !focusTabIds.length || !task) return;
  if (!tab?.id) return;
  if (data.pendingAutoOpenTaskUrl && String(tab.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
    await chrome.storage.local.set({ pendingAutoOpenTaskUrl: null, pendingAutoOpenTaskLabel: null });
    // If there's an active session, continue to show warning below
    // Otherwise skip to avoid processing this intentional tab
    if (!sessionActive) return;
  }
  // Only skip tabs that have truly restricted URLs (not loading/empty tabs)
  const tabUrl = String(tab.url || "");
  if (!tabUrl || isRestrictedUrl(tabUrl)) return;
  
  // Process immediately without delay for best UX
  const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
  if (updatedTab) {
    
    const classification = await classifyTabForTask(task, updatedTab);
    const tabLooksRelevant = Boolean(classification?.isRelevant);
    const suggestion = getSuggestionFromTab(updatedTab);

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: updatedTab.id },
        func: showWarning,
        args: [task, suggestion, tabLooksRelevant, classification?.reason || ""]
      });

      const action = result?.[0]?.result;

      if (action?.action === "save" && action?.label) {
        await addQueueItem(action.label, String(updatedTab.url || ""));
        sessionLog.distractionsSaved.push(action.label);
      } else if (action?.action === "addToFocus") {
        if (!focusTabIds.includes(updatedTab.id)) {
          focusTabIds.push(updatedTab.id);
          await chrome.storage.local.set({ focusTabIds });
          sessionLog.tabsAddedToFocus.push(String(updatedTab.title || ""));
        }
        return;
      }
    } catch (error) {
      // Ignore script injection errors
    }

    // Auto-switch back to focus tab
    if (focusTabIds.length > 0) {
      const focusTabId = focusTabIds[0];
      try {
        await chrome.tabs.update(focusTabId, { active: true });
      } catch (error) {
        // Tab may have been closed
      }
    }

    recentlyHandledTabIds.add(tab.id);
    setTimeout(() => recentlyHandledTabIds.delete(tab.id), 3000);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (transitioningToNextTask) return;
  if (recentlyHandledTabIds.has(tabId)) return;

  const becameReady = changeInfo.status === "complete" || Boolean(changeInfo.url);
  if (!becameReady || !tab?.id) return;

  const data = await chrome.storage.local.get(["sessionActive", "focusTabIds", "currentTask", "pendingAutoOpenTaskUrl", "pendingAutoOpenTaskLabel", "intentionallyLinkedTaskLabel"]);
  
  const sessionActive = Boolean(data.sessionActive);
  
  // If an intentional open is in progress and NO active session, skip all processing
  if (data.pendingAutoOpenTaskLabel && !sessionActive) {
    if (data.pendingAutoOpenTaskUrl && String(tab.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
      await chrome.storage.local.set({ pendingAutoOpenTaskUrl: null, pendingAutoOpenTaskLabel: null });
    }
    return;
  }
  
  if (data.pendingAutoOpenTaskUrl && String(tab.url || "").startsWith(String(data.pendingAutoOpenTaskUrl || ""))) {
    await chrome.storage.local.set({ pendingAutoOpenTaskUrl: null, pendingAutoOpenTaskLabel: null });
    // If there's an active session, continue to show warning below
    // Otherwise skip to avoid processing this intentional tab
    if (!sessionActive) return;
  }
  const focusTabIds = Array.isArray(data.focusTabIds) ? data.focusTabIds : [];
  const task = String(data.currentTask || "").trim();

  if (!sessionActive || !focusTabIds.length || !task) return;
  if (!tab.url || isRestrictedUrl(tab.url)) return;
  if (focusTabIds.includes(tab.id)) return;

  const classification = await classifyTabForTask(task, tab);
  const tabLooksRelevant = Boolean(classification?.isRelevant);
  const suggestion = getSuggestionFromTab(tab);

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showWarning,
      args: [task, suggestion, tabLooksRelevant, classification?.reason || ""]
    });

    const action = result?.[0]?.result;

    if (action?.action === "save" && action?.label) {
      await addQueueItem(action.label, String(tab.url || ""));
      sessionLog.distractionsSaved.push(action.label);
    } else if (action?.action === "addToFocus") {
      if (!focusTabIds.includes(tab.id)) {
        focusTabIds.push(tab.id);
        await chrome.storage.local.set({ focusTabIds });
        sessionLog.tabsAddedToFocus.push(String(tab.title || ""));
      }
      recentlyHandledTabIds.add(tab.id);
      setTimeout(() => recentlyHandledTabIds.delete(tab.id), 3000);
      return;
    }
  } catch (error) {
    // Ignore script injection errors on pages where execution is not allowed.
  }

  if (focusTabIds.length > 0) {
    const focusTabId = focusTabIds[0];
    try {
      await chrome.tabs.update(focusTabId, { active: true });
    } catch (error) {
      // Tab may have been closed, ignore
    }
  }

  recentlyHandledTabIds.add(tab.id);
  setTimeout(() => recentlyHandledTabIds.delete(tab.id), 3000);
});

async function showWarning(taskName, defaultSuggestion, tabLooksRelevant, aiReason) {
  const relevanceLine = tabLooksRelevant
    ? "This tab looks like it could be related."
    : "This probably isn't related to what you're working on.";
  const reasonLine = aiReason ? `\n${aiReason}` : "";

  const dialogScript = async () => {
    const STYLE_ID = "yumi-focus-dialog-style";
    const OVERLAY_ID = "yumi-focus-dialog-overlay";

    const ensureStyles = () => {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${OVERLAY_ID} {
          position: fixed;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(15, 23, 42, 0.52);
          backdrop-filter: blur(10px);
          z-index: 2147483647;
        }
        #${OVERLAY_ID} .yumi-dialog-card {
          width: min(100%, 380px);
          background: rgba(255, 255, 255, 0.97);
          border-radius: 20px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          box-shadow: 0 28px 70px rgba(15, 23, 42, 0.34);
          padding: 18px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
          color: #0f172a;
        }
        #${OVERLAY_ID} .yumi-dialog-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 48px;
          height: 26px;
          padding: 0 10px;
          margin-bottom: 12px;
          border-radius: 999px;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: #fff;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        #${OVERLAY_ID} h2 {
          margin: 0 0 10px 0;
          font-size: 18px;
          line-height: 1.2;
          letter-spacing: -0.02em;
        }
        #${OVERLAY_ID} p {
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: #334155;
          white-space: pre-wrap;
        }
        #${OVERLAY_ID} .yumi-dialog-input {
          width: 100%;
          margin-top: 14px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid #cbd5e1;
          font: inherit;
          color: #0f172a;
          outline: none;
        }
        #${OVERLAY_ID} .yumi-dialog-input:focus {
          border-color: #4f46e5;
          box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.12);
        }
        #${OVERLAY_ID} .yumi-dialog-actions {
          display: flex;
          gap: 10px;
          margin-top: 16px;
        }
        #${OVERLAY_ID} .yumi-dialog-button {
          flex: 1;
          border: none;
          border-radius: 12px;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
        }
        #${OVERLAY_ID} .yumi-dialog-button:hover {
          transform: translateY(-1px);
        }
        #${OVERLAY_ID} .yumi-dialog-button.primary {
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: #fff;
          box-shadow: 0 10px 20px rgba(79, 70, 229, 0.22);
        }
        #${OVERLAY_ID} .yumi-dialog-button.secondary {
          background: linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%);
          color: #1e293b;
          border: 1px solid #d8e0ea;
        }
        #${OVERLAY_ID} .yumi-dialog-button.success {
          background: linear-gradient(135deg, #16a34a 0%, #14b8a6 100%);
          color: #fff;
          box-shadow: 0 10px 20px rgba(20, 184, 166, 0.22);
        }
      `;
      document.documentElement.appendChild(style);
    };

    const mountDialog = ({ badge, title, message, buttons, showInput = false, defaultValue = "" }) =>
      new Promise((resolve) => {
        ensureStyles();
        document.getElementById(OVERLAY_ID)?.remove();

        const overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;

        const card = document.createElement("div");
        card.className = "yumi-dialog-card";

        const badgeEl = document.createElement("div");
        badgeEl.className = "yumi-dialog-badge";
        badgeEl.textContent = badge;

        const titleEl = document.createElement("h2");
        titleEl.textContent = title;

        const messageEl = document.createElement("p");
        messageEl.textContent = message;

        const input = document.createElement("input");
        input.className = "yumi-dialog-input";
        input.type = "text";
        input.value = defaultValue;
        input.style.display = showInput ? "block" : "none";

        const actions = document.createElement("div");
        actions.className = "yumi-dialog-actions";

        const close = (value) => {
          overlay.remove();
          resolve(value);
        };

        buttons.forEach((buttonConfig) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `yumi-dialog-button ${buttonConfig.variant || "secondary"}`;
          button.textContent = buttonConfig.label;
          button.addEventListener("click", () => {
            if (showInput && buttonConfig.useInputValue) {
              close(input.value.trim());
              return;
            }
            close(buttonConfig.value);
          });
          actions.appendChild(button);
        });

        if (showInput) {
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") close(input.value.trim());
            if (event.key === "Escape") close(null);
          });
        }

        overlay.addEventListener("click", (event) => {
          if (event.target === overlay) close(null);
        });

        card.append(badgeEl, titleEl, messageEl);
        if (showInput) card.appendChild(input);
        card.appendChild(actions);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        requestAnimationFrame(() => {
          if (showInput) input.focus();
          else buttons[0]?.buttonEl?.focus?.();
        });
      });

    const shouldSave = await mountDialog({
      badge: "Warning",
      title: "Stay focused",
      message: `You are currently focusing on: ${taskName}\n\n${relevanceLine}${reasonLine}`,
      buttons: [
        { label: "Save for later", value: "save", variant: "secondary" },
        { label: "Add to focus", value: "focus", variant: "success" },
        { label: "Ignore", value: "ignore", variant: "secondary" }
      ]
    });

    if (shouldSave === "save") {
      const suggested = String(defaultSuggestion || "").trim();
      const label = await mountDialog({
        badge: "Save",
        title: "What should I save?",
        message: "Enter a short label for this task.",
        showInput: true,
        defaultValue: suggested,
        buttons: [
          { label: "Cancel", value: null, variant: "secondary" },
          { label: "Save task", value: true, variant: "primary", useInputValue: true }
        ]
      });

      if (!label || !String(label).trim()) {
        return { action: "ignore" };
      }

      return { action: "save", label: String(label).trim() };
    }

    if (shouldSave === "focus") {
      return { action: "addToFocus" };
    }

    return { action: "ignore" };
  };

  return await dialogScript();
}

async function showFocusComplete(taskName, nextTaskLabel, summaryText) {
  const messageText = summaryText
    ? `Nice work, you finished: ${taskName}\n\n${summaryText}`
    : `Nice work, you finished: ${taskName}`;

  const continueCurrent = await (async () => {
    const STYLE_ID = "yumi-focus-dialog-style";
    const OVERLAY_ID = "yumi-focus-dialog-overlay";

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${OVERLAY_ID} {
          position: fixed;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(15, 23, 42, 0.52);
          backdrop-filter: blur(10px);
          z-index: 2147483647;
        }
        #${OVERLAY_ID} .yumi-dialog-card {
          width: min(100%, 380px);
          background: rgba(255, 255, 255, 0.97);
          border-radius: 20px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          box-shadow: 0 28px 70px rgba(15, 23, 42, 0.34);
          padding: 18px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
          color: #0f172a;
        }
        #${OVERLAY_ID} .yumi-dialog-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 48px;
          height: 26px;
          padding: 0 10px;
          margin-bottom: 12px;
          border-radius: 999px;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: #fff;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        #${OVERLAY_ID} h2 {
          margin: 0 0 10px 0;
          font-size: 18px;
          line-height: 1.2;
          letter-spacing: -0.02em;
        }
        #${OVERLAY_ID} p {
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: #334155;
          white-space: pre-wrap;
        }
        #${OVERLAY_ID} .yumi-dialog-actions {
          display: flex;
          gap: 10px;
          margin-top: 16px;
        }
        #${OVERLAY_ID} .yumi-dialog-button {
          flex: 1;
          border: none;
          border-radius: 12px;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
        }
        #${OVERLAY_ID} .yumi-dialog-button:hover {
          transform: translateY(-1px);
        }
        #${OVERLAY_ID} .yumi-dialog-button.primary {
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          color: #fff;
          box-shadow: 0 10px 20px rgba(79, 70, 229, 0.22);
        }
        #${OVERLAY_ID} .yumi-dialog-button.secondary {
          background: linear-gradient(180deg, #ffffff 0%, #f1f5f9 100%);
          color: #1e293b;
          border: 1px solid #d8e0ea;
        }
        #${OVERLAY_ID} .yumi-dialog-button.success {
          background: linear-gradient(135deg, #16a34a 0%, #14b8a6 100%);
          color: #fff;
          box-shadow: 0 10px 20px rgba(20, 184, 166, 0.22);
        }
      `;
      document.documentElement.appendChild(style);
    }

    document.getElementById(OVERLAY_ID)?.remove();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.innerHTML = `
      <div class="yumi-dialog-card">
        <div class="yumi-dialog-badge">Done</div>
        <h2>Great job</h2>
        <p>${messageText}</p>
        <div class="yumi-dialog-actions">
          <button type="button" class="yumi-dialog-button secondary" data-choice="continue">Keep this tab</button>
          <button type="button" class="yumi-dialog-button primary" data-choice="next">Move to next task</button>
        </div>
      </div>
    `;

    return await new Promise((resolve) => {
      const close = (value) => {
        overlay.remove();
        resolve(value);
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close(false);
      });

      overlay.querySelectorAll("[data-choice]").forEach((button) => {
        button.addEventListener("click", () => close(button.dataset.choice === "continue"));
      });

      document.body.appendChild(overlay);
    });
  })();

  return {
    continueCurrent,
    nextTaskLabel: String(nextTaskLabel || "")
  };
}

async function showSummaryPopup(summaryText, nextStepText) {
  const STYLE_ID = "yumi-focus-dialog-style";
  const OVERLAY_ID = "yumi-focus-dialog-overlay";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.52);
        backdrop-filter: blur(10px);
        z-index: 2147483647;
      }
      #${OVERLAY_ID} .yumi-dialog-card {
        width: min(100%, 380px);
        background: rgba(255, 255, 255, 0.97);
        border-radius: 20px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        box-shadow: 0 28px 70px rgba(15, 23, 42, 0.34);
        padding: 18px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
        color: #0f172a;
      }
      #${OVERLAY_ID} .yumi-dialog-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 48px;
        height: 26px;
        padding: 0 10px;
        margin-bottom: 12px;
        border-radius: 999px;
        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
        color: #fff;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      #${OVERLAY_ID} h2 {
        margin: 0 0 10px 0;
        font-size: 18px;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      #${OVERLAY_ID} p {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        color: #334155;
        white-space: pre-wrap;
      }
      #${OVERLAY_ID} .yumi-dialog-actions {
        display: flex;
        gap: 10px;
        margin-top: 16px;
      }
      #${OVERLAY_ID} .yumi-dialog-button {
        flex: 1;
        border: none;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
      }
      #${OVERLAY_ID} .yumi-dialog-button:hover {
        transform: translateY(-1px);
      }
      #${OVERLAY_ID} .yumi-dialog-button.primary {
        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
        color: #fff;
        box-shadow: 0 10px 20px rgba(79, 70, 229, 0.22);
      }
    `;
    document.documentElement.appendChild(style);
  }

  document.getElementById(OVERLAY_ID)?.remove();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div class="yumi-dialog-card">
      <div class="yumi-dialog-badge">Summary</div>
      <h2>Session complete</h2>
      <p>${String(summaryText || "Great focus session!")}${nextStepText ? `\n\n${String(nextStepText)}` : ""}</p>
      <div class="yumi-dialog-actions">
        <button type="button" class="yumi-dialog-button primary" data-choice="close">Got it</button>
      </div>
    </div>
  `;

  return await new Promise((resolve) => {
    const close = () => {
      overlay.remove();
      resolve({ closed: true });
    };

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    overlay.querySelector("[data-choice='close']")?.addEventListener("click", close);
    document.body.appendChild(overlay);
  });
}

// Timer checker
setInterval(() => {
  chrome.storage.local
    .get(["sessionActive", "sessionPaused", "endTime", "focusMinutes", "currentTask", "queue", "completionPromptActive", "startTime"])
    .then(async (data) => {
      if (!data.sessionActive || !data.endTime) return;

      const sessionPaused = Boolean(data.sessionPaused);
      if (sessionPaused) return;

      if (data.completionPromptActive) return;

      const endTime = Number(data.endTime || 0);
      if (!endTime || Date.now() < endTime) return;

      await chrome.storage.local.set({ completionPromptActive: true });

      const task = String(data.currentTask || "Current task");
      const queue = Array.isArray(data.queue) ? data.queue : [];
      const firstItem = normalizeQueueItem(queue[0]);
      const nextLabel = firstItem.label || "No queued task";
      const focusMinutes = Number.parseInt(data.focusMinutes, 10) || 25;
      const startTimeValue = Number(data.startTime || 0);

      // Fetch summary to include in congrats popup
      let summaryText = "";
      let sessionId = null;
      try {
        const actualFocusMs = Math.max(0, Date.now() - startTimeValue);
        
        const { aiConsent } = await chrome.storage.local.get('aiConsent');
        if (aiConsent?.allowed) {
          const summaryResponse = await fetch(BACKEND_SUMMARY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task,
            focusMinutesPlanned: focusMinutes,
            actualFocusMs,
            distractionsSaved: sessionLog.distractionsSaved || [],
            tabsAdded: sessionLog.tabsAddedToFocus || []
          })
          });

          if (summaryResponse.ok) {
            const summary = await summaryResponse.json();
            summaryText = `${summary.summary || "Great focus session!"}`;
            if (summary.nextStep) {
              summaryText += `\n\n${summary.nextStep}`;
            }
          }
        }

        // Persist session to backend (optional Cosmos DB feature)
        sessionId = await persistSessionToBackend({
          task,
          focusMinutesPlanned: focusMinutes,
          actualFocusMs,
          distractionsSaved: sessionLog.distractionsSaved,
          tabsAddedToFocus: sessionLog.tabsAddedToFocus,
          timestamp: Date.now()
        });
      } catch (error) {
        // Silently continue without summary if fetch fails
      }

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
          args: [task, nextLabel, summaryText]
        });

        const action = result?.[0]?.result;
        if (action?.continueCurrent) {
          const now = Date.now();
          await chrome.storage.local.set({
            startTime: now,
            endTime: now + focusMinutes * 60 * 1000,
            sessionActive: true,
            completionPromptActive: false
          });
          return;
        }

        // Set transition flag before switching to next task
        transitioningToNextTask = true;
        
        try {
          // Clear session state BEFORE tab switch to prevent stale warnings
          await chrome.storage.local.set({
            currentTask: "",
            focusTabIds: []
          });

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
                  const STYLE_ID = "yumi-focus-dialog-style";
                  const OVERLAY_ID = "yumi-focus-dialog-overlay";
                  if (!document.getElementById(STYLE_ID)) {
                    const style = document.createElement("style");
                    style.id = STYLE_ID;
                    style.textContent = `
                      #${OVERLAY_ID} {
                        position: fixed;
                        inset: 0;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        padding: 20px;
                        background: rgba(15, 23, 42, 0.52);
                        backdrop-filter: blur(10px);
                        z-index: 2147483647;
                      }
                      #${OVERLAY_ID} .yumi-dialog-card {
                        width: min(100%, 360px);
                        background: rgba(255, 255, 255, 0.97);
                        border-radius: 20px;
                        border: 1px solid rgba(148, 163, 184, 0.22);
                        box-shadow: 0 28px 70px rgba(15, 23, 42, 0.34);
                        padding: 18px;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
                        color: #0f172a;
                      }
                      #${OVERLAY_ID} .yumi-dialog-badge {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        min-width: 48px;
                        height: 26px;
                        padding: 0 10px;
                        margin-bottom: 12px;
                        border-radius: 999px;
                        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
                        color: #fff;
                        font-size: 11px;
                        font-weight: 800;
                        letter-spacing: 0.08em;
                        text-transform: uppercase;
                      }
                      #${OVERLAY_ID} h2 {
                        margin: 0 0 10px 0;
                        font-size: 18px;
                        line-height: 1.2;
                        letter-spacing: -0.02em;
                      }
                      #${OVERLAY_ID} p {
                        margin: 0;
                        font-size: 13px;
                        line-height: 1.55;
                        color: #334155;
                        white-space: pre-wrap;
                      }
                      #${OVERLAY_ID} .yumi-dialog-actions {
                        display: flex;
                        gap: 10px;
                        margin-top: 16px;
                      }
                      #${OVERLAY_ID} .yumi-dialog-button {
                        flex: 1;
                        border: none;
                        border-radius: 12px;
                        padding: 10px 12px;
                        font-size: 13px;
                        font-weight: 700;
                        cursor: pointer;
                        background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
                        color: #fff;
                        box-shadow: 0 10px 20px rgba(79, 70, 229, 0.22);
                      }
                    `;
                    document.documentElement.appendChild(style);
                  }
                  document.getElementById(OVERLAY_ID)?.remove();
                  const overlay = document.createElement("div");
                  overlay.id = OVERLAY_ID;
                  overlay.innerHTML = `
                    <div class="yumi-dialog-card">
                      <div class="yumi-dialog-badge">Next</div>
                      <h2>Task ready</h2>
                      <p>Next saved task: ${label}</p>
                      <div class="yumi-dialog-actions">
                        <button type="button" class="yumi-dialog-button">Got it</button>
                      </div>
                    </div>
                  `;
                  overlay.querySelector("button")?.addEventListener("click", () => overlay.remove());
                  document.body.appendChild(overlay);
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
          console.error("Error advancing to next task:", error);
        } finally {
          // Always reset transition flag, even on error
          transitioningToNextTask = false;
        }
      } catch (error) {
        // Ignore injection errors on pages that do not allow scripts.
        transitioningToNextTask = false;
      }

      // Store the session log for later retrieval
      sessionLog.endTime = Date.now();
      sessionLog.startTime = Number(data.startTime || 0);
      await chrome.storage.local.set({ lastSessionLog: sessionLog });

      await chrome.storage.local.set({
        sessionActive: false,
        startTime: null,
        endTime: null,
        currentTask: "",
        focusTabIds: [],
        sessionPaused: false,
        pauseStartedAt: null,
        pausedRemainingMs: null,
        completionPromptActive: false
      });

      // Reset session log for next session
      sessionLog = {
        distractionsSaved: [],
        tabsAddedToFocus: [],
        pauseCount: 0,
        startTime: null,
        endTime: null,
        completionPromptActive: false
      };
    });
}, 1000);