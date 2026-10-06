/* global browser, chrome */

(() => {
  // Content scripts of one extension share a sandbox per frame; a second
  // injection of this file must not build a second audio graph or answer
  // messages twice.
  if (globalThis.volumeBoostLoaded) {
    return;
  }
  globalThis.volumeBoostLoaded = true;

  const API = typeof browser !== "undefined" ? browser : chrome;

  const MAX_PERCENT = 1000;
  const MEDIA_SELECTOR = "audio, video";
  // Media events don't bubble, but they do pass document in the capture
  // phase. loadstart catches an element that gets a source (src, <source>,
  // srcObject) after it was inserted; play also resumes a suspended context.
  const MEDIA_EVENTS = ["loadstart", "play"];

  const state = {
    enabled: false,
    boostPercent: 100
  };

  let audioContext = null;
  let gainNode = null;
  let compressor = null;
  let observer = null;
  const sources = new WeakMap();
  const failedElements = new WeakSet();
  let attachedCount = 0;
  let failedCount = 0;
  let reportedCounts = null;
  const warned = new Set();

  function warnOnce(key, message, err) {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    console.warn("[volume-boost] " + message, err && err.message ? err.message : err || "");
  }

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

  function resumeContext() {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((err) => warnOnce("resume", "could not resume audio", err));
    }
  }

  function ensureAudioGraph() {
    if (typeof AudioContext === "undefined") {
      warnOnce("no-web-audio", "Web Audio is not available in this frame");
      return false;
    }

    if (!audioContext) {
      audioContext = new AudioContext();
      gainNode = audioContext.createGain();
      compressor = audioContext.createDynamicsCompressor();
      configureLimiter(compressor);

      gainNode.connect(compressor);
      compressor.connect(audioContext.destination);
    }

    resumeContext();
    return true;
  }

  function setGain(percent) {
    if (!gainNode || !audioContext) {
      return;
    }
    const value = clamp(percent, 0, MAX_PERCENT) / 100;
    gainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.015);
  }

  function isMediaElement(node) {
    return Boolean(node) && typeof node.matches === "function" && node.matches(MEDIA_SELECTOR);
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
        } catch (err) {
          warnOnce("seek", "could not restore the playback position", err);
        }
        if (wasPlaying) {
          const played = element.play();
          if (played && typeof played.catch === "function") {
            played.catch((err) => warnOnce("replay", "could not resume playback", err));
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
    } catch (err) {
      // Usually the page's own player already routes this element through
      // its AudioContext; an element can belong to only one.
      failedElements.add(element);
      failedCount += 1;
      warnOnce("attach", "a media element could not be routed through Web Audio", err);
    }
  }

  // Tell the background how many elements this frame holds, so the popup can
  // total them across frames. Sent only when the numbers change.
  function reportCounts() {
    const key = attachedCount + ":" + failedCount;
    if (key === reportedCounts) {
      return;
    }
    reportedCounts = key;
    API.runtime
      .sendMessage({ type: "frameStatus", attached: attachedCount, failed: failedCount })
      .catch((err) => warnOnce("report", "could not report to the background", err));
  }

  function scanAndAttach() {
    document.querySelectorAll(MEDIA_SELECTOR).forEach((element) => attachElement(element));
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isMediaElement(node)) {
          attachElement(node);
        } else if (node && typeof node.querySelectorAll === "function") {
          node.querySelectorAll(MEDIA_SELECTOR).forEach((element) => attachElement(element));
        }
      }
    }
    reportCounts();
  }

  function onMediaEvent(event) {
    if (isMediaElement(event.target)) {
      attachElement(event.target);
      reportCounts();
    }
    if (event.type === "play") {
      resumeContext();
    }
  }

  function startWatching() {
    if (observer) {
      return;
    }
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    MEDIA_EVENTS.forEach((type) => document.addEventListener(type, onMediaEvent, true));
  }

  function stopWatching() {
    if (!observer) {
      return;
    }
    observer.disconnect();
    observer = null;
    MEDIA_EVENTS.forEach((type) => document.removeEventListener(type, onMediaEvent, true));
  }

  function applyState() {
    if (!state.enabled) {
      setGain(100);
      stopWatching();
      return;
    }

    if (!ensureAudioGraph()) {
      return;
    }

    setGain(state.boostPercent);
    scanAndAttach();
    startWatching();
    reportCounts();
  }

  function snapshot() {
    return {
      ok: true,
      enabled: state.enabled,
      boostPercent: state.boostPercent,
      attached: attachedCount,
      failed: failedCount
    };
  }

  API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message" });
      return false;
    }

    switch (message.type) {
      case "applyBoost": {
        if (typeof message.boostPercent === "number") {
          state.boostPercent = clamp(message.boostPercent, 0, MAX_PERCENT);
        }
        if (typeof message.enabled === "boolean") {
          state.enabled = message.enabled;
        }
        applyState();
        sendResponse(snapshot());
        return false;
      }
      case "getState": {
        sendResponse(snapshot());
        return false;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
        return false;
    }
  });

  // A frame that loads into a tab already boosted (a reload, an embedded
  // player inserted later) asks whether to start boosted. While Firefox is
  // still starting, the background may not answer yet; no tab is boosted
  // then, so there is nothing to restore.
  API.runtime
    .sendMessage({ type: "frameReady" })
    .then((reply) => {
      if (reply && reply.enabled === true && typeof reply.boostPercent === "number") {
        state.enabled = true;
        state.boostPercent = clamp(reply.boostPercent, 0, MAX_PERCENT);
        applyState();
      }
    })
    .catch(() => {});
})();
