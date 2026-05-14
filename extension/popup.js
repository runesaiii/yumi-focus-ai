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
const queueSection = document.querySelector(".queue-section");
const searchToggleBtn = document.getElementById("searchToggleBtn");
const searchPanel = document.getElementById("searchPanel");
const searchSection = document.querySelector(".search-section");
const searchBtn = document.getElementById("searchBtn");
const searchQuery = document.getElementById("searchQuery");
const searchResults = document.getElementById("searchResults");
const resultsList = document.getElementById("resultsList");
const dialogOverlay = document.getElementById("dialogOverlay");
const dialogBadge = document.getElementById("dialogBadge");
const dialogTitle = document.getElementById("dialogTitle");
const dialogMessage = document.getElementById("dialogMessage");
const dialogInput = document.getElementById("dialogInput");
const dialogActions = document.getElementById("dialogActions");
const aiConsentBtn = document.getElementById("aiConsentBtn");
const BACKEND_BASE_URL = "https://yumi-focus-ai.azurewebsites.net";
const BACKEND_CHECK_URL = `${BACKEND_BASE_URL}/check`;
const BACKEND_SEARCH_URL = `${BACKEND_BASE_URL}/search`;

let timerInterval = null;
let dialogResolver = null;
let searchCollapseTimeoutId = null;

