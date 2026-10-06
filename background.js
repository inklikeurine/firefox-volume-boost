/* global browser, chrome */

const API = typeof browser !== "undefined" ? browser : chrome;

const MAX_LIMIT = 1000;
const BADGE_COLOR = "#1f7a75";
const UNREACHABLE_PAGE = "Can't boost this page. Try reloading it.";

const DEFAULTS = {
  boostPercent: 100,
  maxBoostPercent: 200,
  perSite: false,
  siteBoosts: {}
};

const state = {
  boostPercent: DEFAULTS.boostPercent,
  maxBoostPercent: DEFAULTS.maxBoostPercent,
  perSite: DEFAULTS.perSite,
  siteBoosts: {}
};

// Session state, rebuilt from nothing on every start (boost is off after a
// restart): the level applied to each boosted tab, and how many media
// elements each frame of a tab has attached or failed to attach.
const boostedTabs = new Map();
const mediaCounts = new Map();

let saveTimer = null;
const warned = new Set();

function warnOnce(key, message, err) {
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  console.warn("[volume-boost] " + message, err && err.message ? err.message : err || "");
}

// Tabs whose media responses get an injected Access-Control-Allow-Origin header.
// A tab is added when boost is enabled and stays until it closes or navigates
// with boost off: once an element is crossorigin="anonymous" and routed through
// Web Audio, later range requests without CORS headers would break playback.
const corsTabs = new Set();

const CORS_FILTER = { urls: ["<all_urls>"], types: ["media"] };

function injectCorsHeaders(details) {
  if (!corsTabs.has(details.tabId)) {
    return {};
  }
  const headers = details.responseHeaders || [];
  const existing = headers.find(
    (header) => header.name.toLowerCase() === "access-control-allow-origin"
  );
  if (existing) {
    existing.value = "*";
  } else {
    headers.push({ name: "Access-Control-Allow-Origin", value: "*" });
  }
  return { responseHeaders: headers };
}

function updateCorsListener() {
  const registered = API.webRequest.onHeadersReceived.hasListener(injectCorsHeaders);
  if (corsTabs.size > 0 && !registered) {
    API.webRequest.onHeadersReceived.addListener(injectCorsHeaders, CORS_FILTER, [
      "blocking",
      "responseHeaders"
    ]);
  } else if (corsTabs.size === 0 && registered) {
    API.webRequest.onHeadersReceived.removeListener(injectCorsHeaders);
  }
}

function enableCorsForTab(tabId) {
  corsTabs.add(tabId);
  updateCorsListener();
}

function releaseCorsForTab(tabId) {
  corsTabs.delete(tabId);
  updateCorsListener();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isHttpUrl(url) {
  return Boolean(url) && (url.startsWith("http://") || url.startsWith("https://"));
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

async function loadSettings() {
  let data = DEFAULTS;
  try {
    data = await API.storage.local.get(DEFAULTS);
  } catch (err) {
    warnOnce("load", "could not read settings; using defaults", err);
  }
  state.maxBoostPercent = clamp(
    Math.round(readNumber(data.maxBoostPercent, DEFAULTS.maxBoostPercent)),
    1,
    MAX_LIMIT
  );
  state.boostPercent = clamp(
    readNumber(data.boostPercent, DEFAULTS.boostPercent),
    0,
    state.maxBoostPercent
  );
  state.perSite = Boolean(data.perSite);
  state.siteBoosts = clampSiteBoosts(data.siteBoosts, state.maxBoostPercent);
}

const settingsLoaded = loadSettings();

async function saveSettings() {
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

function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSettings();
  }, 200);
}

