const STORAGE_KEY = "pomodoroTabSwitcherState";
const ALARM_NAME = "pomodoroTabSwitcherTick";
const MIN_INTERVAL_MINUTES = 0.5;
const NEW_TAB_INTERVAL_MINUTES = 25;
const DEFAULT_STATE = {
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

async function getState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(stored[STORAGE_KEY] || {}) };
}

async function setState(nextState) {
  await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
  return nextState;
}

function dedupeTabs(tabs) {
  const seen = new Set();
  const uniqueTabs = [];

  for (const tab of tabs || []) {
    if (!tab || typeof tab.id !== "number" || seen.has(tab.id)) continue;
    seen.add(tab.id);
    uniqueTabs.push({
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || "Untitled tab",
      url: tab.url || "",
      intervalMinutes: getIntervalMinutes(tab),
      breakMinutes: getBreakMinutes(tab)
    });
  }

  return uniqueTabs;
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function sanitizeSelectedTabs(state) {
  const uniqueTabs = dedupeTabs(state.selectedTabs);
  const existingTabs = [];

  for (const tab of uniqueTabs) {
    if (await tabExists(tab.id)) {
      existingTabs.push(tab);
    }
  }

  const maxIndex = existingTabs.length - 1;
  const currentIndex = Math.min(state.currentIndex, maxIndex);
  return { ...state, selectedTabs: existingTabs, currentIndex };
}

function getIntervalMinutes(state) {
  const interval = Number(state.intervalMinutes);
  if (!Number.isFinite(interval)) return NEW_TAB_INTERVAL_MINUTES;
  return Math.max(interval, MIN_INTERVAL_MINUTES);
}

function getBreakMinutes(state) {
  const interval = Number(state.breakMinutes);
  if (!Number.isFinite(interval)) return 0;
  if (interval <= 0) return 0;
  return Math.max(interval, MIN_INTERVAL_MINUTES);
}

function getDefaultBreakMinutes(state) {
  const interval = Number(state.defaultBreakMinutes);
  if (!Number.isFinite(interval)) return 5;
  return Math.max(interval, 0.5);
}

function normalizeState(state) {
  const selectedTabs = dedupeTabs(state.selectedTabs);
  const parsedCurrentIndex = Number(state.currentIndex);
  const currentIndex = selectedTabs.length === 0
    ? -1
    : Math.min(Math.max(Number.isFinite(parsedCurrentIndex) ? parsedCurrentIndex : -1, -1), selectedTabs.length - 1);

  return {
    ...state,
    selectedTabs,
    currentIndex,
    paused: Boolean(state.paused),
    completedInCycle: Math.min(Math.max(Number(state.completedInCycle) || 0, 0), selectedTabs.length),
    notifyOnSwitch: state.notifyOnSwitch !== false,
    theme: state.theme === "dark" ? "dark" : "light",
    mode: state.mode === "break" ? "break" : "focus",
    breakEnabled: Boolean(state.breakEnabled),
    defaultBreakMinutes: getDefaultBreakMinutes(state),
    usageStats: state.usageStats && typeof state.usageStats === "object" ? state.usageStats : {}
  };
}

function getDayKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTabStatsKey(tab) {
  return tab.url || `${tab.title || "Untitled tab"}:${tab.id}`;
}

function addUsage(state, tab, durationMs, timestamp = Date.now()) {
  if (!tab || durationMs <= 0) return state;

  const dayKey = getDayKey(timestamp);
  const tabKey = getTabStatsKey(tab);
  const usageStats = { ...(state.usageStats || {}) };
  const dayStats = usageStats[dayKey] || { totalMs: 0, tabs: {} };
  const tabStats = dayStats.tabs[tabKey] || {
    title: tab.title || "Untitled tab",
    url: tab.url || "",
    totalMs: 0,
    sessions: 0
  };

  usageStats[dayKey] = {
    ...dayStats,
    totalMs: Math.max(0, Number(dayStats.totalMs) || 0) + durationMs,
    tabs: {
      ...dayStats.tabs,
      [tabKey]: {
        ...tabStats,
        title: tab.title || tabStats.title,
        url: tab.url || tabStats.url,
        totalMs: Math.max(0, Number(tabStats.totalMs) || 0) + durationMs,
        sessions: Math.max(0, Number(tabStats.sessions) || 0) + 1
      }
    }
  };

  return { ...state, usageStats };
}

function recordActiveSegment(state, endTime = Date.now()) {
  const activeTab = state.selectedTabs[state.currentIndex];
  if (!activeTab || !state.currentStartedAt) return state;

  const startedAt = Number(state.currentStartedAt);
  const endedAt = Math.max(startedAt, Math.min(endTime, Number(state.currentEndsAt) || endTime));
  return addUsage(state, activeTab, endedAt - startedAt, endedAt);
}

function getCurrentTabDuration(state) {
  const currentTab = state.selectedTabs[state.currentIndex];
  return getIntervalMinutes(currentTab || state);
}

function getCurrentBreakDurationMs(state) {
  if (!state.breakEnabled) return 0;
  const currentTab = state.selectedTabs[state.currentIndex];
  if (!currentTab) return 0;

  const tabBreakMinutes = getBreakMinutes(currentTab);
  const breakMinutes = tabBreakMinutes > 0 ? tabBreakMinutes : getDefaultBreakMinutes(state);
  return breakMinutes * 60 * 1000;
}

async function scheduleAlarm(state, durationMs = null, startedAt = Date.now(), mode = "focus") {
  await chrome.alarms.clear(ALARM_NAME);

  if (!state.running || state.paused || state.selectedTabs.length === 0) return;

  const intervalMinutes = getCurrentTabDuration(state);
  const requestedDurationMs = durationMs || intervalMinutes * 60 * 1000;
  const safeDurationMs = Math.max(requestedDurationMs, MIN_INTERVAL_MINUTES * 60 * 1000);
  const currentStartedAt = startedAt;
  const currentEndsAt = currentStartedAt + safeDurationMs;

  await setState({
    ...state,
    mode,
    currentStartedAt,
    currentEndsAt,
    pausedRemainingMs: null
  });

  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: safeDurationMs / 60 / 1000
  });
}

