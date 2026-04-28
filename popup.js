const NEW_TAB_INTERVAL_MINUTES = 25;

const state = {
  selectedTabs: [],
  running: false,
  paused: false,
  currentIndex: -1,
  currentStartedAt: null,
  currentEndsAt: null,
  pausedRemainingMs: null,
  completedInCycle: 0,
  notifyOnSwitch: true,
  theme: "light",
  mode: "focus",
  breakEnabled: false,
  defaultBreakMinutes: 5,
  usageStats: {}
};

const elements = {
  statusText: document.querySelector("#statusText"),
  activeTabTitle: document.querySelector("#activeTabTitle"),
  countdownTime: document.querySelector("#countdownTime"),
  countdownProgress: document.querySelector("#countdownProgress"),
  cycleText: document.querySelector("#cycleText"),
  startButton: document.querySelector("#startButton"),
  pauseButton: document.querySelector("#pauseButton"),
  stopButton: document.querySelector("#stopButton"),
  switchNowButton: document.querySelector("#switchNowButton"),
  themeToggle: document.querySelector("#themeToggle"),
  refreshTabs: document.querySelector("#refreshTabs"),
  notifyOnSwitch: document.querySelector("#notifyOnSwitch"),
  breakEnabled: document.querySelector("#breakEnabled"),
  defaultBreakMinutes: document.querySelector("#defaultBreakMinutes"),
  todayTotal: document.querySelector("#todayTotal"),
  todayMetric: document.querySelector("#todayMetric"),
  weekMetric: document.querySelector("#weekMetric"),
  sessionMetric: document.querySelector("#sessionMetric"),
  clearStatsButton: document.querySelector("#clearStatsButton"),
  heatmap: document.querySelector("#heatmap"),
  breakdownDate: document.querySelector("#breakdownDate"),
  breakdownTotal: document.querySelector("#breakdownTotal"),
  tabBreakdown: document.querySelector("#tabBreakdown"),
  selectedTabs: document.querySelector("#selectedTabs"),
  openTabs: document.querySelector("#openTabs"),
  selectedCount: document.querySelector("#selectedCount"),
  openCount: document.querySelector("#openCount")
};

let openTabs = [];
let countdownTimer = null;
let draggedTabId = null;
let selectedStatsDate = getDayKey();

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function getValidInterval(value, fallback = NEW_TAB_INTERVAL_MINUTES) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) return Number(fallback) || NEW_TAB_INTERVAL_MINUTES;
  return Math.max(interval, 0.5);
}

function normalizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || "Untitled tab",
    url: tab.url || "",
    intervalMinutes: getValidInterval(tab.intervalMinutes),
    breakMinutes: getValidBreak(tab.breakMinutes)
  };
}

function dedupeTabs(tabs) {
  const seen = new Set();
  return (tabs || []).filter((tab) => {
    if (!tab || typeof tab.id !== "number" || seen.has(tab.id)) return false;
    seen.add(tab.id);
    tab.intervalMinutes = getValidInterval(tab.intervalMinutes);
    tab.breakMinutes = getValidBreak(tab.breakMinutes);
    return true;
  });
}

function mergeState(nextState) {
  Object.assign(state, nextState);
  state.selectedTabs = dedupeTabs(state.selectedTabs);
  elements.notifyOnSwitch.checked = state.notifyOnSwitch !== false;
  elements.breakEnabled.checked = Boolean(state.breakEnabled);
  elements.defaultBreakMinutes.value = getValidInterval(state.defaultBreakMinutes, 5);
  elements.defaultBreakMinutes.disabled = !state.breakEnabled;
  applyTheme(state.theme);
  render();
}

function getValidBreak(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval)) return 0;
  if (interval <= 0) return 0;
  return Math.max(interval, 0.5);
}

function applyTheme(theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  state.theme = normalizedTheme;
  document.documentElement.dataset.theme = normalizedTheme;
  elements.themeToggle.textContent = normalizedTheme === "dark" ? "L" : "D";
  elements.themeToggle.title = normalizedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  elements.themeToggle.setAttribute("aria-label", elements.themeToggle.title);
}

function isSelected(tabId) {
  return state.selectedTabs.some((tab) => tab.id === tabId);
}