async function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await saveSettings();
}

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
  if (!tab || !isHttpUrl(tab.url)) {
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

function mediaTotals(tabId) {
  const totals = { attached: 0, failed: 0 };
  const frames = mediaCounts.get(tabId);
  if (frames) {
    frames.forEach((counts) => {
      totals.attached += counts.attached;
      totals.failed += counts.failed;
    });
  }
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

function applyToTab(tabId, enabled, boostPercent) {
  return API.tabs.sendMessage(tabId, {
    type: "applyBoost",
    enabled: Boolean(enabled),
    boostPercent: clamp(Number(boostPercent) || 0, 0, state.maxBoostPercent)
  });
}

function boostTab(tabId, percent) {
  boostedTabs.set(tabId, percent);
  showBadge(tabId);
  return applyToTab(tabId, true, percent).catch((err) =>
    warnOnce("apply", "could not reach a boosted tab", err)
  );
}

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
  const clamped = clamp(Math.round(Number(value)) || 0, 0, state.maxBoostPercent);
  state.boostPercent = clamped;

  if (state.perSite) {
    const origin = await getTabOrigin(tabId);
    if (origin) {
      state.siteBoosts[origin] = clamped;
    }
  }

  scheduleSave();

  if (boostedTabs.has(tabId)) {
    await boostTab(tabId, clamped);
  }

  return { boostPercent: clamped };
}

async function handleSetMaxBoost(value) {
  await settingsLoaded;
  const requested = Math.round(Number(value));
  const maxBoost =
    Number.isFinite(requested) && requested >= 1 ? Math.min(requested, MAX_LIMIT) : DEFAULTS.maxBoostPercent;
  state.maxBoostPercent = maxBoost;
  state.boostPercent = clamp(state.boostPercent, 0, maxBoost);
  state.siteBoosts = clampSiteBoosts(state.siteBoosts, maxBoost);

  scheduleSave();

  await Promise.all(
    Array.from(boostedTabs, ([tabId, percent]) => boostTab(tabId, clamp(percent, 0, maxBoost)))
  );

  return { maxBoostPercent: maxBoost };
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
  state.boostPercent = DEFAULTS.boostPercent;
  state.maxBoostPercent = DEFAULTS.maxBoostPercent;
  state.perSite = DEFAULTS.perSite;
  state.siteBoosts = {};
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

async function handleSetEnabled(tabId, enabled, boostPercent) {
  await settingsLoaded;

  if (enabled) {
    const percent =
      typeof boostPercent === "number" && Number.isFinite(boostPercent)
        ? clamp(Math.round(boostPercent), 0, state.maxBoostPercent)
        : await getBoostForTab(tabId);
    const wasBoosted = boostedTabs.has(tabId);
    const wasCorsTab = corsTabs.has(tabId);
    boostedTabs.set(tabId, percent);
    enableCorsForTab(tabId);
    try {
      await applyToTab(tabId, true, percent);
    } catch (err) {
      warnOnce("enable", "could not reach the page to boost it", err);
      if (!wasBoosted) {
        boostedTabs.delete(tabId);
      }
      if (!wasCorsTab) {
        releaseCorsForTab(tabId);
      }
      showBadge(tabId);
      return { enabled: false, error: UNREACHABLE_PAGE };
    }
    showBadge(tabId);
    return { enabled: true };
  }

  boostedTabs.delete(tabId);
  showBadge(tabId);

  try {
    await applyToTab(tabId, false, 100);
  } catch (err) {
    warnOnce("disable", "could not reach the page to stop boosting it", err);
  }

  return { enabled: false };
}

// A content script just loaded in some frame: tell it whether its tab is boosted.
function handleFrameReady(tabId) {
  if (boostedTabs.has(tabId)) {
    return { enabled: true, boostPercent: boostedTabs.get(tabId) };
  }
  return { enabled: false };
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

API.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender && sender.tab ? sender.tab.id : null;
  const handler = async () => {
    if (!message || !message.type) {
      return { ok: false, error: "Invalid message" };
    }

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
      case "reset":
        return handleSetBoost(message.tabId, 100);
      case "resetSettings":
        return handleResetSettings();
      case "frameReady":
        return senderTabId === null ? { enabled: false } : handleFrameReady(senderTabId);
      case "frameStatus":
        if (senderTabId === null) {
          return { ok: false, error: "Not sent from a tab" };
        }
        return handleFrameStatus(senderTabId, sender.frameId || 0, message.attached, message.failed);
      default:
        return { ok: false, error: "Unknown message" };
    }
  };

  handler()
    .then((result) => sendResponse(result))
    .catch((err) =>
      sendResponse({ ok: false, error: err && err.message ? err.message : "Error" })
    );

  return true;
});

API.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // A new document: its frames will report their own counts.
    mediaCounts.delete(tabId);
    if (!boostedTabs.has(tabId)) {
      // Navigation discards the old page's tainted media elements, so the
      // header injection is no longer needed for tabs without active boost.
      releaseCorsForTab(tabId);
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
  releaseCorsForTab(tabId);
});

// Before 1.0 the default maximum was 600%, and it was saved with every other
// setting, so a stored 600 is almost always that old default.
async function migrateFromBeta() {
  await settingsLoaded;
  let stored = {};
  try {
    stored = await API.storage.local.get("maxBoostPercent");
  } catch (err) {
    warnOnce("migrate", "could not read settings to update them", err);
    return;
  }
  if (stored.maxBoostPercent === 600) {
    state.maxBoostPercent = DEFAULTS.maxBoostPercent;
    state.boostPercent = clamp(state.boostPercent, 0, state.maxBoostPercent);
    state.siteBoosts = clampSiteBoosts(state.siteBoosts, state.maxBoostPercent);
  }
  await saveNow();
}

API.runtime.onInstalled.addListener((details) => {
  const previousMajor = parseInt(String(details.previousVersion || ""), 10);
  if (details.reason === "update" && previousMajor === 0) {
    migrateFromBeta();
  }
});

API.browserAction
  .setBadgeBackgroundColor({ color: BADGE_COLOR })
  .catch((err) => warnOnce("badge-color", "could not set the badge colour", err));
