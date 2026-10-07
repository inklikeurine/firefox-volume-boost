/* global API, MAX_PERCENT, DEFAULT_MAX_PERCENT, clamp */

const WARN_AT = 300;
const CONFIRM_MS = 4000;

const elements = {
  app: document.getElementById("app"),
  favicon: document.getElementById("favicon"),
  tabTitle: document.getElementById("tabTitle"),
  statusText: document.getElementById("statusText"),
  enabledToggle: document.getElementById("enabledToggle"),
  boostSlider: document.getElementById("boostSlider"),
  readout: document.getElementById("readout"),
  resetBtn: document.getElementById("resetBtn"),
  maxLabel: document.getElementById("maxLabel"),
  maxEditor: document.getElementById("maxEditor"),
  maxInput: document.getElementById("maxInput"),
  presets: Array.from(document.querySelectorAll("[data-preset]")),
  perSiteToggle: document.getElementById("perSiteToggle"),
  forgetBtn: document.getElementById("forgetBtn"),
  warning: document.getElementById("warning")
};

const tabState = {
  enabled: false,
  attached: 0,
  failed: 0
};

let activeTabId = null;
let maxBoostPercent = DEFAULT_MAX_PERCENT;
let savedSites = 0;
let rafId = null;
let pendingBoost = null;
let forgetTimer = null;

function sendMessage(message) {
  return API.runtime.sendMessage(message).catch((err) => {
    console.warn("[volume-boost] no answer from the background", err && err.message ? err.message : err);
    return null;
  });
}

function setReadout(value) {
  elements.readout.textContent = value + "%";
}

function updateWarning(value) {
  elements.warning.classList.toggle("show", value >= WARN_AT);
}

function statusFor(state) {
  if (!state.enabled) {
    return "Boost Off";
  }
  if (state.attached > 0) {
    return "Boost On";
  }
  if (state.failed > 0) {
    return "Media on this page could not be boosted";
  }
  return "Boost On — no media found yet";
}

function renderStatus() {
  elements.enabledToggle.checked = tabState.enabled;
  elements.enabledToggle.disabled = activeTabId === null;
  elements.app.dataset.enabled = tabState.enabled ? "true" : "false";
  elements.statusText.textContent = statusFor(tabState);
}

// A one-off line in the status slot; the next renderStatus() replaces it.
function showMessage(text) {
  elements.statusText.textContent = text;
}

function updateMaxLabel() {
  elements.maxLabel.textContent = "Max " + maxBoostPercent + "%";
  elements.boostSlider.max = String(maxBoostPercent);
}

function resolvePresetValue(token) {
  if (token === "max") {
    return maxBoostPercent;
  }
  return Number(token) || 0;
}

function setSliderValue(value) {
  const clamped = clamp(value, 0, maxBoostPercent);
  elements.boostSlider.value = String(clamped);
  setReadout(clamped);
  updateWarning(clamped);
  return clamped;
}

function scheduleBoostUpdate(value) {
  if (activeTabId === null) {
    return;
  }
  pendingBoost = value;
  if (rafId !== null) {
    return;
  }
  rafId = requestAnimationFrame(async () => {
    rafId = null;
    const toSend = pendingBoost;
    pendingBoost = null;
    await sendMessage({ type: "setBoost", tabId: activeTabId, value: toSend });
  });
}

// Repaint from the background's state. With `statusOnly`, just the switch
// and the status line: only the counts change while the popup is open, and
// the slider may be mid-drag.
async function refresh({ statusOnly = false } = {}) {
  if (activeTabId === null) {
    renderStatus();
    return;
  }

  const state = await sendMessage({ type: "getState", tabId: activeTabId });
  if (!state || state.ok === false) {
    if (!statusOnly) {
      showMessage("Couldn't read Volume Boost's settings");
    }
    return;
  }

  tabState.enabled = Boolean(state.enabled);
  tabState.attached = Number(state.attached) || 0;
  tabState.failed = Number(state.failed) || 0;
  renderStatus();
  if (statusOnly) {
    return;
  }
  maxBoostPercent = clamp(Number(state.maxBoostPercent) || DEFAULT_MAX_PERCENT, 1, MAX_PERCENT);
  savedSites = Number(state.savedSites) || 0;
  updateMaxLabel();
  elements.perSiteToggle.checked = Boolean(state.perSite);
  setSliderValue(Number(state.boostPercent) || 0);
}