function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  };
  return String(text).replace(/[&<>"']/g, (char) => map[char]);
}

function resetSearchSectionLayout() {
  if (!searchToggleBtn || !searchPanel || !searchSection) return;
  if (!searchPanel.classList.contains("open")) return;

  searchPanel.style.maxHeight = "none";
  searchPanel.style.overflow = "visible";
  searchSection.style.maxHeight = "none";
  searchSection.style.overflow = "visible";
}

function closeDialog(result) {
  if (dialogOverlay) dialogOverlay.style.display = "none";
  dialogActions.innerHTML = "";
  dialogInput.value = "";
  dialogInput.style.display = "none";
  dialogResolver?.(result);
  dialogResolver = null;
}

function showDialog({ badge = "Note", title = "Notice", message = "", buttons = [], inputValue = "", showInput = false } = {}) {
  return new Promise((resolve) => {
    dialogResolver = resolve;
    dialogBadge.textContent = badge;
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogActions.innerHTML = "";
    dialogOverlay.style.display = "flex";

    if (showInput) {
      dialogInput.style.display = "block";
      dialogInput.value = inputValue;
      requestAnimationFrame(() => dialogInput.focus());
    } else {
      dialogInput.style.display = "none";
      dialogInput.value = "";
    }

    buttons.forEach((buttonConfig) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn ${buttonConfig.variant || "btn-secondary"}`;
      button.textContent = buttonConfig.label;
      button.addEventListener("click", () => {
        const value = showInput ? dialogInput.value.trim() : undefined;
        if (showInput && buttonConfig.useInputValue) {
          closeDialog(value);
          return;
        }
        closeDialog(buttonConfig.value !== undefined ? buttonConfig.value : value);
      });
      dialogActions.appendChild(button);
    });

    if (showInput) {
      dialogInput.onkeydown = (event) => {
        if (event.key === "Enter") {
          closeDialog(dialogInput.value.trim());
        } else if (event.key === "Escape") {
          closeDialog(null);
        }
      };
    }
  });
}

async function showAlert(message, title = "Heads up") {
  await showDialog({
    badge: "Info",
    title,
    message,
    buttons: [{ label: "Got it", value: true, variant: "btn-primary" }]
  });
}

async function showConfirm(message, title = "Please confirm") {
  return await showDialog({
    badge: "Action",
    title,
    message,
    buttons: [
      { label: "Cancel", value: false, variant: "btn-secondary" },
      { label: "Continue", value: true, variant: "btn-primary" }
    ]
  });
}

async function showPrompt(message, defaultValue = "", title = "Enter text") {
  return await showDialog({
    badge: "Input",
    title,
    message,
    inputValue: defaultValue,
    showInput: true,
    buttons: [
      { label: "Cancel", value: null, variant: "btn-secondary" },
      { label: "Save", value: true, variant: "btn-primary" }
    ]
  });
}

async function getAiConsent() {
  const data = await chrome.storage.local.get("aiConsent");
  return data.aiConsent || { allowed: false, ts: null };
}

async function setAiConsent(allowed) {
  await chrome.storage.local.set({ aiConsent: { allowed, ts: Date.now() } });
  await updateAiConsentButton();
}

async function updateAiConsentButton() {
  if (!aiConsentBtn) return;
  const consent = await getAiConsent();
  aiConsentBtn.textContent = consent.allowed ? "AI: Enabled" : "AI: Disabled";
  aiConsentBtn.title = consent.allowed
    ? "AI features are enabled. Click to revoke consent."
    : "AI features are disabled. Click to enable consent.";
  aiConsentBtn.classList.toggle("btn-primary", consent.allowed);
  aiConsentBtn.classList.toggle("btn-secondary", !consent.allowed);
}

if (aiConsentBtn) {
  aiConsentBtn.addEventListener("click", async () => {
    const consent = await getAiConsent();
    if (consent.allowed) {
      const revoke = await showConfirm(
        "Revoke AI consent? This will disable AI warnings and summaries until you enable them again.",
        "Disable AI features"
      );
      if (revoke) {
        await setAiConsent(false);
        await showAlert("AI features are now disabled.", "Consent updated");
      }
    } else {
      const enable = await showConfirm(
        "Enable AI features? This will send page titles and site domains (URLs are redacted) to Azure OpenAI for warnings and summaries.",
        "Enable AI features"
      );
      if (enable) {
        await setAiConsent(true);
        await showAlert("AI features are now enabled.", "Consent updated");
      }
    }
  });
}

// Toggle Queued Tasks section visibility
queueToggleBtn.addEventListener("click", () => {
  const panel = distractionSection;
  const btn = queueToggleBtn;
  const container = queueSection;

  // Save original padding on first interaction
  if (panel && !panel.dataset.origPadding) {
    const cs = getComputedStyle(panel);
    panel.dataset.origPadding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
  }

  const isOpen = panel.classList.contains("open");

  if (!isOpen) {
    // Expand
    panel.style.display = "block"; // ensure measurable
    // allow reflow then set max-height to scrollHeight for transition
    requestAnimationFrame(() => {
      panel.style.overflow = "hidden";
      panel.style.maxHeight = panel.scrollHeight + "px";
      panel.style.opacity = "1";
      panel.style.padding = panel.dataset.origPadding || "14px";
      panel.classList.add("open");
      // expand parent container to fit new content and restore margin
      if (container) {
        // ensure measurable
        container.style.overflow = "hidden";
        container.style.maxHeight = container.scrollHeight + panel.scrollHeight + "px";
        container.style.margin = "12px 0";
      }
      btn.classList.add("active");
      btn.textContent = "Hide Queue";
      btn.setAttribute("aria-expanded", "true");
    });
  } else {
    // Collapse: animate to 0 then hide
    panel.style.overflow = "hidden";
    // set current height explicitly to ensure consistent transition start
    panel.style.maxHeight = panel.scrollHeight + "px";
    panel.style.opacity = "1";
    // next frame, transition to zero
    requestAnimationFrame(() => {
      panel.style.maxHeight = "0px";
      panel.style.opacity = "0";
      panel.style.padding = "0px 12px";
      // collapse parent container to just the button height and remove margin
      if (container) {
        container.style.overflow = "hidden";
        container.style.maxHeight = queueToggleBtn.offsetHeight + "px";
        container.style.margin = "0";
      }
    });

    const onTransitionEnd = (e) => {
      if (e.propertyName === "max-height") {
        panel.style.display = "none";
        panel.classList.remove("open");
        panel.style.maxHeight = "";
        panel.style.overflow = "";
        panel.style.padding = "";
        panel.style.opacity = "";
        btn.classList.remove("active");
        btn.textContent = "Queued Tasks";
        btn.setAttribute("aria-expanded", "false");
        // clear container inline styles
        if (container) {
          container.style.maxHeight = "";
          container.style.overflow = "";
          container.style.margin = "";
        }
        panel.removeEventListener("transitionend", onTransitionEnd);
      }
    };

    panel.addEventListener("transitionend", onTransitionEnd);
  }
});

// Toggle Search section visibility
if (searchToggleBtn && searchPanel && searchSection) {
  searchToggleBtn.addEventListener("click", () => {
    const panel = searchPanel;
    const btn = searchToggleBtn;
    const container = searchSection;

    const finishCollapse = () => {
      if (searchCollapseTimeoutId) {
        clearTimeout(searchCollapseTimeoutId);
        searchCollapseTimeoutId = null;
      }
      panel.style.display = "none";
      panel.classList.remove("open");
      panel.style.maxHeight = "";
      panel.style.overflow = "";
      panel.style.padding = "";
      panel.style.opacity = "";
      btn.classList.remove("active");
      btn.textContent = "Search History (Beta)";
      btn.setAttribute("aria-expanded", "false");
      if (container) {
        container.style.maxHeight = "";
        container.style.overflow = "";
        container.style.margin = "";
      }
    };

    if (panel && !panel.dataset.origPadding) {
      const cs = getComputedStyle(panel);
      panel.dataset.origPadding = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
    }

    const isOpen = panel.classList.contains("open");

    if (!isOpen) {
      panel.style.display = "block";
      requestAnimationFrame(() => {
        panel.style.overflow = "hidden";
        panel.style.maxHeight = panel.scrollHeight + "px";
        panel.style.opacity = "1";
        panel.style.padding = panel.dataset.origPadding || "14px";
        panel.classList.add("open");
        if (container) {
          container.style.overflow = "hidden";
          container.style.maxHeight = container.scrollHeight + panel.scrollHeight + "px";
          container.style.margin = "12px 0";
        }
        btn.classList.add("active");
        btn.textContent = "Hide Search";
        btn.setAttribute("aria-expanded", "true");

        window.setTimeout(() => {
          resetSearchSectionLayout();
        }, 340);
      });
    } else {
      panel.style.overflow = "hidden";
      panel.style.maxHeight = panel.scrollHeight + "px";
      panel.style.opacity = "1";
      requestAnimationFrame(() => {
        panel.style.maxHeight = "0px";
        panel.style.opacity = "0";
        panel.style.padding = "0px 12px";
        if (container) {
          container.style.overflow = "hidden";
          container.style.maxHeight = searchToggleBtn.offsetHeight + "px";
          container.style.margin = "0";
        }
      });

      const onTransitionEnd = (e) => {
        if (e.propertyName === "max-height") {
          finishCollapse();
          panel.removeEventListener("transitionend", onTransitionEnd);
        }
      };

      panel.addEventListener("transitionend", onTransitionEnd);

      searchCollapseTimeoutId = window.setTimeout(() => {
        finishCollapse();
        panel.removeEventListener("transitionend", onTransitionEnd);
      }, 420);
    }
  });

  // Handle search button click
  searchBtn.addEventListener("click", async () => {
    const query = searchQuery.value.trim();
    if (!query) {
      await showAlert("Please enter a search term", "Empty search");
      return;
    }

    try {
      searchBtn.disabled = true;
      searchBtn.textContent = "Searching...";

        const stored = await chrome.storage.local.get(["userId"]);
        const userId = stored.userId || "anonymous";

        const response = await fetch(BACKEND_SEARCH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, userId })
        });

      if (!response.ok) {
        await showAlert("Search failed or feature not configured yet (Cosmos DB setup required)", "Search Error");
        searchBtn.disabled = false;
        searchBtn.textContent = "Search";
        return;
      }

      const data = await response.json();
      const results = data.results || [];

      const weeklyEl = document.getElementById("weeklySummary");
      if (results.length === 0) {
        resultsList.innerHTML = "<li style=\"padding: 12px; text-align: center; color: #94a3b8;\">No results found</li>";
        searchResults.style.display = "block";
        if (weeklyEl) { weeklyEl.style.display = "none"; weeklyEl.textContent = ""; }
      } else {
        // Compute a single weekly total for the search query (sum across returned results)
        const weeklyTotal = results.reduce((acc, r) => acc + (Number(r.weeklyTotalMs) || 0), 0);
        if (weeklyEl) {
          if (Number.isFinite(weeklyTotal) && weeklyTotal > 0) {
            weeklyEl.style.display = "block";
            weeklyEl.innerHTML = `<span style=\"color: #7c3aed; font-weight:600;\">📊 Weekly total: ${escapeHtml(formatDuration(weeklyTotal))}</span>`;
          } else {
            weeklyEl.style.display = "none";
            weeklyEl.textContent = "";
          }
        }

        resultsList.innerHTML = results.map(r => `
          <li class="search-result-item">
            <span class="search-result-label">${escapeHtml(r.label || r.task)}</span>
            <div class="search-result-meta">
              <span class="search-result-type">${escapeHtml(r.type || "task")}</span>
              ${r.completedAt ? `<span class="search-result-type">Done: ${escapeHtml(new Date(r.completedAt).toLocaleString())}</span>` : r.timestamp ? `<span class="search-result-type">Done: ${escapeHtml(new Date(r.timestamp).toLocaleString())}</span>` : ""}
              ${Number.isFinite(Number(r.durationMs)) && Number(r.durationMs) > 0 ? `<span class="search-result-type">Duration: ${escapeHtml(formatDuration(r.durationMs))}</span>` : ""}
              ${Number.isFinite(Number(r.tabsAddedCount)) ? `<span class="search-result-type">Focus tabs: ${escapeHtml(String(r.tabsAddedCount))}</span>` : ""}
            </div>
            ${r.url ? `<span class="search-result-type">📍 ${escapeHtml(r.url)}</span>` : ""}
          </li>
        `).join("");
        searchResults.style.display = "block";
      }

      resetSearchSectionLayout();
      searchResults.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (error) {
      await showAlert(`Search failed: ${error.message}`, "Error");
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = "Search";
    }
  });

  // Allow Enter key to search
  searchQuery.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      searchBtn.click();
    }
  });
}

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
    const normalizedExisting = normalizeQueueItem(item);
    return normalizedExisting.label.toLowerCase() === cleanLabel.toLowerCase();
  });

  if (existingIndex !== -1) {
    const existing = normalizeQueueItem(queue[existingIndex]);
    if (!existing.url && cleanUrl) {
      queue[existingIndex] = { label: cleanLabel, url: cleanUrl };
      await chrome.storage.local.set({ queue });
    }
    console.log(`Skipping duplicate queue item: ${cleanLabel}`);
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

async function removeQueueItemByValue(targetItem) {
  const queue = await getQueue();
  const targetLabel = String(targetItem?.label || "").trim();
  const targetUrl = String(targetItem?.url || "").trim();

  const nextQueue = queue.filter((item) => {
    const normalizedItem = normalizeQueueItem(item);
    const labelMatches = normalizedItem.label === targetLabel;
    const urlMatches = !targetUrl || normalizedItem.url === targetUrl;
    return !(labelMatches && urlMatches);
  });

  await chrome.storage.local.set({ queue: nextQueue });
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

async function getTabById(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (error) {
    return null;
  }
}

function scoreTabMatch(task, tab) {
  const text = `${String(tab?.title || "")} ${String(tab?.url || "")}`.toLowerCase();
  const t = String(task || "").toLowerCase().trim();

  const keywordGroups = {
    email: ["gmail", "outlook", "mail", "inbox", "protonmail"],
    "push code": ["github", "gitlab", "bitbucket", "repo", "commit", "pull request"],
    code: ["github", "gitlab", "stack overflow", "vscode", "replit"],
    notes: ["notion", "docs.google", "onenote", "evernote", "notes"],
    meeting: ["calendar", "meet", "zoom", "teams"],
    message: ["slack", "discord", "teams", "chat"]
  };

  let score = 0;
  if (t && text.includes(t)) score += 3;

  for (const [phrase, hints] of Object.entries(keywordGroups)) {
    if (t.includes(phrase)) {
      for (const hint of hints) {
        if (text.includes(hint)) score += 2;
      }
    }
  }

  const taskTokens = t.split(/\s+/).filter((w) => w.length > 2);
  for (const token of taskTokens) {
    if (text.includes(token)) score += 1;
  }

  return score;
}

async function findRelevantOpenTabForTask(taskLabel) {
  const allTabs = await chrome.tabs.query({});
  let bestTab = null;
  let bestScore = 0;

  // Heuristic pass
  for (const tab of allTabs) {
    if (isRestrictedUrl(tab.url)) continue;
    const score = scoreTabMatch(taskLabel, tab);
    if (score > bestScore) {
      bestScore = score;
      bestTab = tab;
    }
  }

  if (bestTab && bestScore >= 2) {
    return bestTab;
  }

  // AI pass (fallback) with parallel requests and timeout
  try {
    const candidates = allTabs
      .filter((tab) => !isRestrictedUrl(tab.url))
      .map((tab) => ({ tab, score: scoreTabMatch(taskLabel, tab) }))
      .filter((entry) => entry.score >= 2)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((entry) => entry.tab);

    if (candidates.length === 0) return bestTab || null;

      const { aiConsent } = await chrome.storage.local.get('aiConsent');
      if (!aiConsent?.allowed) return bestTab || null;

      // Parallelize backend calls with 2-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const promises = candidates.map((tab) =>
        fetch(BACKEND_CHECK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: taskLabel,
            tabTitle: String(tab.title || ""),
            url: String(tab.url || "")
          }),
          signal: controller.signal
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((classification) => (classification?.isRelevant ? tab : null))
          .catch(() => null)
      );

      const results = await Promise.allSettled(promises);
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          controller.abort();
          return result.value;
        }
      }
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
    }
  } catch (error) {
    // Ignore backend failures
  }

  return bestTab || null;
}