function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getDayKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatMinutes(ms) {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function getDayStats(dayKey) {
  return state.usageStats?.[dayKey] || { totalMs: 0, tabs: {} };
}

function getLastDays(count) {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => addDays(today, index - count + 1));
}

function getHeatLevel(totalMs, maxMs) {
  if (totalMs <= 0 || maxMs <= 0) return 0;
  const ratio = totalMs / maxMs;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

function getCountdown() {
  const activeTab = state.selectedTabs[state.currentIndex];
  const isBreak = state.mode === "break";
  if (state.paused && state.pausedRemainingMs !== null && activeTab) {
    const totalMinutes = isBreak
      ? getBreakMinutesForTab(activeTab)
      : activeTab.intervalMinutes;
    const total = Math.max(1, totalMinutes * 60 * 1000);
    const remaining = Math.max(0, state.pausedRemainingMs);
    return {
      remainingSeconds: remaining / 1000,
      progress: Math.min(100, Math.max(0, ((total - remaining) / total) * 100))
    };
  }

  if (!state.running || !state.currentEndsAt || !state.currentStartedAt) {
    return { remainingSeconds: 0, progress: 0 };
  }

  const now = Date.now();
  const total = Math.max(1, state.currentEndsAt - state.currentStartedAt);
  const remaining = Math.max(0, state.currentEndsAt - now);
  return {
    remainingSeconds: remaining / 1000,
    progress: Math.min(100, Math.max(0, ((total - remaining) / total) * 100))
  };
}

function updateCountdown() {
  const activeTab = state.selectedTabs[state.currentIndex];
  const countdown = getCountdown();
  const isActive = Boolean(activeTab && (state.running || state.paused));

  elements.activeTabTitle.textContent = isActive
    ? state.mode === "break"
      ? `Break before next tab`
      : activeTab.title || "Untitled tab"
    : "Nothing running";
  elements.countdownTime.textContent = isActive
    ? formatDuration(countdown.remainingSeconds)
    : "--:--";
  elements.countdownTime.setAttribute("datetime", `PT${Math.ceil(countdown.remainingSeconds)}S`);
  elements.countdownProgress.style.width = `${countdown.progress}%`;
  elements.cycleText.textContent = `${Math.min(state.completedInCycle || 0, state.selectedTabs.length)} / ${state.selectedTabs.length} completed`;

  document.querySelectorAll("[data-progress-for]").forEach((row) => {
    const rowIsActive = Number(row.dataset.progressFor) === activeTab?.id && isActive;
    row.classList.toggle("active", rowIsActive);
    row.style.setProperty("--row-progress", rowIsActive ? `${countdown.progress}%` : "0%");
  });
}

function makeDragHandle() {
  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "::";
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-hidden", "true");
  return handle;
}

function makeTabItem(tab, actionLabel, actionTitle, onClick, options = {}) {
  const item = document.createElement("div");
  item.className = "tab-item";
  if (options.progress) {
    item.classList.add("progress-item");
    item.dataset.progressFor = tab.id;
  }

  if (options.draggable) {
    item.draggable = true;
    item.dataset.tabId = tab.id;
    item.addEventListener("dragstart", (event) => {
      draggedTabId = tab.id;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(tab.id));
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      reorderSelectedTabs(draggedTabId, tab.id);
      draggedTabId = null;
    });
    item.append(makeDragHandle());
  }

  const meta = document.createElement("div");
  meta.className = "tab-meta";

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title || "Untitled tab";

  const url = document.createElement("span");
  url.className = "tab-url";
  url.textContent = tab.url || "Chrome page";

  const button = document.createElement("button");
  button.className = "tab-action";
  button.type = "button";
  button.textContent = actionLabel;
  button.title = actionTitle;
  button.setAttribute("aria-label", actionTitle);
  button.disabled = Boolean(options.disabled);
  button.addEventListener("click", onClick);

  meta.append(title, url);
  item.append(meta);

  if (options.timerInput) {
    const timerWrap = document.createElement("div");
    timerWrap.className = "tab-timers";

    const focusLabel = document.createElement("label");
    focusLabel.className = "tab-timer";
    focusLabel.textContent = "Focus";

    const timerInput = document.createElement("input");
    timerInput.type = "number";
    timerInput.min = "0.5";
    timerInput.step = "0.5";
    timerInput.value = tab.intervalMinutes;
    timerInput.title = "Timer for this tab";
    timerInput.addEventListener("change", () => updateTabInterval(tab.id, timerInput.value));

    const breakLabel = document.createElement("label");
    breakLabel.className = "tab-timer";
    breakLabel.textContent = "Break";

    const breakInput = document.createElement("input");
    breakInput.type = "number";
    breakInput.min = "0";
    breakInput.step = "0.5";
    breakInput.value = tab.breakMinutes;
    breakInput.title = "Break after this tab. Use 0 for default/no custom break.";
    breakInput.addEventListener("change", () => updateTabBreak(tab.id, breakInput.value));

    focusLabel.append(timerInput);
    breakLabel.append(breakInput);
    timerWrap.append(focusLabel, breakLabel);
    item.append(timerWrap);
  }

  item.append(button);
  return item;
}