async function init() {
  const tabs = await API.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0] ? tabs[0] : null;
  activeTabId = tab ? tab.id : null;

  if (tab && tab.title) {
    elements.tabTitle.textContent = tab.title;
  }

  if (tab && tab.favIconUrl) {
    elements.favicon.src = tab.favIconUrl;
  } else {
    elements.favicon.style.opacity = "0";
  }

  await refresh();
}

function openMaxEditor() {
  elements.maxInput.value = String(maxBoostPercent);
  elements.maxLabel.hidden = true;
  elements.maxEditor.hidden = false;
  elements.maxInput.focus();
  elements.maxInput.select();
}

function closeMaxEditor(returnFocus) {
  if (elements.maxEditor.hidden) {
    return;
  }
  elements.maxEditor.hidden = true;
  elements.maxLabel.hidden = false;
  if (returnFocus) {
    elements.maxLabel.focus();
  }
}

async function saveMax(value) {
  await sendMessage({ type: "setMaxBoost", value });
  await refresh();
}

function disarmForget() {
  if (forgetTimer) {
    clearTimeout(forgetTimer);
    forgetTimer = null;
  }
  elements.forgetBtn.textContent = "Forget saved sites";
}

async function forgetSites() {
  if (!forgetTimer) {
    forgetTimer = setTimeout(() => {
      disarmForget();
      renderStatus();
    }, CONFIRM_MS);
    elements.forgetBtn.textContent = "Click again to confirm";
    if (savedSites === 1) {
      showMessage("Forget 1 saved site and reset settings?");
    } else if (savedSites > 1) {
      showMessage("Forget " + savedSites + " saved sites and reset settings?");
    } else {
      showMessage("Reset settings to defaults?");
    }
    return;
  }

  disarmForget();
  const response = await sendMessage({ type: "resetSettings" });
  await refresh();
  if (response && response.ok) {
    showMessage("Settings reset");
  }
}

function setupEvents() {
  elements.boostSlider.addEventListener("input", (event) => {
    const value = Number(event.target.value) || 0;
    setReadout(value);
    updateWarning(value);
    scheduleBoostUpdate(value);
  });

  elements.resetBtn.addEventListener("click", () => {
    const value = setSliderValue(100);
    scheduleBoostUpdate(value);
  });

  elements.enabledToggle.addEventListener("change", async () => {
    if (activeTabId === null) {
      return;
    }

    const response = await sendMessage({
      type: "setEnabled",
      tabId: activeTabId,
      value: elements.enabledToggle.checked,
      boostPercent: Number(elements.boostSlider.value) || 0
    });

    if (!response || response.error) {
      tabState.enabled = false;
      renderStatus();
      showMessage(response && response.error ? response.error : "No answer from Volume Boost");
      return;
    }

    await refresh({ statusOnly: true });
  });

  elements.perSiteToggle.addEventListener("change", async () => {
    if (activeTabId === null) {
      return;
    }
    await sendMessage({ type: "setPerSite", tabId: activeTabId, value: elements.perSiteToggle.checked });
    await refresh();
  });

  // Double-click opens the editor; so does Enter or Space (a keyboard
  // "click" has detail 0), while a single mouse click does nothing.
  elements.maxLabel.addEventListener("dblclick", openMaxEditor);
  elements.maxLabel.addEventListener("click", (event) => {
    if (event.detail === 0) {
      openMaxEditor();
    }
  });

  elements.maxEditor.addEventListener("submit", async (event) => {
    event.preventDefault();
    const parsed = Math.round(Number(elements.maxInput.value));
    if (elements.maxInput.value.trim() === "" || !Number.isFinite(parsed) || parsed < 1 || parsed > MAX_PERCENT) {
      showMessage("Max must be between 1% and " + MAX_PERCENT + "%");
      elements.maxInput.select();
      return;
    }
    closeMaxEditor(true);
    await saveMax(parsed);
  });

  elements.maxInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMaxEditor(true);
      renderStatus();
    }
  });

  elements.maxInput.addEventListener("blur", () => closeMaxEditor(false));

  elements.presets.forEach((button) => {
    button.addEventListener("click", () => {
      const token = button.getAttribute("data-preset");
      const value = setSliderValue(resolvePresetValue(token));
      scheduleBoostUpdate(value);
    });
  });

  elements.forgetBtn.addEventListener("click", forgetSites);

  // The background announces when a frame of this tab finds or loses media.
  // Other messages are the background's to answer.
  API.runtime.onMessage.addListener((message) => {
    if (message && message.type === "statusChanged") {
      if (message.tabId === activeTabId) {
        refresh({ statusOnly: true });
      }
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
}

setupEvents();
init();
