# Yumi Focus AI - Runtime Issues Report

**Report Generated:** April 30, 2026  
**Status:** Pre-Testing Code Review  

---

## Critical Issues (Must Fix)

### 1. **Summary URL Update in Queue Items**
**File:** [popup.js](popup.js#L135)  
**Severity:** MEDIUM  
**Issue:** When `openOrFocusTabForQueueItem()` creates a new search tab for an item without a URL, it tries to update the queue, but the search logic uses `findIndex()` on label matching. If the item doesn't have an exact label match in queue after being normalized, the update may fail silently.

**Code:**
```javascript
const idx = queue.findIndex((q) => (normalizeQueueItem(q).label || "") === (queueItem.label || ""));
```

**Problem:** If queue item is stored differently (e.g., with different spaces or capitalization), this won't find it.

**Fix:** Use a more robust match:
```javascript
const idx = queue.findIndex((q) => {
  const normalized = normalizeQueueItem(q);
  return normalized.label.toLowerCase().trim() === queueItem.label.toLowerCase().trim();
});
```

**Test:** Save "write notes", click "Open/Find", allow search, verify queue item now has search URL.

---

### 2. **Task Done Continue Button Restarts but Should Keep Paused State**
**File:** [popup.js](popup.js#L340)  
**Severity:** LOW  
**Issue:** When user clicks "Task Done" and chooses "Continue", the code restarts the session with fresh `startTime` and `endTime`. However, if the session was paused, the new session won't preserve that paused state.

**Code:**
```javascript
await chrome.storage.local.set({
  startTime: now,
  endTime: newEnd,
  sessionActive: true,
  sessionPaused: false,  // <-- Always false
  completionPromptActive: false
});
```

**Expected Behavior:** If user paused before clicking Done, the new session should probably resume (not stay paused), which is correct. But should confirm with user.

**Status:** Actually OK for MVP. User can pause after continue if needed.

---

### 3. **Missing Error Handling on Backend Fetch Failures**
**File:** [popup.js](popup.js#L370), [background.js](background.js#L320)  
**Severity:** MEDIUM  
**Issue:** When `/summary` endpoint is unreachable or returns an error, the code silently falls back. During the "Task Done" flow, if summary fails, it calls `promptNextQueuedTask()` with no user notification.

**Current Code:**
```javascript
let summaryShown = false;
let summaryData = null;
try {
  const summaryResponse = await fetch(...)
  if (summaryResponse.ok) {
    summaryData = await summaryResponse.json();
    summaryShown = true;
  }
} catch (error) {
  console.warn("Failed to fetch summary:", error);
}
// ... later ...
if (!summaryShown) {
  await promptNextQueuedTask();  // <-- No alert about missing summary
}
```

**Fix:** Show alert when summary fails:
```javascript
if (!summaryShown) {
  alert("⚠️ Could not fetch summary. Proceeding to next task...");
  await promptNextQueuedTask();
}
```

**Test:** Stop backend, complete session, verify alert appears.

---

### 4. **Timer Display Not Updating When Session Ends**
**File:** [popup.js](popup.js#L172)  
**Severity:** LOW  
**Issue:** The timer display updates every 500ms only if `sessionActive` is true. When the session completes and `sessionActive` is set to false in `background.js`, the popup may still show the old timer value until the next refresh.

**Current Code:**
```javascript
if (!data.sessionActive || !data.endTime) {
  clearInterval(timerInterval);
  timerDisplay.textContent = "";  // <-- Clears but popup might not see it immediately
  return;
}
```

**Expected:** After timer completes, popup should immediately clear timer or show "Session Complete".

**Fix:** Add a storage listener that clears timer on session completion:
Already implemented in storage listener around line 540, should be fine.

**Status:** Low priority, mostly UI polish.

---

## Medium Issues (Should Fix Before Release)

### 5. **New Tab Warning May Appear Delayed**
**File:** [background.js](background.js#L192)  
**Severity:** MEDIUM  
**Issue:** `onCreated` listener has a 100ms setTimeout before showing warning:
```javascript
setTimeout(async () => {
  const updatedTab = await chrome.tabs.get(tab.id).catch(() => null);
  if (!updatedTab) return;
  // ...
}, 100);
```

**Problem:** User may navigate away from new tab before warning appears, making it seem broken.

**Fix:** Reduce timeout to 50ms or remove it:
```javascript
chrome.tabs.onCreated.addListener(async (tab) => {
  // No delay, process immediately
  // ...
});
```

**Test:** Open new tab during session, warning should appear within 50ms.

---

### 6. **Transition Flag Not Reset on Error**
**File:** [background.js](background.js#L399)  
**Severity:** MEDIUM  
**Issue:** The `transitioningToNextTask` flag is set to true before tab switch, but if an error occurs or content script injection fails, it's reset in the catch block. However, there's a 100ms window where warnings are skipped even if tab switch fails.

**Code:**
```javascript
transitioningToNextTask = true;
await chrome.storage.local.set({
  currentTask: "",
  focusTabIds: []
});

if (firstItem.label) {
  // ... tab switch logic ...
  await removeQueueItem(0);
  chrome.action.openPopup();
  transitioningToNextTask = false;  // <-- Only here
} 
catch (error) {
  transitioningToNextTask = false;  // <-- And here
}
```

**Problem:** If tab switch fails silently, flag remains true, blocking warnings for next 5+ seconds.

**Fix:** Add timeout or always reset after action:
```javascript
transitioningToNextTask = true;
await chrome.storage.local.set({ currentTask: "", focusTabIds: [] });

try {
  // ... tab switch logic ...
} catch (error) {
  console.error("Failed to switch to next task:", error);
} finally {
  transitioningToNextTask = false;  // Always reset
}
```

**Test:** Start session with queue, disable internet, complete task, verify warnings still work on non-queue tabs.

---

### 7. **Empty Queue Label in Prompt**
**File:** [background.js](background.js#L364)  
**Severity:** LOW  
**Issue:** On timer completion, the code tries to show next queued task label:
```javascript
const firstItem = normalizeQueueItem(queue[0]);
const nextLabel = firstItem.label || "No queued task";
```

**Problem:** If queue is empty, `queue[0]` is `undefined`, `normalizeQueueItem(undefined)` returns `{ label: "", url: "" }`, so `nextLabel` becomes "No queued task". This is actually OK.

**Status:** Not a real issue, just defensive programming.

---

## Low Priority Issues (Nice to Have)

### 8. **Visual: Confirm Dialogs Not Mobile-Friendly**
**Severity:** LOW  
**Issue:** All user confirmations use native `confirm()` and `alert()` dialogs, which are not branded or styled. For a polished UX, could create custom HTML modals.

**Impact:** Works fine for MVP, but for production, consider:
- Custom modal with Yes/No buttons
- Branding consistency
- Better UX on mobile/smaller screens

**Status:** Defer to future polish.

---

### 9. **Accessibility: Missing ARIA Labels**
**Severity:** LOW  
**Issue:** HTML form inputs and buttons don't have ARIA labels for screen readers:
```html
<input id="task" type="text" placeholder="e.g., Spreadsheet update" />
<!-- Missing: <label for="task">... or aria-label="..." -->
```

**Status:** Defer to accessibility improvement phase.

---

### 10. **Performance: No Debouncing on Frequent Tab Switches**
**Severity:** LOW  
**Issue:** `onActivated` listener fires on every tab switch and immediately calls `classifyTabForTask()` with backend fetch. If user rapidly clicks tabs, creates N simultaneous fetch requests.

**Current Code:**
```javascript
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // ... immediately fetches from backend ...
  const classification = await classifyTabForTask(task, tab);
});
```

**Fix:** Add debouncing to prevent rapid-fire requests. For MVP, acceptable.

**Status:** Low priority, works fine for current usage.

---

## Data Validation Issues

### 11. **No Max Length on Task Name**
**Severity:** LOW  
**Issue:** User can enter arbitrarily long task names. Storage should handle it, but very long names could break UI.

**Fix:** Add maxLength attribute:
```html
<input id="task" type="text" maxlength="50" ... />
```

---

### 12. **Queue Item Truncation**
**Severity:** LOW  
**Issue:** Long queue item URLs may overflow the queue display. CSS already handles with `word-break: break-word`, but could ellipsis for better UX.

**Fix:** Add CSS:
```css
.queue-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

---

## Browser Compatibility Issues

### 13. **Edge Browser Compatibility**
**Severity:** LOW  
**Issue:** Code checks for `edge://` URLs but Edge may have different behavior for `chrome.tabs.onCreated` or content script injection timing.

**Status:** Should test on Edge, but likely minimal issues.

---

## Summary Table

| # | Issue | Severity | Status | Effort |
|---|-------|----------|--------|--------|
| 1 | Queue URL Update Logic | MEDIUM | FIX NOW | 5 min |
| 2 | Continue Session State | LOW | OK | - |
| 3 | Missing Summary Error Alert | MEDIUM | FIX NOW | 2 min |
| 4 | Timer Display Delay | LOW | OK | - |
| 5 | New Tab Warning Delay | MEDIUM | FIX | 5 min |
| 6 | Transition Flag Not Reset | MEDIUM | FIX | 5 min |
| 7 | Empty Queue Label | LOW | OK | - |
| 8 | Custom Modals | LOW | DEFER | 1 hr |
| 9 | ARIA Labels | LOW | DEFER | 30 min |
| 10 | Tab Switch Debouncing | LOW | DEFER | 30 min |
| 11 | Task Name Length | LOW | DEFER | 2 min |
| 12 | Queue URL Ellipsis | LOW | DEFER | 2 min |
| 13 | Edge Compatibility | LOW | DEFER | TBD |

---

## Recommended Actions Before Release

### Immediate (Before Testing)
1. ✅ Fix queue URL update logic (Issue #1)
2. ✅ Add error alert for missing summary (Issue #3)
3. ✅ Reduce new tab warning delay (Issue #5)
4. ✅ Fix transition flag timeout (Issue #6)

### After Testing
5. Add task name maxlength attribute
6. Improve queue item URL display with ellipsis
7. Document known limitations (Edge, custom modals)

---

## Files Affected
- `extension/popup.js` - Issues 1, 3, 4
- `extension/background.js` - Issues 5, 6
- `extension/popup.html` - Issue 11
- `extension/styles.css` - Issue 12

---

**Next Steps:**
1. Apply fixes for Issues #1, #3, #5, #6
2. Run full test checklist from TEST_CHECKLIST.md
3. Report user-facing bugs and UX issues
4. Defer cosmetic/accessibility improvements to v2.0