function renderTabList(container, emptyText, tabs, itemFactory) {
  container.replaceChildren();
  container.classList.toggle("empty", tabs.length === 0);

  if (tabs.length === 0) {
    container.textContent = emptyText;
    return;
  }

  for (const tab of tabs) {
    container.append(itemFactory(tab));
  }
}

function render() {
  const activeTab = state.selectedTabs[state.currentIndex];
  if ((state.running || state.paused) && activeTab && state.mode === "break") {
    elements.statusText.textContent = state.paused ? "Break paused" : `Break: ${getBreakMinutesForTab(activeTab)} min`;
  } else if (state.running && activeTab) {
    elements.statusText.textContent = `Running: ${activeTab.intervalMinutes} min`;
  } else if (state.paused && activeTab) {
    elements.statusText.textContent = "Paused with time saved";
  } else {
    elements.statusText.textContent = "Paused";
  }

  elements.startButton.disabled = state.selectedTabs.length === 0 || state.running;
  elements.pauseButton.disabled = state.selectedTabs.length === 0 || (!state.running && !state.paused);
  elements.pauseButton.textContent = state.paused ? "Resume" : "Pause";
  elements.stopButton.disabled = !state.running && !state.paused;
  elements.switchNowButton.disabled = state.selectedTabs.length === 0;
  elements.selectedCount.textContent = state.selectedTabs.length;
  elements.openCount.textContent = openTabs.length;

  renderTabList(
    elements.selectedTabs,
    "No tabs added yet.",
    state.selectedTabs,
    (tab) => makeTabItem(tab, "x", "Remove from loop", () => removeTab(tab.id), {
      progress: true,
      timerInput: true,
      draggable: true
    })
  );

  renderTabList(
    elements.openTabs,
    "No open tabs found.",
    openTabs,
    (tab) => makeTabItem(
      tab,
      isSelected(tab.id) ? "OK" : "+",
      isSelected(tab.id) ? "Already in loop" : "Add to loop",
      () => addTab(tab),
      { disabled: isSelected(tab.id) }
    )
  );

  updateCountdown();
  renderAnalytics();
}

function renderAnalytics() {
  const todayKey = getDayKey();
  const days = getLastDays(35);
  const todayStats = getDayStats(todayKey);
  const weekStats = getLastDays(7).map((date) => getDayStats(getDayKey(date)));
  const weekTotal = weekStats.reduce((sum, day) => sum + (Number(day.totalMs) || 0), 0);
  const sessions = weekStats.reduce((sum, day) => (
    sum + Object.values(day.tabs || {}).reduce((tabSum, tab) => tabSum + (Number(tab.sessions) || 0), 0)
  ), 0);
  const maxMs = Math.max(...days.map((date) => Number(getDayStats(getDayKey(date)).totalMs) || 0), 0);

  elements.todayTotal.textContent = formatMinutes(todayStats.totalMs || 0);
  elements.todayMetric.textContent = formatMinutes(todayStats.totalMs || 0);
  elements.weekMetric.textContent = formatMinutes(weekTotal);
  elements.sessionMetric.textContent = String(sessions);

  elements.heatmap.replaceChildren();
  for (const date of days) {
    const dayKey = getDayKey(date);
    const totalMs = Number(getDayStats(dayKey).totalMs) || 0;
    const cell = document.createElement("button");
    cell.className = "heat-cell";
    cell.type = "button";
    cell.dataset.level = String(getHeatLevel(totalMs, maxMs));
    cell.classList.toggle("selected", dayKey === selectedStatsDate);
    cell.title = `${dayKey}: ${formatMinutes(totalMs)}`;
    cell.setAttribute("aria-label", cell.title);
    cell.addEventListener("click", () => {
      selectedStatsDate = dayKey;
      renderAnalytics();
    });
    elements.heatmap.append(cell);
  }

  renderBreakdown(selectedStatsDate);
}