async function openOrFocusTabForQueueItem(item) {
  const queueItem = normalizeQueueItem(item);
  const existingTabs = await chrome.tabs.query({});
  const searchLabel = queueItem.label.toLowerCase();
  const searchUrl = queueItem.url.toLowerCase();

  // First pass: exact match by URL or title
  let matchingTab = existingTabs.find((tab) => {
    const title = String(tab.title || "").toLowerCase();
    const url = String(tab.url || "").toLowerCase();
    return (
      (searchUrl && url.startsWith(searchUrl)) ||
      (searchLabel && title.includes(searchLabel)) ||
      (searchLabel && url.includes(searchLabel))
    );
  });

  // Second pass: semantic matching using backend classification (if no exact match and no URL saved)
  if (!matchingTab && !searchUrl && searchLabel) {
    try {
      const { aiConsent } = await chrome.storage.local.get('aiConsent');
      if (aiConsent?.allowed) {
        const tabsToCheck = existingTabs.filter((tab) => !isRestrictedUrl(tab.url));
        if (tabsToCheck.length > 0) {
          // Parallelize backend calls with 2-second timeout
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          try {
            const promises = tabsToCheck.map((tab) =>
              fetch(BACKEND_CHECK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  task: queueItem.label,
                  tabTitle: String(tab.title || ""),
                  url: String(tab.url || "")
                }),
                signal: controller.signal
              })
                .then((r) => (r.ok ? r.json() : null))
                .then((classification) => (classification?.isRelevant ? tab : null))
                .catch(() => null)
            );

            const results = await Promise.allSettled(promises);
            for (const result of results) {
              if (result.status === "fulfilled" && result.value) {
                controller.abort();
                matchingTab = result.value;
                break;
              }
            }
          } finally {
            clearTimeout(timeoutId);
            controller.abort();
          }
        }
      }
    } catch (error) {
      // Silent fail, continue with no semantic match
    }
  }

  if (matchingTab) {
    await chrome.tabs.update(matchingTab.id, { active: true });
    return matchingTab;
  }

  if (queueItem.url && !isRestrictedUrl(queueItem.url)) {
    return await chrome.tabs.create({ url: queueItem.url });
  }

  // No matching tab and no explicit URL: ask the user whether to open a search tab
  const shouldOpen = await showConfirm(
    `No open tab found for "${queueItem.label}".\n\nOpen a search tab for this task?`,
    "Open a tab?"
  );

  if (shouldOpen) {
    const searchUrlNew = `https://www.google.com/search?q=${encodeURIComponent(queueItem.label)}`;

    // Update queue FIRST before creating the tab, to ensure the link is persisted
    try {
      const queue = await getQueue();
      const idx = queue.findIndex((q) => {
        const normalized = normalizeQueueItem(q);
        return normalized.label.toLowerCase().trim() === queueItem.label.toLowerCase().trim();
      });
      if (idx !== -1) {
        queue[idx] = { label: queueItem.label, url: searchUrlNew };
        await chrome.storage.local.set({ queue });
      }
    } catch (e) {
      console.error("Error updating queue with search URL:", e);
    }

    // Now mark this as intentional so background listeners don't interfere
    await chrome.storage.local.set({
      pendingAutoOpenTaskLabel: queueItem.label.toLowerCase(),
      pendingAutoOpenTaskUrl: searchUrlNew
    });

    const newTab = await chrome.tabs.create({ url: searchUrlNew });
    return newTab;
  }

  return null;
}

