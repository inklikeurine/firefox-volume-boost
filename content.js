/* global API, MAX_PERCENT, clamp, warnOnce */

(() => {
  // Content scripts of one extension share a sandbox per frame; a second
  // injection of this file must not build a second audio graph or answer
  // messages twice.
  if (globalThis.volumeBoostLoaded) {
    return;
  }
  globalThis.volumeBoostLoaded = true;

  const MEDIA_SELECTOR = "audio, video";
  // Media events don't bubble, but they do pass document in the capture
  // phase. loadstart catches an element that gets a source (src, <source>,
  // srcObject) after it was inserted; play also resumes a suspended context.
  const MEDIA_EVENTS = ["loadstart", "play"];

  // The limiter is a soft clipper: the boosted signal passes unchanged up to
  // SOFT_KNEE of full scale, and peaks above that are rounded off smoothly so
  // the output never goes past full scale. A DynamicsCompressorNode can't do
  // this job: on audio mastered close to full scale (most streaming audio) it
  // takes back nearly all of the boost.
  const SOFT_KNEE = 0.8;
  // A WaveShaper clamps its input to [-1, 1], so the signal is scaled down by
  // CURVE_RANGE on the way in and the curve maps x to the output for an
  // amplitude of x * CURVE_RANGE (the most MAX_PERCENT can produce).
  const CURVE_RANGE = MAX_PERCENT / 100;
  const CURVE_POINTS = 8193;

  // Page-side property of a media element: the AudioContext it is routed
  // through (see "Earlier copies" below).
  const CONTEXT_KEY = "volumeBoostAudioContext";

  const state = {
    enabled: false,
    boostPercent: 100
  };

  let audioContext = null;
  let gainNode = null;
  let observer = null;
  const routed = new WeakSet();
  const refused = new WeakSet();
  let attachedCount = 0;
  let failedCount = 0;
  let reportedCounts = null;

  // --- Audio graph -------------------------------------------------------
  // One AudioContext per frame, built when the frame's first media element
  // attaches, so frames without media (ads, sign-in widgets) never open an
  // audio stream: media ─▶ gain ─▶ ÷CURVE_RANGE ─▶ soft clipper ─▶ speakers.

  // Linear below the knee; above it a tanh shoulder that leaves the knee at
  // slope 1 and flattens out at full scale.
  function softClipCurve() {
    const curve = new Float32Array(CURVE_POINTS);
    const headroom = 1 - SOFT_KNEE;
    for (let i = 0; i < CURVE_POINTS; i += 1) {
      const x = ((i / (CURVE_POINTS - 1)) * 2 - 1) * CURVE_RANGE;
      const level = Math.abs(x);
      const shaped =
        level <= SOFT_KNEE ? level : SOFT_KNEE + headroom * Math.tanh((level - SOFT_KNEE) / headroom);
      curve[i] = Math.sign(x) * shaped;
    }
    return curve;
  }

  function resumeContext() {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((err) => warnOnce("resume", "could not resume audio", err));
    }
  }

  function setGain(percent) {
    if (gainNode) {
      // A short ramp rather than a click on every slider movement.
      gainNode.gain.setTargetAtTime(clamp(percent, 0, MAX_PERCENT) / 100, audioContext.currentTime, 0.015);
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
      const curveInput = audioContext.createGain();
      curveInput.gain.value = 1 / CURVE_RANGE;
      const clipper = audioContext.createWaveShaper();
      clipper.curve = softClipCurve();
      gainNode.connect(curveInput);
      curveInput.connect(clipper);
      clipper.connect(audioContext.destination);
      setGain(state.boostPercent);
    }
    resumeContext();
    return true;
  }

  // --- Earlier copies ----------------------------------------------------
  // When Volume Boost is reloaded, updated or re-enabled with a page open,
  // Firefox discards the old content script but not its AudioContext, which
  // belongs to the page: it keeps playing the element at the old level, out
  // of reach, and attaching the element again would play it twice. So the
  // context an element is routed through is also kept on the page's side of
  // the element, where the next copy of this script finds it and closes it.
  // Closing it alone would leave the element silent (Firefox keeps its sound
  // captured), so that is only done right before the element is attached.

  function findEarlierContext(element) {
    const pageElement = element.wrappedJSObject;
    if (!pageElement || typeof XPCNativeWrapper !== "function" || !pageElement[CONTEXT_KEY]) {
      return null;
    }
    // Re-wrapped, so only the real AudioContext's own methods are used, never
    // anything the page put there.
    const context = XPCNativeWrapper(pageElement[CONTEXT_KEY]);
    const isLive = Object.prototype.toString.call(context) === "[object AudioContext]" && context.state !== "closed";
    return isLive ? context : null;
  }

  function closeEarlierContext(element) {
    const context = findEarlierContext(element);
    if (context) {
      context.close().catch((err) => warnOnce("stale", "could not stop an earlier copy's audio", err));
    }
  }

  function rememberContext(element) {
    if (element.wrappedJSObject) {
      element.wrappedJSObject[CONTEXT_KEY] = audioContext;
    }
  }

  // --- Attaching media -----------------------------------------------------

  function hasMediaSource(element) {
    return Boolean(element.srcObject || element.currentSrc || element.src);
  }

  // srcObject (MediaStream) and blob:/data: sources are same-origin for Web
  // Audio purposes; only direct cross-origin URLs need CORS-mode fetching,
  // or Web Audio outputs silence for them.
  function needsCors(element) {
    const src = element.currentSrc || element.src;
    if (element.srcObject || !src || src.startsWith("blob:") || src.startsWith("data:")) {
      return false;
    }
    try {
      return new URL(src, window.location.href).origin !== window.location.origin;
    } catch (_err) {
      return false;
    }
  }

  // crossorigin only applies to the next fetch, so already-loaded media is
  // reloaded, keeping its position and whether it was playing.
  function reloadWithCors(element) {
    element.crossOrigin = "anonymous";
    if (element.readyState === 0) {
      return;
    }
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
          Promise.resolve(element.play()).catch((err) => warnOnce("replay", "could not resume playback", err));
        }
      },
      { once: true }
    );
    element.load();
  }

  function attachElement(element) {
    if (routed.has(element) || refused.has(element) || !hasMediaSource(element) || !ensureAudioGraph()) {
      return;
    }
    if (needsCors(element) && element.crossOrigin !== "anonymous") {
      reloadWithCors(element);
    }
    closeEarlierContext(element);
    try {
      audioContext.createMediaElementSource(element).connect(gainNode);
      routed.add(element);
      rememberContext(element);
      attachedCount += 1;
    } catch (err) {
      // Firefox rarely refuses (it lets one element feed several contexts);
      // the warning says why.
      refused.add(element);
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

  // --- Finding media ---------------------------------------------------------
  // Everything already in the page when boost goes on, then, while it is on,
  // media inserted later and media that gets a source later — no polling.

  function isMediaElement(node) {
    return Boolean(node) && typeof node.matches === "function" && node.matches(MEDIA_SELECTOR);
  }

  function attachAllIn(root) {
    root.querySelectorAll(MEDIA_SELECTOR).forEach(attachElement);
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isMediaElement(node)) {
          attachElement(node);
        } else if (node && typeof node.querySelectorAll === "function") {
          attachAllIn(node);
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

  // --- Boost on and off --------------------------------------------------------
  // Off sets the gain back to 100% and stops watching. Routed elements stay
  // routed: an element can't be taken back out of Web Audio, and closing the
  // context would silence it.

  function applyState() {
    if (!state.enabled) {
      setGain(100);
      stopWatching();
      return;
    }
    setGain(state.boostPercent);
    resumeContext();
    attachAllIn(document);
    startWatching();
    reportCounts();
  }

  API.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "applyBoost") {
      sendResponse({ ok: false, error: message && message.type ? "Unknown message" : "Invalid message" });
      return false;
    }
    if (typeof message.boostPercent === "number") {
      state.boostPercent = clamp(message.boostPercent, 0, MAX_PERCENT);
    }
    if (typeof message.enabled === "boolean") {
      state.enabled = message.enabled;
    }
    applyState();
    sendResponse({ ok: true });
    return false;
  });

  // --- Start-up --------------------------------------------------------------

  // Media an earlier copy of this script left routed through its context, at
  // its last level: the tab isn't boosted until the background says so, so
  // take it over now, at 100%.
  const leftOver = Array.from(document.querySelectorAll(MEDIA_SELECTOR)).filter(findEarlierContext);
  if (leftOver.length > 0) {
    leftOver.forEach(attachElement);
    reportCounts();
  }

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