function renderBreakdown(dayKey) {
  const dayStats = getDayStats(dayKey);
  const tabStats = Object.values(dayStats.tabs || {})
    .sort((a, b) => (Number(b.totalMs) || 0) - (Number(a.totalMs) || 0));
  const visibleTabs = tabStats.slice(0, 4);
  const otherTabs = tabStats.slice(4);
  const otherTotalMs = otherTabs.reduce((sum, tab) => sum + (Number(tab.totalMs) || 0), 0);
  const otherSessions = otherTabs.reduce((sum, tab) => sum + (Number(tab.sessions) || 0), 0);
  const displayTabs = otherTabs.length > 0
    ? [
      ...visibleTabs,
      {
        title: "Other",
        totalMs: otherTotalMs,
        sessions: otherSessions
      }
    ]
    : visibleTabs;

  elements.breakdownDate.textContent = dayKey === getDayKey() ? "Today" : dayKey;
  elements.breakdownTotal.textContent = `${formatMinutes(dayStats.totalMs || 0)} total`;
  elements.tabBreakdown.replaceChildren();
  elements.tabBreakdown.classList.toggle("empty", tabStats.length === 0);

  if (tabStats.length === 0) {
    elements.tabBreakdown.textContent = (dayStats.totalMs || 0) > 0
      ? "Tab listings cleared for this day."
      : "No focus time recorded yet.";
    return;
  }

  const maxMs = Math.max(...displayTabs.map((tab) => Number(tab.totalMs) || 0), 1);
  for (const tab of displayTabs) {
    const row = document.createElement("div");
    row.className = "breakdown-item";

    const meta = document.createElement("div");
    meta.className = "breakdown-meta";

    const title = document.createElement("span");
    title.textContent = tab.title || "Untitled tab";

    const detail = document.createElement("small");
    detail.textContent = tab.title === "Other"
      ? `${formatMinutes(tab.totalMs || 0)} across ${tab.sessions || 0} smaller entries`
      : `${formatMinutes(tab.totalMs || 0)} across ${tab.sessions || 0} sessions`;

    const bar = document.createElement("span");
    bar.className = "breakdown-bar";
    bar.style.width = `${Math.max(8, ((Number(tab.totalMs) || 0) / maxMs) * 100)}%`;

    meta.append(title, detail);
    row.append(meta, bar);
    elements.tabBreakdown.append(row);
  }
}

async function loadState() {
  const response = await sendMessage({ type: "getState" });
  if (response?.ok) mergeState(response.state);
}

async function loadOpenTabs() {
  const tabs = await chrome.tabs.query({});
  openTabs = tabs
    .filter((tab) => typeof tab.id === "number" && !tab.url?.startsWith("chrome-extension://"))
    .map(normalizeTab);
  render();
}

async function persistState(extra = {}, options = {}) {
  const nextState = {
    ...state,
    ...extra,
    selectedTabs: dedupeTabs(extra.selectedTabs || state.selectedTabs)
  };
  const type = options.reschedule === false ? "updateState" : "saveState";
  const response = await sendMessage({ type, state: nextState });
  if (response?.ok) mergeState(response.state);
}

async function addTab(tab) {
  if (isSelected(tab.id)) return;
  await persistState({
    selectedTabs: [
      ...state.selectedTabs,
      { ...normalizeTab(tab), intervalMinutes: NEW_TAB_INTERVAL_MINUTES, breakMinutes: 0 }
    ]
  }, { reschedule: false });
}

async function removeTab(tabId) {
  const selectedTabs = state.selectedTabs.filter((tab) => tab.id !== tabId);
  const currentTabId = state.selectedTabs[state.currentIndex]?.id;
  await persistState({
    selectedTabs,
    currentIndex: selectedTabs.findIndex((tab) => tab.id === currentTabId)
  }, { reschedule: false });
}

