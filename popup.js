/* global API, MAX_PERCENT, DEFAULT_MAX_PERCENT, clamp */

const WARN_AT = 300;
const UNITY = 100;

const elements = {
  app: document.getElementById("app"),
  faviconWrap: document.getElementById("faviconWrap"),
  favicon: document.getElementById("favicon"),
  tabTitle: document.getElementById("tabTitle"),
  statusLine: document.getElementById("statusLine"),
  statusText: document.getElementById("statusText"),
  enabledToggle: document.getElementById("enabledToggle"),
  level: document.getElementById("level"),
  readoutValue: document.getElementById("readoutValue"),
  dbText: document.getElementById("dbText"),
  resetBtn: document.getElementById("resetBtn"),
  boostSlider: document.getElementById("boostSlider"),
  sliderZone: document.getElementById("sliderZone"),
  sliderNotch: document.getElementById("sliderNotch"),
  unityLabel: document.getElementById("unityLabel"),
  maxLabel: document.getElementById("maxLabel"),
  maxText: document.getElementById("maxText"),
  maxEditor: document.getElementById("maxEditor"),
  maxInput: document.getElementById("maxInput"),
  presets: Array.from(document.querySelectorAll("[data-preset]")),
  perSiteToggle: document.getElementById("perSiteToggle"),
  forgetBtn: document.getElementById("forgetBtn"),
  footerNormal: document.getElementById("footerNormal"),
  footerConfirm: document.getElementById("footerConfirm"),
  confirmText: document.getElementById("confirmText"),
  cancelForgetBtn: document.getElementById("cancelForgetBtn"),
  confirmForgetBtn: document.getElementById("confirmForgetBtn")
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

function sendMessage(message) {
  return API.runtime.sendMessage(message).catch((err) => {
    console.warn("[volume-boost] no answer from the background", err && err.message ? err.message : err);
    return null;
  });
}

// The gain in decibels: 200% is +6 dB. Whole decibels from 10 dB up.
function formatDb(value) {
  if (value <= 0) {
    return "Muted";
  }
  const db = 20 * Math.log10(value / 100);
  if (Math.abs(db) < 0.05) {
    return "0 dB";
  }
  const size = Math.abs(db);
  return (db > 0 ? "+" : "−") + size.toFixed(size >= 10 ? 0 : 1) + " dB";
}

// Everything that follows the level: readout, dB, warning, slider fill,
// the highlighted preset and whether Reset has anything to do.
function paintLevel(value) {
  const warn = value >= WARN_AT;
  elements.readoutValue.textContent = String(value);
  elements.dbText.textContent = formatDb(value) + (warn ? " · may distort" : "");
  elements.app.dataset.warn = warn ? "true" : "false";
  elements.level.style.setProperty("--f", String(maxBoostPercent > 0 ? value / maxBoostPercent : 0));
  elements.boostSlider.setAttribute("aria-valuetext", value + " percent" + (warn ? ", may distort" : ""));
  elements.resetBtn.disabled = value === UNITY;
  elements.presets.forEach((button) => {
    const on = resolvePresetValue(button.getAttribute("data-preset")) === value;
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function statusFor(state) {
  if (!state.enabled) {
    return { text: "Off for this tab", tone: "off" };
  }
  if (state.attached > 0) {
    return { text: "Boosting this tab", tone: "on" };
  }
  if (state.failed > 0) {
    return { text: "On — this page's media can't be boosted", tone: "warn" };
  }
  return { text: "On — waiting for audio or video", tone: "wait" };
}

function setStatusLine(text, tone) {
  elements.statusText.textContent = text;
  elements.statusText.title = text;
  elements.statusLine.dataset.tone = tone;
}

function renderStatus() {
  elements.enabledToggle.checked = tabState.enabled;
  elements.enabledToggle.disabled = activeTabId === null;
  elements.app.dataset.enabled = tabState.enabled ? "true" : "false";
  const status = statusFor(tabState);
  setStatusLine(status.text, status.tone);
}

// A one-off line in the status slot; the next renderStatus() replaces it.
// Problems are shown in the warning tone; other notes keep the current one.
function showMessage(text, { problem = true } = {}) {
  setStatusLine(text, problem ? "warn" : elements.statusLine.dataset.tone);
}

function updateMaxLabel() {
  elements.maxText.textContent = "Max " + maxBoostPercent + "%";
  elements.maxLabel.setAttribute("aria-label", "Change maximum, now " + maxBoostPercent + "%");
  elements.boostSlider.max = String(maxBoostPercent);

  const f100 = UNITY / maxBoostPercent;
  elements.level.style.setProperty("--f100", String(f100));
  elements.level.style.setProperty("--f300", String(Math.min(1, WARN_AT / maxBoostPercent)));
  elements.sliderNotch.hidden = maxBoostPercent <= UNITY;
  elements.sliderZone.hidden = maxBoostPercent <= WARN_AT;
  // The 100% label only where it clears "0%" and the Max button.
  elements.unityLabel.hidden = !(f100 > 0.15 && f100 < 0.72);
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
  paintLevel(clamped);
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
  updateMaxLabel();
  setSliderValue(UNITY);

  const tabs = await API.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0] ? tabs[0] : null;
  activeTabId = tab ? tab.id : null;

  if (tab && tab.title) {
    elements.tabTitle.textContent = tab.title;
  }

  if (tab && tab.favIconUrl) {
    elements.favicon.src = tab.favIconUrl;
    elements.faviconWrap.dataset.hasIcon = "true";
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

function openForgetConfirm() {
  if (savedSites === 1) {
    elements.confirmText.textContent = "Forget 1 site and reset?";
  } else if (savedSites > 1) {
    elements.confirmText.textContent = "Forget " + savedSites + " sites and reset?";
  } else {
    elements.confirmText.textContent = "Reset all settings?";
  }
  elements.confirmForgetBtn.textContent = savedSites > 0 ? "Forget" : "Reset";
  elements.footerNormal.hidden = true;
  elements.footerConfirm.hidden = false;
  elements.cancelForgetBtn.focus();
}

function closeForgetConfirm() {
  if (elements.footerConfirm.hidden) {
    return;
  }
  elements.footerConfirm.hidden = true;
  elements.footerNormal.hidden = false;
  elements.forgetBtn.focus();
}

async function forgetSites() {
  const hadSites = savedSites > 0;
  closeForgetConfirm();
  const response = await sendMessage({ type: "resetSettings" });
  await refresh();
  if (response && response.ok) {
    showMessage(hadSites ? "Saved sites forgotten, settings reset" : "Settings reset", { problem: false });
  }
}

function setupEvents() {
  elements.boostSlider.addEventListener("input", (event) => {
    const value = Number(event.target.value) || 0;
    paintLevel(value);
    scheduleBoostUpdate(value);
  });

  elements.resetBtn.addEventListener("click", () => {
    const value = setSliderValue(UNITY);
    scheduleBoostUpdate(value);
  });

  elements.favicon.addEventListener("error", () => {
    elements.faviconWrap.dataset.hasIcon = "false";
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

  elements.maxLabel.addEventListener("click", openMaxEditor);

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

  elements.forgetBtn.addEventListener("click", openForgetConfirm);
  elements.cancelForgetBtn.addEventListener("click", closeForgetConfirm);
  elements.confirmForgetBtn.addEventListener("click", forgetSites);
  elements.footerConfirm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeForgetConfirm();
    }
  });

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