async function scheduleBreak(state) {
  const breakDurationMs = getCurrentBreakDurationMs(state);
  if (breakDurationMs <= 0) return false;
  await scheduleAlarm({ ...state, mode: "break" }, breakDurationMs, Date.now(), "break");
  return true;
}

async function notifySwitch(tab, state) {
  if (!state.notifyOnSwitch || !tab) return;

  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Pomodoro tab switched",
    message: tab.title || "Next tab is active."
  });
}

function getNextCompletedCount(state, switchingFromActiveTab) {
  if (!switchingFromActiveTab || state.selectedTabs.length === 0) return state.completedInCycle || 0;
  return ((state.completedInCycle || 0) % state.selectedTabs.length) + 1;
}

async function switchToNextTab({ force = false, completed = false, allowBreak = true } = {}) {
  let state = normalizeState(await sanitizeSelectedTabs(await getState()));

  if (((!state.running || state.paused) && !force) || state.selectedTabs.length === 0) {
    state = await setState({
      ...state,
      running: false,
      paused: false,
      currentIndex: -1,
      currentStartedAt: null,
      currentEndsAt: null,
      pausedRemainingMs: null,
      mode: "focus"
    });
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const previousIndex = state.currentIndex;
  const wasFocusMode = state.mode !== "break";
  if (previousIndex >= 0 && wasFocusMode && (state.running || completed)) {
    state = recordActiveSegment(state);
  }

  const completedInCycle = getNextCompletedCount(state, completed && previousIndex >= 0 && wasFocusMode);

  if (allowBreak && completed && wasFocusMode && await scheduleBreak({ ...state, completedInCycle })) {
    return;
  }

  const nextIndex = (state.currentIndex + 1) % state.selectedTabs.length;
  const nextTab = state.selectedTabs[nextIndex];
  const keepPaused = state.paused && force && !state.running;

  try {
    await chrome.tabs.update(nextTab.id, { active: true });
    if (typeof nextTab.windowId === "number") {
      await chrome.windows.update(nextTab.windowId, { focused: true });
    }
    state = await setState({
      ...state,
      currentIndex: nextIndex,
      completedInCycle,
      paused: keepPaused,
      mode: "focus",
      pausedRemainingMs: keepPaused ? getIntervalMinutes(nextTab) * 60 * 1000 : state.pausedRemainingMs
    });
    await notifySwitch(nextTab, state);
    if (state.running) {
      await scheduleAlarm(state);
    }
  } catch {
    const selectedTabs = state.selectedTabs.filter((tab) => tab.id !== nextTab.id);
    const nextState = await setState({
      ...state,
      selectedTabs,
      currentIndex: Math.min(nextIndex - 1, selectedTabs.length - 1),
      running: selectedTabs.length > 0,
      paused: false,
      currentStartedAt: null,
      currentEndsAt: null,
      pausedRemainingMs: null,
      completedInCycle: Math.min(completedInCycle, selectedTabs.length)
    });
    await scheduleAlarm(nextState);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === "getState") {
      const state = normalizeState(await sanitizeSelectedTabs(await getState()));
      await setState(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "saveState") {
      const state = normalizeState(await sanitizeSelectedTabs({ ...DEFAULT_STATE, ...message.state }));
      await setState(state);
      await scheduleAlarm(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "updateState") {
      const state = normalizeState(await sanitizeSelectedTabs({ ...DEFAULT_STATE, ...message.state }));
      await setState(state);
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "start") {
      let state = normalizeState(await sanitizeSelectedTabs(await getState()));
      state = await setState({
        ...state,
        running: state.selectedTabs.length > 0,
        paused: false,
        currentIndex: -1,
        currentStartedAt: null,
        currentEndsAt: null,
        pausedRemainingMs: null,
        mode: "focus",
        completedInCycle: 0
      });
      if (state.running) {
        await switchToNextTab({ force: true });
      } else {
        await scheduleAlarm(state);
      }
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message.type === "stop") {
      const currentState = normalizeState(await getState());
      const recordedState = currentState.running && currentState.mode !== "break"
        ? recordActiveSegment(currentState)
        : currentState;
      const state = await setState({
        ...recordedState,
        running: false,
        paused: false,
        currentIndex: -1,
        currentStartedAt: null,
        currentEndsAt: null,
        pausedRemainingMs: null,
        mode: "focus",
        completedInCycle: 0
      });
      await chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true, state });
      return;
    }

    if (message.type === "pause") {
      const state = normalizeState(await getState());
      const recordedState = state.running && state.mode !== "break"
        ? recordActiveSegment(state)
        : state;
      const pausedRemainingMs = Math.max(0, (state.currentEndsAt || Date.now()) - Date.now());
      const nextState = await setState({
        ...recordedState,
        running: false,
        paused: state.currentIndex >= 0,
        pausedRemainingMs,
        currentStartedAt: null,
        currentEndsAt: null
      });
      await chrome.alarms.clear(ALARM_NAME);
      sendResponse({ ok: true, state: nextState });
      return;
    }

    if (message.type === "resume") {
      let state = normalizeState(await sanitizeSelectedTabs(await getState()));
      state = await setState({
        ...state,
        running: state.selectedTabs.length > 0 && state.currentIndex >= 0,
        paused: false
      });
      await scheduleAlarm(state, state.pausedRemainingMs, Date.now(), state.mode);
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    if (message.type === "switchNow") {
      const state = await getState();
      await switchToNextTab({ force: true, completed: state.running, allowBreak: false });
      sendResponse({ ok: true, state: await getState() });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })();

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    getState().then((state) => {
      switchToNextTab({ completed: state.mode !== "break" });
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (!state.selectedTabs.some((tab) => tab.id === tabId)) return;

  const selectedTabs = state.selectedTabs.filter((tab) => tab.id !== tabId);
  const nextState = await setState({
    ...state,
    selectedTabs,
    currentIndex: Math.min(state.currentIndex, selectedTabs.length - 1),
    running: state.running && selectedTabs.length > 0,
    paused: state.paused && selectedTabs.length > 0,
    currentStartedAt: selectedTabs.length > 0 ? state.currentStartedAt : null,
    currentEndsAt: selectedTabs.length > 0 ? state.currentEndsAt : null,
    pausedRemainingMs: selectedTabs.length > 0 ? state.pausedRemainingMs : null,
    completedInCycle: Math.min(state.completedInCycle || 0, selectedTabs.length)
  });
  await scheduleAlarm(nextState);
});
