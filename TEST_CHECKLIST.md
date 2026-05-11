# Yumi Focus AI - End-to-End Test Checklist

## Pre-Test Setup
- [ ] Backend running at `http://localhost:3000`
- [ ] Extension loaded in Chrome (chrome://extensions)
- [ ] Browser with multiple tabs open for testing
- [ ] Console open to check for errors (F12)

---

## Test Section 1: Start Focus Session
- [ ] Open extension popup
- [ ] Verify header displays "🎯 Yumi Focus AI" with tagline
- [ ] Enter task name (e.g., "Study Python")
- [ ] Enter focus minutes (default: 25)
- [ ] Click "▶ Select Tab & Start Focus"
- [ ] Verify popup switches to session view
- [ ] Verify timer shows countdown (e.g., "25:00")
- [ ] Verify session status shows task and focus tab count

**Expected Issues to Check:**
- Timer doesn't start → Check backend connection
- Task name is empty but button allows click → Should show alert
- Restricted URL selected → Should show alert before starting

---

## Test Section 2: Tab Warnings (Distraction Detection)
- [ ] While session active, click on a non-focus tab (e.g., social media)
- [ ] Warning popup should appear asking to save, add to focus, or ignore
- [ ] Click "OK" to save as distraction
  - [ ] Popup asks for label (pre-filled with tab suggestion)
  - [ ] Task appears in queue
  - [ ] Auto-switch back to focus tab
- [ ] Switch to another distraction tab
  - [ ] Warning appears again
  - [ ] Click "Cancel" → "Would you like to add this tab to focus?" prompt
  - [ ] Click "OK" to add to focus
  - [ ] Tab ID should be added to focusTabIds
  - [ ] No auto-switch happens (user stays on tab)

**Expected Issues to Check:**
- Warning doesn't appear on tab switch → Check `onActivated` listener
- Warning appears even on focus tab → Check focusTabIds list
- Auto-switch doesn't work → Check tab.update() call

---

## Test Section 3: New Tab Creation Warning
- [ ] While session active, open a new tab (Ctrl+T)
- [ ] Warning should appear within 100ms
- [ ] Test all three flows (save, add to focus, ignore)

**Expected Issues to Check:**
- Warning doesn't appear on new tab → Check `onCreated` listener timing
- Warning appears on restricted URLs (chrome://, about:) → Should skip
- Delay too long → Check setTimeout value
# issue: warning tab and auto switching doesnt happen if a new tab has been opened. 

---

## Test Section 4: Session Controls
- [ ] **Pause Button:**
  - [ ] Click "⏸ Pause" → Alert shows "Session paused"
  - [ ] Timer shows "PAUSED - 24:30" (or remaining time)
  - [ ] Button text changes to "Resume"
  - [ ] Timer stops counting
  
- [ ] **Resume:**
  - [ ] Click "Resume" → Alert shows "Session resumed"
  - [ ] Timer resumes counting
  - [ ] Button text returns to "Pause"

- [ ] **Adjust Time:**
  - [ ] Enter "+5" → Alert "Added 5 minute(s)"
  - [ ] Timer increases by 5 min
  - [ ] Enter "-3" → Alert "Removed 3 minute(s)"
  - [ ] Timer decreases by 3 min

- [ ] **Add Tab to Focus:**
  - [ ] Click on non-focus tab
  - [ ] See warning popup
  - [ ] Click "Add to focus" option
  - [ ] Tab should be added to focusTabIds
  - [ ] No auto-switch (user stays on tab to confirm)

**Expected Issues to Check:**
- Pause doesn't preserve remaining time → Check pausedRemainingMs storage
- Adjust goes negative → Check Math.max() logic
- Add tab fails on restricted URLs → Should skip

---

## Test Section 5: Queue Management (No Active Session)
- [ ] Close/end session (or open popup when no session active)
- [ ] Click "📌 Saved Tasks" button → Should expand queue panel
- [ ] **Verify queue shows all saved tasks**
- [ ] **For each queue item:**
  - [ ] Label is clickable (text has pointer cursor)
  - [ ] "Open" button visible (or "Open/Find" if no URL)
  - [ ] "Delete" button visible
  
- [ ] **Test queue item with URL:**
  - [ ] Click label or "Open" button
  - [ ] Should navigate to that URL or create tab if closed
  
- [ ] **Test queue item without URL (e.g., "Write notes"):**
  - [ ] Click "Open/Find" button
  - [ ] Confirm dialog: "No open tab found. Open search?" 
  - [ ] Click OK → Google search tab opens
  - [ ] Queue item is updated with search URL for future opens
  - [ ] Click Cancel → Item stays saved without URL

- [ ] **Delete queue item:**
  - [ ] Click "Delete" button
  - [ ] Item removed from queue
  - [ ] Queue re-renders without item

**Expected Issues to Check:**
- Queue items not clickable when session inactive → Check sessionActive flag in renderQueue
- "Open/Find" button doesn't prompt for search → Check confirm() dialog
- Search URL not updated → Check queue storage update after creating tab

---

## Test Section 6: Save Distraction Task During Session
- [ ] While session active, click distraction tab
- [ ] Click "Save for later" in warning → Enter label
- [ ] Item appears in queue (need to expand queue toggle)
- [ ] After task completes, verify item is in queue
- [ ] Verify "Save for later" input field in queue panel has placeholder

**Expected Issues to Check:**
- Task doesn't appear in queue → Check addQueueItem() storage
- Input field shows old placeholder → Check HTML update
- Task saved during session but queue not visible → Toggle button needed to expand

---

## Test Section 7: Task Done - Continue vs Move Flow
- [ ] Start a short session (e.g., 1 minute)
- [ ] Wait for timer to complete (or manually click Task Done before completion)
- [ ] **Congrats popup should appear** with choice:
  - [ ] Click "OK" → Restart session for same task
    - [ ] Timer resets to original duration
    - [ ] Session continues
    - [ ] No summary shown
  
  - [ ] Click "Cancel" → Move to next saved task
    - [ ] Session ends
    - [ ] Summary popup appears
    - [ ] Summary shows AI-generated insights
    - [ ] After closing summary, advances to next queue item

- [ ] **Test with no queued tasks:**
  - [ ] After summary, should just end (no queue advance)

**Expected Issues to Check:**
- Congrats popup shows summary inline → Should be separate popup
- Continue option doesn't restart timer → Check Date.now() + duration
- Summary doesn't show → Check fetch to /summary endpoint
- Auto-advance to queue doesn't trigger → Check promptNextQueuedTask()

---

## Test Section 8: Task Done from UI Button (Not Timer)
- [ ] Start session
- [ ] Click "✅ Task Done" button (before timer completes)
- [ ] Same flow as Test 7 should occur
- [ ] Verify summary popup appears
- [ ] Verify continue/move choice is presented

**Expected Issues to Check:**
- Button shows summary in popup section → Should be full-screen alert
- Summary doesn't fetch → Check /summary endpoint
- Move to next doesn't work → Check promptNextQueuedTask()
# issue: doesnt move to next task after clicking 'task done'
---

## Test Section 9: Summary Displays
- [ ] Complete session and trigger summary
- [ ] Verify popup shows:
  - [ ] Session summary (AI-generated or fallback)
  - [ ] Next step recommendation
- [ ] Click "Got it! Next →" button
- [ ] Should advance to next queue item or close

**Expected Issues to Check:**
- Summary text is empty → Check backend /summary endpoint
- Next step missing → Check response parsing
- Button doesn't close/advance → Check promptNextQueuedTask()

---

## Test Section 10: Stale Task Warning Fix (Queue Advance)
- [ ] Start session with task "Task A"
- [ ] Complete session and choose "Move to next task"
- [ ] Switch to the next task tab
- [ ] **No warning should appear** for "Task A"
- [ ] Verify transitioningToNextTask flag prevents warning
- [ ] Warning should work normally for OTHER tabs during the new session

**Expected Issues to Check:**
- Stale warning still appears → Check transitioningToNextTask flag logic
- Warning skipped entirely during session → transitioningToNextTask should only skip during transition

---

## Test Section 11: Saved Task Smart Matching
- [ ] Open tab: "GitHub - My Repo"
- [ ] Save task: "Push code"
- [ ] Verify saved notification: "linked it to: GitHub - My Repo"
- [ ] Close GitHub tab
- [ ] Reopen queue, click "Open" for "Push code"
- [ ] Should open/navigate to GitHub

- [ ] Save task: "Write meeting notes" (no matching tab)
- [ ] Confirm dialog: "No open tab found"
- [ ] Click "OK" → Google search opens
- [ ] Verify queue shows task linked to Google search URL

**Expected Issues to Check:**
- Matching fails despite tab title matching → Check case-insensitive comparison
- Search URL doesn't update queue → Check queue storage after creation
- Confirm dialog doesn't appear → Check confirm() implementation
# issue: when i saved a task (no url) similar to an opened tab(ex. github tab is opened, 'push code' is the saved task), it doesnt match it to the opened tab. 
---

## Test Section 12: Storage & Persistence
- [ ] Start session
- [ ] Close and reopen popup
- [ ] Session should persist (timer still running)
- [ ] Queue should persist across popup opens/closes
- [ ] Paused state should persist

**Expected Issues to Check:**
- Storage not loading on popup reopen → Check chrome.storage.local.get()
- Timer jumps forward/backward → Check Date.now() vs stored endTime

---

## Test Section 13: Keyboard & Input Validation
- [ ] Try starting session with empty task name
  - [ ] Should show alert
  - [ ] Session doesn't start
  
- [ ] Try starting with focused-on restricted URL (chrome://)
  - [ ] Should show alert
  - [ ] Session doesn't start

- [ ] Adjust time with non-numeric input
  - [ ] Should handle gracefully or show error

**Expected Issues to Check:**
- Empty task allowed → Check trim() and validation
- Restricted URL not caught → Check isRestrictedUrl() function

---

## Test Section 14: Console Errors
- [ ] Open Chrome DevTools (F12)
- [ ] Repeat all tests while watching console
- [ ] No red errors should appear
- [ ] Warnings/info messages only

**Expected Issues to Check:**
- Content script injection errors → Check target page allows scripts
- Storage access errors → Check permissions in manifest
- Network errors → Check /check and /summary endpoint calls

---

## Test Section 15: Visual/UX Checks
- [ ] Verify header displays with gradient and tagline
- [ ] All buttons have proper hover states
- [ ] Form inputs have focus outlines (blue glow)
- [ ] Timer is prominently visible
- [ ] Sections have clear separation (cards with borders)
- [ ] Colors are consistent (purple, green, gold)
- [ ] Text is readable on all backgrounds
- [ ] Button text has emoji for context

**Expected Issues to Check:**
- Elements overlap → Check CSS margins/padding
- Colors clash → Compare against design palette
- Text too small → Check font-size values
- Hover states don't work → Check CSS :hover rules

---

## Issues Found Summary
[To be filled after testing]

1. **Issue:** 
   - **Severity:** (High/Medium/Low)
   - **Expected Behavior:** 
   - **Actual Behavior:** 
   - **Steps to Reproduce:** 
   - **Workaround:** (if any)

---

## Sign-Off
- **Tester:** [Your Name]
- **Date:** April 30, 2026
- **Overall Status:** ✅ / ⚠️ / ❌
