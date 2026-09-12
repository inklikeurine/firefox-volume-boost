/* global browser, chrome */

const API = typeof browser !== "undefined" ? browser : chrome;

const DEFAULTS = {
  boostPercent: 100,
  maxBoostPercent: 600,
  perSite: false,
  siteBoosts: {}
};

const state = {
  enabledTabId: null,
  boostPercent: DEFAULTS.boostPercent,
  maxBoostPercent: DEFAULTS.maxBoostPercent,
  perSite: DEFAULTS.perSite,
  siteBoosts: DEFAULTS.siteBoosts
};

let saveTimer = null;

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

function isHttpUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://"));
}

async function loadSettings() {
  const data = await API.storage.local.get(DEFAULTS);
  state.maxBoostPercent = clamp(Number(data.maxBoostPercent) || DEFAULTS.maxBoostPercent, 1, 5000);
  state.boostPercent = clamp(Number(data.boostPercent) || DEFAULTS.boostPercent, 0, state.maxBoostPercent);
  state.perSite = Boolean(data.perSite);
  state.siteBoosts = data.siteBoosts && typeof data.siteBoosts === "object" ? data.siteBoosts : {};
}

const settingsLoaded = loadSettings();

async function saveSettings() {
  await API.storage.local.set({
    boostPercent: state.boostPercent,
    maxBoostPercent: state.maxBoostPercent,
    perSite: state.perSite,
    siteBoosts: state.siteBoosts
  });
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

async function getTabOrigin(tabId) {
  try {
    const tab = await API.tabs.get(tabId);
    if (!tab || !isHttpUrl(tab.url)) {
      return null;
    }
    const url = new URL(tab.url);
    return url.origin;
  } catch (_err) {
    return null;
  }
}

async function getActiveTabId() {
  const tabs = await API.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

async function getBoostForTab(tabId) {
  if (!state.perSite) {
    return state.boostPercent;
  }
  const origin = await getTabOrigin(tabId);
  if (origin && typeof state.siteBoosts[origin] === "number") {
    return clamp(state.siteBoosts[origin], 0, state.maxBoostPercent);
  }
  return state.boostPercent;
}

function sendToTab(tabId, message) {
  try {
    const result = API.tabs.sendMessage(tabId, message);
    if (result && typeof result.then === "function") {
      return result;
    }
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    API.tabs.sendMessage(tabId, message, (response) => {
      const lastError = API.runtime && API.runtime.lastError;
      if (lastError) {
        reject(lastError);
        return;
      }
      resolve(response);
    });
  });
}

async function applyToTab(tabId, enabled, boostPercent) {
  const message = {
    type: "applyBoost",
    enabled: Boolean(enabled),
    boostPercent: clamp(Number(boostPercent) || 0, 0, state.maxBoostPercent)
  };
  return sendToTab(tabId, message);
}

async function handleGetState(tabId) {
  await settingsLoaded;
  const boostPercent = await getBoostForTab(tabId);
  return {
    enabled: state.enabledTabId === tabId,
    boostPercent,
    maxBoostPercent: state.maxBoostPercent,
    perSite: state.perSite
  };
}

async function handleSetBoost(tabId, value) {
  await settingsLoaded;
  const clamped = clamp(Number(value) || 0, 0, state.maxBoostPercent);
  state.boostPercent = clamped;

  if (state.perSite) {
    const origin = await getTabOrigin(tabId);
    if (origin) {
      state.siteBoosts[origin] = clamped;
    }
  }

  scheduleSave();

  if (state.enabledTabId === tabId) {
    try {
      await applyToTab(tabId, true, clamped);
    } catch (_err) {
      // Ignore apply failures (e.g., restricted pages).
    }
  }

  return { boostPercent: clamped };
}

async function handleSetMaxBoost(value) {
  await settingsLoaded;
  const maxBoost = clamp(Number(value) || DEFAULTS.maxBoostPercent, 1, 5000);
  state.maxBoostPercent = maxBoost;
  state.boostPercent = clamp(state.boostPercent, 0, maxBoost);

  if (state.siteBoosts && typeof state.siteBoosts === "object") {
    Object.keys(state.siteBoosts).forEach((origin) => {
      state.siteBoosts[origin] = clamp(state.siteBoosts[origin], 0, maxBoost);
    });
  }

  scheduleSave();

  if (state.enabledTabId !== null) {
    try {
      await applyToTab(state.enabledTabId, true, state.boostPercent);
    } catch (_err) {
      // Ignore apply failures.
    }
  }

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

async function handleSetEnabled(tabId, enabled, boostPercent) {
  await settingsLoaded;

  const activeId = await getActiveTabId();
  if (activeId !== tabId) {
    return { enabled: false, error: "Tab is not active" };
  }

  if (enabled) {
    if (state.enabledTabId && state.enabledTabId !== tabId) {
      try {
        await applyToTab(state.enabledTabId, false, 100);
      } catch (_err) {
        // Ignore apply failures.
      }
    }
    state.enabledTabId = tabId;

    const percent = typeof boostPercent === "number" ? boostPercent : await getBoostForTab(tabId);
    const wasCorsTab = corsTabs.has(tabId);
    enableCorsForTab(tabId);
    let response;
    try {
      response = await applyToTab(tabId, true, percent);
    } catch (err) {
      state.enabledTabId = null;
      if (!wasCorsTab) {
        releaseCorsForTab(tabId);
      }
      return { enabled: false, error: err && err.message ? err.message : "Unable to apply boost" };
    }

    if (response && response.failed && !response.attached) {
      return { enabled: true, warning: "Media on this page could not be boosted" };
    }

    return { enabled: true };
  }

  if (state.enabledTabId === tabId) {
    state.enabledTabId = null;
  }

  try {
    await applyToTab(tabId, false, 100);
  } catch (_err) {
    // Ignore apply failures.
  }

  return { enabled: false };
}

API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

API.tabs.onActivated.addListener((activeInfo) => {
  if (state.enabledTabId && activeInfo.tabId !== state.enabledTabId) {
    applyToTab(state.enabledTabId, false, 100).catch(() => {});
    state.enabledTabId = null;
  }
});

API.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && state.enabledTabId !== tabId) {
    // Navigation discards the old page's tainted media elements, so the
    // header injection is no longer needed for tabs without active boost.
    releaseCorsForTab(tabId);
  }
  if (changeInfo.status === "complete" && state.enabledTabId === tabId) {
    getBoostForTab(tabId)
      .then((boost) => applyToTab(tabId, true, boost))
      .catch(() => {});
  }
});

API.tabs.onRemoved.addListener((tabId) => {
  if (state.enabledTabId === tabId) {
    state.enabledTabId = null;
  }
  releaseCorsForTab(tabId);
});
