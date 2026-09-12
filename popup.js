/* global browser, chrome */

const API = typeof browser !== "undefined" ? browser : chrome;

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
  presets: Array.from(document.querySelectorAll("[data-preset]")),
  perSiteToggle: document.getElementById("perSiteToggle"),
  warning: document.getElementById("warning")
};

let activeTabId = null;
let maxBoostPercent = 600;
let rafId = null;
let pendingBoost = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sendMessage(message) {
  try {
    const result = API.runtime.sendMessage(message);
    if (result && typeof result.then === "function") {
      return result;
    }
  } catch (_err) {
    // Fall through.
  }

  return new Promise((resolve) => {
    API.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function setSliderFill(value) {
  const percent = maxBoostPercent ? (value / maxBoostPercent) * 100 : 0;
  elements.boostSlider.style.background =
    "linear-gradient(90deg, var(--accent) 0%, var(--accent) " +
    percent +
    "%, rgba(127, 127, 127, 0.3) " +
    percent +
    "%)";
}

function setReadout(value) {
  elements.readout.textContent = value + "%";
}

function updateWarning(value) {
  if (value >= 1000) {
    elements.warning.classList.add("show");
  } else {
    elements.warning.classList.remove("show");
  }
}

function setEnabledUI(enabled) {
  elements.enabledToggle.checked = enabled;
  elements.app.dataset.enabled = enabled ? "true" : "false";
  elements.statusText.textContent = enabled ? "Boost On" : "Boost Off";
}

function updateMaxLabel() {
  elements.maxLabel.textContent = "Max " + maxBoostPercent + "%";
  elements.boostSlider.max = String(maxBoostPercent);
}

function resolvePresetValue(token) {
  if (token === "max-20") {
    return Math.max(0, maxBoostPercent - 20);
  }
  return Number(token) || 0;
}

function setSliderValue(value) {
  const clamped = clamp(value, 0, maxBoostPercent);
  elements.boostSlider.value = String(clamped);
  setReadout(clamped);
  setSliderFill(clamped);
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

  if (activeTabId === null) {
    setEnabledUI(false);
    return;
  }

  const state = await sendMessage({ type: "getState", tabId: activeTabId });
  if (state) {
    maxBoostPercent = clamp(state.maxBoostPercent || 600, 1, 5000);
    updateMaxLabel();
    elements.perSiteToggle.checked = Boolean(state.perSite);
    setEnabledUI(Boolean(state.enabled));
    setSliderValue(state.boostPercent || 0);
  }
}

function setupEvents() {
  elements.boostSlider.addEventListener("input", (event) => {
    const value = Number(event.target.value) || 0;
    setReadout(value);
    setSliderFill(value);
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

    const enabled = elements.enabledToggle.checked;
    const boostValue = Number(elements.boostSlider.value) || 0;

    if (enabled) {
      await sendMessage({ type: "setBoost", tabId: activeTabId, value: boostValue });
    }

    const response = await sendMessage({
      type: "setEnabled",
      tabId: activeTabId,
      value: enabled,
      boostPercent: boostValue
    });

    if (response && response.error) {
      setEnabledUI(false);
      elements.statusText.textContent = response.error;
      return;
    }

    setEnabledUI(enabled);

    if (response && response.warning) {
      elements.statusText.textContent = response.warning;
    }
  });

  elements.perSiteToggle.addEventListener("change", async () => {
    if (activeTabId === null) {
      return;
    }
    const response = await sendMessage({
      type: "setPerSite",
      tabId: activeTabId,
      value: elements.perSiteToggle.checked
    });
    if (response && typeof response.perSite === "boolean") {
      elements.perSiteToggle.checked = response.perSite;
    }
  });

  elements.maxLabel.addEventListener("dblclick", async () => {
    const input = window.prompt("Set max boost percentage", String(maxBoostPercent));
    if (input === null) {
      return;
    }

    const parsed = Math.round(Number(input));
    if (!Number.isFinite(parsed) || parsed < 1) {
      elements.statusText.textContent = "Max must be 1% or higher";
      return;
    }

    maxBoostPercent = clamp(parsed, 1, 5000);
    const response = await sendMessage({ type: "setMaxBoost", value: maxBoostPercent });
    if (response && response.maxBoostPercent) {
      maxBoostPercent = response.maxBoostPercent;
    }

    updateMaxLabel();
    const current = Number(elements.boostSlider.value) || 0;
    if (current > maxBoostPercent) {
      const value = setSliderValue(maxBoostPercent);
      scheduleBoostUpdate(value);
    } else {
      setSliderFill(current);
    }
  });

  elements.presets.forEach((button) => {
    button.addEventListener("click", () => {
      const token = button.getAttribute("data-preset");
      const value = resolvePresetValue(token);
      const clamped = setSliderValue(value);
      scheduleBoostUpdate(clamped);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  init();
});
