/* global browser, chrome */

const API = typeof browser !== "undefined" ? browser : chrome;
const AudioContextClass =
  typeof AudioContext !== "undefined"
    ? AudioContext
    : typeof webkitAudioContext !== "undefined"
      ? webkitAudioContext
      : null;

const state = {
  enabled: false,
  boostPercent: 100
};

let audioContext = null;
let gainNode = null;
let compressor = null;
let scanTimer = null;
const sources = new WeakMap();
const failedElements = new WeakSet();
let attachedCount = 0;
let failedCount = 0;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function configureLimiter(node) {
  node.threshold.value = -6;
  node.knee.value = 0;
  node.ratio.value = 12;
  node.attack.value = 0.003;
  node.release.value = 0.25;
}

function ensureAudioGraph() {
  if (!AudioContextClass) {
    return false;
  }

  if (!audioContext) {
    audioContext = new AudioContextClass();
    gainNode = audioContext.createGain();
    compressor = audioContext.createDynamicsCompressor();
    configureLimiter(compressor);

    gainNode.connect(compressor);
    compressor.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {
      // Ignore resume failures.
    });
  }

  return true;
}

function setGain(percent) {
  if (!gainNode || !audioContext) {
    return;
  }
  const value = clamp(percent, 0, 5000) / 100;
  gainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.015);
}

function hasMediaSource(element) {
  return Boolean(element.srcObject || element.currentSrc || element.src);
}

function isCorsEligible(element) {
  // srcObject (MediaStream) and blob:/data: sources are same-origin for Web
  // Audio purposes; only direct cross-origin URLs need CORS-mode fetching.
  if (element.srcObject) {
    return false;
  }
  const src = element.currentSrc || element.src;
  if (!src || src.startsWith("blob:") || src.startsWith("data:")) {
    return false;
  }
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch (_err) {
    return false;
  }
}

function reloadWithCors(element) {
  element.crossOrigin = "anonymous";
  if (element.readyState === 0) {
    return;
  }

  // crossorigin only applies to the next fetch, so already-loaded media must
  // be reloaded; restore position and playback state afterwards.
  const time = element.currentTime;
  const wasPlaying = !element.paused && !element.ended;
  element.addEventListener(
    "loadedmetadata",
    () => {
      try {
        element.currentTime = time;
      } catch (_err) {
        // Ignore seek failures.
      }
      if (wasPlaying) {
        const played = element.play();
        if (played && typeof played.catch === "function") {
          played.catch(() => {});
        }
      }
    },
    { once: true }
  );
  element.load();
}

function attachElement(element) {
  if (!element || sources.has(element) || failedElements.has(element)) {
    return;
  }

  if (!hasMediaSource(element)) {
    return;
  }

  if (!ensureAudioGraph()) {
    return;
  }

  if (isCorsEligible(element) && element.crossOrigin !== "anonymous") {
    reloadWithCors(element);
  }

  try {
    const source = audioContext.createMediaElementSource(element);
    source.connect(gainNode);
    sources.set(element, source);
    attachedCount += 1;
  } catch (_err) {
    failedElements.add(element);
    failedCount += 1;
  }
}

function scanAndAttach() {
  const elements = document.querySelectorAll("audio, video");
  if (!elements.length) {
    return;
  }

  elements.forEach((element) => attachElement(element));
}

function startScanning() {
  if (scanTimer) {
    return;
  }
  scanAndAttach();
  scanTimer = setInterval(scanAndAttach, 1000);
}

function stopScanning() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

function applyState() {
  if (!state.enabled) {
    setGain(100);
    stopScanning();
    return;
  }

  if (!ensureAudioGraph()) {
    return;
  }

  setGain(state.boostPercent);
  startScanning();
}

API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid message" });
    return false;
  }

  switch (message.type) {
    case "applyBoost": {
      if (typeof message.boostPercent === "number") {
        state.boostPercent = clamp(message.boostPercent, 0, 5000);
      }
      if (typeof message.enabled === "boolean") {
        state.enabled = message.enabled;
      }
      applyState();
      sendResponse({
        ok: true,
        enabled: state.enabled,
        boostPercent: state.boostPercent,
        attached: attachedCount,
        failed: failedCount
      });
      return false;
    }
    case "getState": {
      sendResponse({
        ok: true,
        enabled: state.enabled,
        boostPercent: state.boostPercent,
        attached: attachedCount,
        failed: failedCount
      });
      return false;
    }
    default:
      sendResponse({ ok: false, error: "Unknown message" });
      return false;
  }
});