async function promptNextQueuedTask(skipConfirm = false) {
  const queue = await getQueue();
  const firstItem = normalizeQueueItem(queue[0]);
  const nextLabel = firstItem.label || "No queued task";

  if (!skipConfirm) {
    const shouldContinue = await showConfirm(`Move to next saved task?\nNext: ${nextLabel}`, "Next task");
    if (!shouldContinue) {
      await renderUI();
      return;
    }
  }

  if (firstItem.label) {
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
    await showAlert("Please enter a task before starting focus mode.", "Task required");
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || isRestrictedUrl(tab.url)) {
    await showAlert("Navigate to a website tab first, then start focus mode.", "Pick a tab first");
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

document.getElementById("adjustBtn").addEventListener("click", async () => {
  const changeMinutes = Number.parseInt(adjustMinutesInput.value, 10);
  if (!Number.isFinite(changeMinutes) || changeMinutes === 0) {
    await showAlert("Enter a valid positive or negative number of minutes.", "Invalid adjustment");
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
  await showAlert(`${changeMinutes > 0 ? "Added" : "Removed"} ${Math.abs(changeMinutes)} minute(s).`, "Timer updated");
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
    await showAlert("Session resumed.", "Focus resumed");
  } else {
    const currentEndTime = Number(data.endTime || 0);
    const frozenRemaining = Math.max(0, currentEndTime - Date.now());
    await chrome.storage.local.set({
      sessionPaused: true,
      pauseStartedAt: Date.now(),
      pausedRemainingMs: frozenRemaining
    });
    await showAlert("Session paused. Click Resume to continue.", "Focus paused");
  }

  await renderUI();
  startTimerDisplay();
});

document.getElementById("doneBtn").addEventListener("click", async () => {
  // Make Task Done behave exactly like timer completion by forcing session end timestamp.
  await chrome.storage.local.set({
    endTime: Date.now() - 1,
    sessionPaused: false,
    completionPromptActive: false
  });

  window.close();
});

// Summary close button is no longer used since summary shows as separate popup
// but kept for backwards compatibility
if (document.getElementById("summaryCloseBtn")) {
  document.getElementById("summaryCloseBtn").addEventListener("click", async () => {
    document.getElementById("summarySection").style.display = "none";
    await promptNextQueuedTask();
  });
}

document.getElementById("save").addEventListener("click", async () => {
  const newTask = newTaskInput.value.trim();
  if (!newTask) return;

  // For no-URL tasks: first identify a relevant open tab and ask whether to link it.
  const relevantTab = await findRelevantOpenTabForTask(newTask);

  if (relevantTab?.id) {
    const shouldLink = await showConfirm(
      `I found a relevant open tab for "${newTask}":\n${relevantTab.title || relevantTab.url}\n\nDo you want to link this tab to the saved task?`,
      "Link tab?"
    );

    if (shouldLink) {
      await addQueueItem(newTask, String(relevantTab.url || ""));
      await showAlert(`Saved "${newTask}" and linked it to: ${relevantTab.title || relevantTab.url}`, "Saved");
    } else {
      await addQueueItem(newTask, "");
      await showAlert(`Saved "${newTask}" without a linked tab.`, "Saved");
    }
  } else {
    const shouldOpenTab = await showConfirm(
      `No relevant open tab found for "${newTask}".\n\nWould you like me to open a tab for this task and link it?`,
      "Open a tab?"
    );

    if (shouldOpenTab) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(newTask)}`;

      // Persist the queue link before opening the new tab so the popup closing does not lose it.
      await addQueueItem(newTask, searchUrl);

      await chrome.storage.local.set({
        pendingAutoOpenTaskLabel: newTask.toLowerCase(),
        pendingAutoOpenTaskUrl: searchUrl,
        intentionallyLinkedTaskLabel: newTask.toLowerCase()
      });

      const createdTab = await chrome.tabs.create({ url: searchUrl });
      await chrome.storage.local.set({ pendingAutoLinkTabId: createdTab?.id || null });
      await showAlert(`Opened and linked a new tab for "${newTask}".`, "Saved");
    } else {
      await addQueueItem(newTask, "");
      await showAlert(`Saved "${newTask}" without a link.`, "Saved");
    }
  }

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
  const data = await chrome.storage.local.get(["sessionActive"]);
  const sessionActive = Boolean(data.sessionActive);

  // Deduplicate existing stored queue items and self-heal storage.
  const seen = new Set();
  const dedupedQueue = [];
  for (const raw of queue) {
    const item = normalizeQueueItem(raw);
    if (!item.label) continue;
    const key = item.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedQueue.push(item);
  }

  if (dedupedQueue.length !== queue.length) {
    await chrome.storage.local.set({ queue: dedupedQueue });
  }

  dedupedQueue.forEach((item) => {
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

    if (!sessionActive) {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.textContent = item.url ? "Open" : "Open/Find";
      openBtn.addEventListener("click", async () => {
        const openedTab = await openOrFocusTabForQueueItem(item);
        if (openedTab) {
          await removeQueueItemByValue(item);
        }
        await renderQueue();
      });

      text.style.cursor = "pointer";
      text.addEventListener("click", async () => {
        const openedTab = await openOrFocusTabForQueueItem(item);
        if (openedTab) {
          await removeQueueItemByValue(item);
        }
        await renderQueue();
      });

      li.appendChild(text);
      li.appendChild(openBtn);
      li.appendChild(delButton);
    } else {
      li.appendChild(text);
      li.appendChild(delButton);
    }

    list.appendChild(li);
  });
}

// Ensure user consent for AI features on first run
(async function ensureAiConsent() {
  try {
    const { aiConsent } = await chrome.storage.local.get('aiConsent');
    if (aiConsent === undefined) {
      const message = 'Enable AI features? This will send page titles and site domains (URLs are redacted) to an external AI service (Azure OpenAI) to generate relevance warnings and session summaries.';
      const accepted = await showConfirm(message, 'Enable AI features');
      await chrome.storage.local.set({ aiConsent: { allowed: Boolean(accepted), ts: Date.now() } });
    }
    await updateAiConsentButton();
  } catch (e) {
    // ignore storage errors
  }
})();

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
