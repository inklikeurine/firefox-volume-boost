/* global API, MAX_PERCENT, DEFAULT_MAX_PERCENT, clamp, warnOnce */

const BADGE_COLOR = "#1f7a75";
const UNREACHABLE_PAGE = "Can't boost this page. Try reloading it.";

// --- Settings (storage.local) ---------------------------------------------

const DEFAULTS = {
  boostPercent: 100,
  maxBoostPercent: DEFAULT_MAX_PERCENT,
  perSite: false,
  siteBoosts: {}
};

const state = { ...DEFAULTS, siteBoosts: {} };
let saveTimer = null;

function readNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampSiteBoosts(siteBoosts, max) {
  const result = {};
  if (siteBoosts && typeof siteBoosts === "object") {
    Object.keys(siteBoosts).forEach((origin) => {
      const value = siteBoosts[origin];
      if (typeof value === "number" && Number.isFinite(value)) {
        result[origin] = clamp(value, 0, max);
      }
    });
  }
  return result;
}

// Defaults are applied on read; anything missing or malformed falls back.
async function loadSettings() {
  let data = DEFAULTS;
  try {
    data = await API.storage.local.get(DEFAULTS);
  } catch (err) {
    warnOnce("load", "could not read settings; using defaults", err);
  }
  state.maxBoostPercent = clamp(Math.round(readNumber(data.maxBoostPercent, DEFAULT_MAX_PERCENT)), 1, MAX_PERCENT);
  state.boostPercent = clamp(readNumber(data.boostPercent, DEFAULTS.boostPercent), 0, state.maxBoostPercent);
  state.perSite = Boolean(data.perSite);
  state.siteBoosts = clampSiteBoosts(data.siteBoosts, state.maxBoostPercent);
}

const settingsLoaded = loadSettings();

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await API.storage.local.set({
      boostPercent: state.boostPercent,
      maxBoostPercent: state.maxBoostPercent,
      perSite: state.perSite,
      siteBoosts: state.siteBoosts
    });
  } catch (err) {
    warnOnce("save", "could not save settings", err);
  }
}

// The slider sends a stream of levels; save once it settles.
function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(saveNow, 200);
}

// --- Tabs and levels ---------------------------------------------------------

// Session state, rebuilt from nothing on every start (boost is off after a
// restart): the level applied to each boosted tab, and how many media
// elements each frame of a tab has attached or failed to attach.
const boostedTabs = new Map();
const mediaCounts = new Map();

async function getTab(tabId) {
  try {
    return await API.tabs.get(tabId);
  } catch (err) {
    warnOnce("tab", "could not read a tab", err);
    return null;
  }
}

async function getTabOrigin(tabId) {
  const tab = await getTab(tabId);
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return null;
  }
  try {
    return new URL(tab.url).origin;
  } catch (_err) {
    return null;
  }
}

async function getSiteBoost(tabId) {
  if (!state.perSite) {
    return null;
  }
  const origin = await getTabOrigin(tabId);
  if (origin && typeof state.siteBoosts[origin] === "number") {
    return clamp(state.siteBoosts[origin], 0, state.maxBoostPercent);
  }
  return null;
}

// The level a tab gets when boost is switched on: its site's level in
// per-site mode, otherwise the last level set.
async function getBoostForTab(tabId) {
  const siteBoost = await getSiteBoost(tabId);
  return siteBoost === null ? state.boostPercent : siteBoost;
}

// The level the user just chose becomes the last level set, and the site's
// level in per-site mode.
async function storeLevel(tabId, value) {
  const level = clamp(Math.round(Number(value)) || 0, 0, state.maxBoostPercent);
  state.boostPercent = level;
  if (state.perSite) {
    const origin = await getTabOrigin(tabId);
    if (origin) {
      state.siteBoosts[origin] = level;
    }
  }
  scheduleSave();
  return level;
}

function mediaTotals(tabId) {
  const totals = { attached: 0, failed: 0 };
  (mediaCounts.get(tabId) || new Map()).forEach((counts) => {
    totals.attached += counts.attached;
    totals.failed += counts.failed;
  });
  return totals;
}

function showBadge(tabId) {
  const text = boostedTabs.has(tabId) ? String(boostedTabs.get(tabId)) : "";
  API.browserAction
    .setBadgeText({ tabId, text })
    .catch((err) => warnOnce("badge", "could not update the toolbar badge", err));
}