async function updateTabInterval(tabId, value) {
  const intervalMinutes = Number(value);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0.5) {
    render();
    return;
  }

  await persistState({
    selectedTabs: state.selectedTabs.map((tab) => (
      tab.id === tabId ? { ...tab, intervalMinutes } : tab
    ))
  });
}

async function updateTabBreak(tabId, value) {
  const breakMinutes = Number(value);
  if (!Number.isFinite(breakMinutes) || breakMinutes < 0) {
    render();
    return;
  }

  await persistState({
    selectedTabs: state.selectedTabs.map((tab) => (
      tab.id === tabId ? { ...tab, breakMinutes } : tab
    ))
  }, { reschedule: false });
}

function getBreakMinutesForTab(tab) {
  if (!state.breakEnabled) return 0;
  const tabBreakMinutes = getValidBreak(tab.breakMinutes);
  return tabBreakMinutes > 0 ? tabBreakMinutes : getValidInterval(state.defaultBreakMinutes, 5);
}

async function reorderSelectedTabs(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;

  const selectedTabs = [...state.selectedTabs];
  const fromIndex = selectedTabs.findIndex((tab) => tab.id === Number(fromId));
  const toIndex = selectedTabs.findIndex((tab) => tab.id === Number(toId));
  if (fromIndex < 0 || toIndex < 0) return;

  const [moved] = selectedTabs.splice(fromIndex, 1);
  selectedTabs.splice(toIndex, 0, moved);

  const activeTabId = state.selectedTabs[state.currentIndex]?.id;
  await persistState({
    selectedTabs,
    currentIndex: selectedTabs.findIndex((tab) => tab.id === activeTabId)
  }, { reschedule: false });
}

async function start() {
  const response = await sendMessage({ type: "start" });
  if (response?.ok) mergeState(response.state);
}

async function pauseOrResume() {
  const response = await sendMessage({ type: state.paused ? "resume" : "pause" });
  if (response?.ok) mergeState(response.state);
}

async function stop() {
  const response = await sendMessage({ type: "stop" });
  if (response?.ok) mergeState(response.state);
}

async function switchNow() {
  const response = await sendMessage({ type: "switchNow" });
  if (response?.ok) mergeState(response.state);
}

async function clearStats() {
  const dayStats = getDayStats(selectedStatsDate);
  if (!Object.keys(dayStats.tabs || {}).length) return;
  if (!confirm("Clear tab listings for this day? The heatmap total will stay unchanged.")) return;

  await persistState({
    usageStats: {
      ...state.usageStats,
      [selectedStatsDate]: {
        ...dayStats,
        tabs: {}
      }
    }
  }, { reschedule: false });
}

elements.startButton.addEventListener("click", start);
elements.pauseButton.addEventListener("click", pauseOrResume);
elements.stopButton.addEventListener("click", stop);
elements.switchNowButton.addEventListener("click", switchNow);
elements.clearStatsButton.addEventListener("click", clearStats);
elements.themeToggle.addEventListener("click", () => {
  persistState({ theme: state.theme === "dark" ? "light" : "dark" }, { reschedule: false });
});
elements.breakEnabled.addEventListener("change", () => {
  elements.defaultBreakMinutes.disabled = !elements.breakEnabled.checked;
  persistState({ breakEnabled: elements.breakEnabled.checked }, { reschedule: false });
});
elements.defaultBreakMinutes.addEventListener("change", () => {
  const defaultBreakMinutes = Number(elements.defaultBreakMinutes.value);
  if (!Number.isFinite(defaultBreakMinutes) || defaultBreakMinutes < 0.5) {
    elements.defaultBreakMinutes.value = getValidInterval(state.defaultBreakMinutes, 5);
    return;
  }
  persistState({ defaultBreakMinutes }, { reschedule: false });
});
elements.notifyOnSwitch.addEventListener("change", () => {
  persistState({ notifyOnSwitch: elements.notifyOnSwitch.checked }, { reschedule: false });
});
elements.refreshTabs.addEventListener("click", async () => {
  await loadState();
  await loadOpenTabs();
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadState();
  await loadOpenTabs();
  countdownTimer = setInterval(updateCountdown, 1000);
});

window.addEventListener("unload", () => {
  if (countdownTimer) clearInterval(countdownTimer);
});