// Let an open popup know its tab's numbers changed. With no popup open there
// is no receiver and the send fails, which is expected.
function notifyPopup(tabId) {
  API.runtime.sendMessage({ type: "statusChanged", tabId }).catch(() => {});
}

// Every frame of the tab gets it; the promise rejects when no content script
// answers (a page Firefox doesn't let add-ons into).
function applyToTab(tabId, enabled, boostPercent) {
  return API.tabs.sendMessage(tabId, { type: "applyBoost", enabled, boostPercent });
}

function boostTab(tabId, percent) {
  boostedTabs.set(tabId, percent);
  showBadge(tabId);
  return applyToTab(tabId, true, percent).catch((err) => warnOnce("apply", "could not reach a boosted tab", err));
}

// --- CORS header injection ------------------------------------------------------
// Tabs whose media responses get an injected Access-Control-Allow-Origin
// header, without which Web Audio outputs silence for cross-origin media. A tab
// is added when boost is enabled and stays until it closes or navigates with
// boost off: once an element is crossorigin="anonymous" and routed through Web
// Audio, later range requests without CORS headers would break playback.

const corsTabs = new Set();
const CORS_FILTER = { urls: ["<all_urls>"], types: ["media"] };

function injectCorsHeaders(details) {
  if (!corsTabs.has(details.tabId)) {
    return {};
  }
  const headers = details.responseHeaders || [];
  const existing = headers.find((header) => header.name.toLowerCase() === "access-control-allow-origin");
  if (existing) {
    existing.value = "*";
  } else {
    headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
  }
  return { responseHeaders: headers };
}

// The listener is registered only while some tab needs it.
function updateCorsListener() {
  const registered = API.webRequest.onHeadersReceived.hasListener(injectCorsHeaders);
  if (corsTabs.size > 0 && !registered) {
    API.webRequest.onHeadersReceived.addListener(injectCorsHeaders, CORS_FILTER, ["blocking", "responseHeaders"]);
  } else if (corsTabs.size === 0 && registered) {
    API.webRequest.onHeadersReceived.removeListener(injectCorsHeaders);
  }
}

function armCors(tabId) {
  corsTabs.add(tabId);
  updateCorsListener();
}

function releaseCors(tabId) {
  corsTabs.delete(tabId);
  updateCorsListener();
}

// --- Messages from the popup ------------------------------------------------------

async function handleGetState(tabId) {
  await settingsLoaded;
  const boosted = boostedTabs.has(tabId);
  const totals = mediaTotals(tabId);
  return {
    enabled: boosted,
    boostPercent: boosted ? boostedTabs.get(tabId) : await getBoostForTab(tabId),
    maxBoostPercent: state.maxBoostPercent,
    perSite: state.perSite,
    savedSites: Object.keys(state.siteBoosts).length,
    attached: totals.attached,
    failed: totals.failed
  };
}

async function handleSetBoost(tabId, value) {
  await settingsLoaded;
  const level = await storeLevel(tabId, value);
  if (boostedTabs.has(tabId)) {
    await boostTab(tabId, level);
  }
  return { boostPercent: level };
}

async function handleSetMaxBoost(value) {
  await settingsLoaded;
  const requested = Math.round(Number(value));
  const max = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, MAX_PERCENT) : DEFAULT_MAX_PERCENT;
  state.maxBoostPercent = max;
  state.boostPercent = clamp(state.boostPercent, 0, max);
  state.siteBoosts = clampSiteBoosts(state.siteBoosts, max);
  scheduleSave();
  await Promise.all(Array.from(boostedTabs, ([tabId, percent]) => boostTab(tabId, clamp(percent, 0, max))));
  return { maxBoostPercent: max };
}

async function handleSetPerSite(tabId, value) {
  await settingsLoaded;
  state.perSite = Boolean(value);
  if (state.perSite) {
    const origin = await getTabOrigin(tabId);
    if (origin) {
      state.siteBoosts[origin] = state.boostPercent;
    }
  }
  scheduleSave();
  return { perSite: state.perSite };
}

async function handleResetSettings() {
  await settingsLoaded;
  const forgotten = Object.keys(state.siteBoosts).length;
  Object.assign(state, DEFAULTS, { siteBoosts: {} });
  await saveNow();
  // Boosted tabs stay on, at the default level.
  await Promise.all(Array.from(boostedTabs.keys(), (tabId) => boostTab(tabId, state.boostPercent)));
  return {
    ok: true,
    forgotten,
    boostPercent: state.boostPercent,
    maxBoostPercent: state.maxBoostPercent,
    perSite: state.perSite
  };
}

// Switching on with a level stores it as setBoost does; without one the tab
// gets its site's or the last level.
async function handleSetEnabled(tabId, enabled, boostPercent) {
  await settingsLoaded;

  if (!enabled) {
    boostedTabs.delete(tabId);
    showBadge(tabId);
    await applyToTab(tabId, false, 100).catch((err) =>
      warnOnce("disable", "could not reach the page to stop boosting it", err)
    );
    return { enabled: false };
  }

  const percent =
    typeof boostPercent === "number" && Number.isFinite(boostPercent)
      ? await storeLevel(tabId, boostPercent)
      : await getBoostForTab(tabId);
  const wasBoosted = boostedTabs.has(tabId);
  const wasArmed = corsTabs.has(tabId);
  boostedTabs.set(tabId, percent);
  armCors(tabId);
  try {
    await applyToTab(tabId, true, percent);
  } catch (err) {
    warnOnce("enable", "could not reach the page to boost it", err);
    if (!wasBoosted) {
      boostedTabs.delete(tabId);
    }
    if (!wasArmed) {
      releaseCors(tabId);
    }
    showBadge(tabId);
    return { enabled: false, error: UNREACHABLE_PAGE };
  }
  showBadge(tabId);
  return { enabled: true };
}

// --- Messages from content scripts --------------------------------------------------

// A content script just loaded in some frame: tell it whether its tab is boosted.
function handleFrameReady(tabId) {
  return boostedTabs.has(tabId) ? { enabled: true, boostPercent: boostedTabs.get(tabId) } : { enabled: false };
}

function handleFrameStatus(tabId, frameId, attached, failed) {
  if (!mediaCounts.has(tabId)) {
    mediaCounts.set(tabId, new Map());
  }
  mediaCounts.get(tabId).set(frameId, {
    attached: Math.max(0, Number(attached) || 0),
    failed: Math.max(0, Number(failed) || 0)
  });
  notifyPopup(tabId);
  return { ok: true };
}

function handleMessage(message, sender) {
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  switch (message.type) {
    case "getState":
      return handleGetState(message.tabId);
    case "setBoost":
      return handleSetBoost(message.tabId, message.value);
    case "setMaxBoost":
      return handleSetMaxBoost(message.value);
    case "setPerSite":
      return handleSetPerSite(message.tabId, message.value);
    case "setEnabled":
      return handleSetEnabled(message.tabId, message.value, message.boostPercent);
    case "resetSettings":
      return handleResetSettings();
    case "frameReady":
      return senderTabId === null ? { enabled: false } : handleFrameReady(senderTabId);
    case "frameStatus":
      return senderTabId === null
        ? { ok: false, error: "Not sent from a tab" }
        : handleFrameStatus(senderTabId, sender.frameId || 0, message.attached, message.failed);
    default:
      return { ok: false, error: "Unknown message" };
  }
}

// Every message is answered, even a malformed one.
API.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(() => (message && message.type ? handleMessage(message, sender) : { ok: false, error: "Invalid message" }))
    .then(sendResponse, (err) => sendResponse({ ok: false, error: err && err.message ? err.message : "Error" }));
  return true;
});

// --- Tab lifecycle -------------------------------------------------------------------

API.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // A new document: its frames will report their own counts.
    mediaCounts.delete(tabId);
    if (!boostedTabs.has(tabId)) {
      // Navigation discards the old page's tainted media elements, so the
      // header injection is no longer needed for tabs without active boost.
      releaseCors(tabId);
    }
  }
  if (changeInfo.status === "complete" && boostedTabs.has(tabId)) {
    // Firefox clears a tab's badge when it navigates. Keep the tab's level
    // unless per-site mode has one saved for the new site.
    getSiteBoost(tabId)
      .then((siteBoost) => boostTab(tabId, siteBoost === null ? boostedTabs.get(tabId) : siteBoost))
      .catch((err) => warnOnce("reapply", "could not re-apply boost after navigation", err));
  }
});

API.tabs.onRemoved.addListener((tabId) => {
  boostedTabs.delete(tabId);
  mediaCounts.delete(tabId);
  releaseCors(tabId);
});

API.browserAction
  .setBadgeBackgroundColor({ color: BADGE_COLOR })
  .catch((err) => warnOnce("badge-color", "could not set the badge colour", err));
