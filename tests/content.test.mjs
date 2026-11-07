// Volume Boost — content.js (after lib/common.js, as in the manifest) under a
// DOM + Web Audio stand-in, and under jsdom for the parts that need a real DOM
// (MutationObserver, capture-phase media events). Proves the graph is built
// once, media elements attach exactly once, cross-origin elements are reloaded
// in CORS mode, new media is noticed without polling, media left by an earlier
// copy is taken over, and the frame reports its counts to the background.
import { T, loadScripts, makeBrowserShim, makeDocumentShim, makeAudioContextShim, makeDom } from '../../firefox-tools/harness/lib.mjs';

// A MutationObserver stand-in for the document shim: records observe /
// disconnect and lets a test deliver records by hand.
function makeObserverShim() {
  const instances = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.observing = false; instances.push(this); }
    observe(target, options) { this.observing = true; this.target = target; this.options = options; }
    disconnect() { this.observing = false; }
  }
  return { MutationObserver, instances, deliver: (records) => { for (const o of instances) if (o.observing) o.cb(records, o); } };
}

// The background's side of runtime.sendMessage, as seen from a content script.
function wireBackground(shim, { ready = { enabled: false } } = {}) {
  const sent = [];
  shim.browser.runtime.sendMessage = (message) => {
    sent.push(message);
    return Promise.resolve(message.type === 'frameReady' ? ready : { ok: true });
  };
  return sent;
}

function boot({ elements = [], location = 'https://page.test/watch', audio = true, ready, xray = false } = {}) {
  const shim = makeBrowserShim();
  const sent = wireBackground(shim, { ready });
  const dom = makeDocumentShim({ location, elements });
  for (const el of dom.elements) { el.nodeType = 1; el.matches = (sel) => /audio|video/.test(sel); }
  const docListeners = [];
  dom.document.addEventListener = (type, fn, capture) => docListeners.push({ type, fn, capture });
  dom.document.removeEventListener = (type, fn, capture) => {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) docListeners.splice(i, 1);
  };
  const mo = makeObserverShim();
  const ac = makeAudioContextShim();
  const globals = { browser: shim.browser, document: dom.document, location: dom.location, MutationObserver: mo.MutationObserver };
  if (audio) globals.AudioContext = ac.AudioContext;
  // Firefox's re-wrapping of a page-side object; the shim has no Xrays.
  if (xray) globals.XPCNativeWrapper = (obj) => obj;
  const ctx = loadScripts(SCRIPTS, globals);
  const addElement = (e) => { const el = dom.addElement(e); el.nodeType = 1; el.matches = (sel) => /audio|video/.test(sel); return el; };
  const fire = (type, target) => { for (const l of docListeners.filter((x) => x.type === type)) l.fn({ type, target }); };
  return { shim, dom, ac, ctx, mo, sent, docListeners, addElement, fire, globals, send: (m) => shim.sendToBackground(m) };
}
const SCRIPTS = [T.extFile('lib/common.js'), T.extFile('content.js')];
const gainValues = (ac) => ac.log.filter((l) => l.param === 'gain').map((l) => l.value);
const reports = (sent) => sent.filter((m) => m.type === 'frameStatus').map((m) => [m.attached, m.failed]);
// [attached, failed] as last reported to the background.
const counts = (sent) => reports(sent).at(-1) ?? [0, 0];

T.runAsync('initial state: nothing attached, no AudioContext; asks the background once', async () => {
  const { ac, sent, mo } = boot({ elements: [{ src: 'https://page.test/a.mp3' }] });
  T.eq(ac.instances.length, 0, 'graph is built lazily');
  T.eq(sent, [{ type: 'frameReady' }], 'one frameReady, no reports while off');
  T.eq(mo.instances.length, 0, 'no observer while off');
});

T.runAsync('a frame loading into a boosted tab starts boosted (frameReady)', async () => {
  const { ac, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3' }], ready: { enabled: true, boostPercent: 180 } });
  await T.sleep(10);
  T.eq(counts(sent), [1, 0]);
  T.eq(gainValues(ac).at(-1), 1.8);
});

T.runAsync('a second injection into the same frame is a no-op', async () => {
  const shim = makeBrowserShim();
  const sent = wireBackground(shim);
  const dom = makeDocumentShim();
  const mo = makeObserverShim();
  loadScripts([...SCRIPTS, ...SCRIPTS], { browser: shim.browser, document: dom.document, location: dom.location, MutationObserver: mo.MutationObserver });
  T.eq(shim.listeners.message.length, 1, 'one onMessage listener');
  T.eq(sent.filter((m) => m.type === 'frameReady').length, 1, 'one frameReady');
});

T.runAsync('applyBoost builds the graph once, attaches every media element and reports the counts', async () => {
  const { send, ac, dom, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3' }, { src: 'https://cdn.other.test/b.mp4', readyState: 0 }] });
  T.eq(await send({ type: 'applyBoost', enabled: true, boostPercent: 250 }), { ok: true });
  T.eq(ac.instances.length, 1, 'one AudioContext');
  T.eq(ac.log.filter((l) => l.connect && l.connect !== 'source').map((l) => [l.connect, l.to]),
    [['gain', 'gain'], ['gain', 'shaper'], ['shaper', 'destination']], 'gain → ÷10 → soft clipper → destination, once');
  T.eq(ac.log.filter((l) => l.connect === 'source').length, 2, 'both sources → gain');
  T.eq(gainValues(ac).at(-1), 2.5, 'gain 250% → 2.5');
  T.eq(ac.instances[0].state, 'running', 'suspended context resumed');
  const [same, cross] = dom.elements;
  T.eq(same.crossOrigin, null, 'same-origin element untouched');
  T.eq(cross.crossOrigin, 'anonymous', 'cross-origin element switched to CORS mode');
  T.eq(cross.loads, 0, 'readyState 0 → no reload needed (crossorigin applies to the first fetch)');
  const nodes = ac.instances[0].nodes;
  T.eq(nodes.some((n) => n.kind === 'compressor'), false, 'no DynamicsCompressor');
  T.eq(nodes.filter((n) => n.kind === 'gain')[1].gain.value, 0.1, 'curve input scaled by 1/10');
  const shaper = nodes.find((n) => n.kind === 'shaper');
  T.ok(Object.prototype.toString.call(shaper.curve) === '[object Float32Array]' && shaper.curve.length === 8193, 'soft-clip curve set');
  T.eq(shaper.oversample, 'none', 'no oversampling (its filters overshoot full scale)');
  T.eq(reports(sent), [[2, 0]], 'counts reported once');
});

T.runAsync('re-applying does not double-attach or re-report; gain follows the new level', async () => {
  const { send, ac, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 400 });
  T.eq(ac.instances[0].sources.length, 1, 'still one source');
  T.eq(gainValues(ac).at(-1), 4, 'gain 400% → 4');
  T.eq(reports(sent), [[1, 0]], 'unchanged counts are not re-sent');
});

T.runAsync('enabling starts one observer and two capture listeners; disabling removes them and restores unity gain', async () => {
  const { send, ac, mo, docListeners } = boot({ elements: [{ src: 'https://page.test/a.mp3' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 300 });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 320 });
  T.eq(mo.instances.length, 1, 'one observer, even after a second applyBoost');
  T.eq(mo.instances[0].options, { childList: true, subtree: true });
  T.eq(docListeners.map((l) => [l.type, l.capture]), [['loadstart', true], ['play', true]]);
  await send({ type: 'applyBoost', enabled: false });
  T.eq(gainValues(ac).at(-1), 1, 'gain back to 1.0');
  T.eq(mo.instances[0].observing, false, 'observer disconnected');
  T.eq(docListeners.length, 0, 'listeners removed');
});

T.runAsync('an inserted media element (or one inside an inserted node) is attached via the observer', async () => {
  const { send, mo, addElement, sent } = boot({ elements: [] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 150 });
  const late = addElement({ src: 'https://page.test/late.mp3' });
  mo.deliver([{ addedNodes: [late] }]);
  const nested = addElement({ src: 'https://page.test/nested.mp3' });
  const wrapper = { nodeType: 1, matches: () => false, querySelectorAll: () => [nested] };
  mo.deliver([{ addedNodes: [{ nodeType: 3 }, wrapper] }]);
  T.eq(reports(sent), [[0, 0], [1, 0], [2, 0]], 'nothing yet; the direct insert; the one inside an inserted subtree (text nodes ignored)');
});

T.runAsync('an element that gets a source later is attached on its loadstart; play resumes a suspended context', async () => {
  const { send, dom, fire, ac, sent } = boot({ elements: [{ src: '' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  T.eq(counts(sent), [0, 0], 'no source → skipped');
  dom.elements[0].src = dom.elements[0].currentSrc = 'https://page.test/now.mp3';
  fire('loadstart', dom.elements[0]);
  T.eq(counts(sent), [1, 0], 'attached on loadstart');
  ac.instances[0].state = 'suspended';
  fire('play', dom.elements[0]);
  T.eq(ac.instances[0].state, 'running', 'resumed on play');
  fire('play', { matches: () => false });
  T.eq(ac.instances[0].sources.length, 1, 'events from non-media targets ignored');
});

T.runAsync('an element that refuses attachment is counted once and never retried', async () => {
  const { send, dom, fire, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3' }, { src: 'https://page.test/drm.mp4' }] });
  dom.elements[1].__failAttach = true;
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  T.eq(counts(sent), [1, 1]);
  fire('loadstart', dom.elements[1]);
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  T.eq(reports(sent), [[1, 1]], 'no double counting on rescan or events');
});

T.runAsync('srcObject, blob: and data: sources are never switched to CORS mode', async () => {
  const { send, dom, sent } = boot({ elements: [{ srcObject: { kind: 'stream' } }, { src: 'blob:https://page.test/xyz' }, { src: 'data:audio/wav;base64,AAAA' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  T.eq(counts(sent), [3, 0], 'all three attach');
  for (const el of dom.elements) T.eq(el.crossOrigin, null, 'no crossOrigin change');
});

T.runAsync('a loaded cross-origin element is reloaded in CORS mode with position and playback restored', async () => {
  const el = { src: 'https://cdn.other.test/movie.mp4', readyState: 4, paused: false, currentTime: 42.5 };
  const { send, dom } = boot({ elements: [el] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  const media = dom.elements[0];
  T.eq(media.crossOrigin, 'anonymous');
  T.eq(media.loads, 1, 'load() called once');
  media.currentTime = 0; // the reload reset it
  media.paused = true;
  media.dispatch('loadedmetadata');
  T.eq(media.currentTime, 42.5, 'position restored');
  T.eq(media.plays, 1, 'playback resumed');
});

// The output for an input amplitude `a` (before the ÷10 stage), read off the
// curve the way a WaveShaperNode does: linear interpolation over [-1, 1].
function shape(curve, a) {
  const x = Math.max(-1, Math.min(1, a / 10));
  const pos = ((x + 1) / 2) * (curve.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i >= curve.length - 1 ? curve[curve.length - 1] : curve[i] * (1 - f) + curve[i + 1] * f;
}

T.runAsync('soft clipper: unchanged below 0.8, smooth and monotonic above, never past full scale', async () => {
  const { send, ac } = boot({ elements: [{ src: 'https://page.test/a.mp3' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  const curve = ac.instances[0].nodes.find((n) => n.kind === 'shaper').curve;
  T.eq(curve[(curve.length - 1) / 2], 0, 'silence stays silence');
  for (const a of [0.01, 0.1, 0.5, 0.79]) {
    T.ok(Math.abs(shape(curve, a) - a) < 1e-6 && Math.abs(shape(curve, -a) + a) < 1e-6, `linear and symmetric at ${a}`);
  }
  T.ok(shape(curve, 0.9) < 0.9 && shape(curve, 0.9) > 0.88, 'just above the knee: barely touched');
  T.ok(shape(curve, 1) > 0.94 && shape(curve, 1) < 0.96, 'full-scale input rounded to ~0.95');
  T.ok(Math.max(...curve.map(Math.abs)) <= 1, 'output never passes full scale');
  let monotonic = true;
  for (let i = 1; i < curve.length; i += 1) if (curve[i] < curve[i - 1]) monotonic = false;
  T.ok(monotonic, 'monotonic: louder in, never quieter out');
  T.ok(shape(curve, 10) > 0.99, 'the most 1000% can produce is still inside the curve');
});

T.runAsync('a boosted frame without media builds no audio graph until media appears, then starts at the current level', async () => {
  const { send, ac, mo, addElement } = boot({ elements: [] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 170 });
  T.eq(ac.instances.length, 0, 'no AudioContext for a frame without media');
  const late = addElement({ src: 'https://page.test/late.mp3' });
  mo.deliver([{ addedNodes: [late] }]);
  T.eq(ac.instances.length, 1, 'built on the first attach');
  T.eq(gainValues(ac).at(-1), 1.7, 'at the level already set');
  T.eq(ac.instances[0].state, 'running', 'resumed');
});

// An AudioContext left by an earlier copy of the script (Volume Boost
// reloaded or updated with the page open), still playing the element.
function staleContext() {
  const old = makeAudioContextShim();
  const ctx = new old.AudioContext();
  ctx.state = 'running';
  return { ctx, old };
}

T.runAsync('on start-up, media left playing by an earlier copy is taken over at 100% and the old context closed', async () => {
  const { ctx: old, old: oldShim } = staleContext();
  const page = { volumeBoostAudioContext: old };
  const other = {};
  const { send, ac, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3', page }, { src: 'https://page.test/b.mp3', page: other }], xray: true });
  T.eq(old.state, 'closed', 'old context closed');
  T.eq(oldShim.log.filter((l) => l.close).length, 1, 'closed once');
  T.eq(reports(sent), [[1, 0]], 'only the left-over element taken over, and reported');
  T.eq(gainValues(ac).at(-1), 1, 'at 100%: the original volume');
  T.ok(page.volumeBoostAudioContext === ac.instances[0], 'page side now points at the new context');
  await send({ type: 'applyBoost', enabled: true, boostPercent: 200 });
  T.eq(counts(sent), [2, 0], 'switching boost on attaches the other element too');
  T.ok(other.volumeBoostAudioContext === ac.instances[0], 'every attach records its context on the page side');
  T.eq(ac.instances[0].sources.filter((src) => src.element.src === 'https://page.test/a.mp3').length, 1, 'the taken-over element is not attached twice');
  T.eq(gainValues(ac).at(-1), 2);
});

T.runAsync('on start-up, nothing is taken over or reported when no earlier copy left media behind', async () => {
  const { ctx: closed } = staleContext();
  closed.state = 'closed';
  let called = false;
  const fake = { state: 'running', close() { called = true; return Promise.resolve(); } };
  const { ac, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3', page: { volumeBoostAudioContext: closed } }, { src: 'https://page.test/b.mp3', page: { volumeBoostAudioContext: fake } }], xray: true });
  T.eq(called, false, "the page's object is never called");
  T.eq(ac.instances.length, 0, 'a closed context or a page-made object is not left-over media: nothing built');
  T.eq(reports(sent), [], 'no report');
});

T.runAsync('when boost is switched on, a stale context on an element is closed before it is attached', async () => {
  const { ctx: old } = staleContext();
  const page = {};
  const { send, addElement, mo, sent } = boot({ elements: [], xray: true });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 150 });
  page.volumeBoostAudioContext = old;
  const late = addElement({ src: 'https://page.test/late.mp3', page });
  mo.deliver([{ addedNodes: [late] }]);
  T.eq(old.state, 'closed');
  T.eq(counts(sent), [1, 0]);
});

T.runAsync('boost percent is clamped to the 0–1000 hard cap', async () => {
  const { send, ac } = boot({ elements: [{ src: 'https://page.test/a.mp3' }] });
  await send({ type: 'applyBoost', enabled: true, boostPercent: 99999 });
  T.eq(gainValues(ac).at(-1), 10);
  await send({ type: 'applyBoost', enabled: true, boostPercent: -3 });
  T.eq(gainValues(ac).at(-1), 0);
});

T.runAsync('without Web Audio the script degrades: no throw, nothing attached', async () => {
  const { send, sent } = boot({ elements: [{ src: 'https://page.test/a.mp3' }], audio: false });
  T.eq(await send({ type: 'applyBoost', enabled: true, boostPercent: 200 }), { ok: true });
  T.eq(counts(sent), [0, 0]);
});

T.runAsync('malformed and unknown messages are answered', async () => {
  const { send } = boot();
  T.eq(await send({ type: 'nope' }), { ok: false, error: 'Unknown message' });
  T.eq(await send({}), { ok: false, error: 'Invalid message' });
});

// --- jsdom: the real MutationObserver and real capture-phase events ---------

function bootDom(html) {
  const shim = makeBrowserShim();
  const sent = wireBackground(shim);
  const d = makeDom({ html, url: 'https://page.test/watch', browser: shim.browser });
  const ac = makeAudioContextShim();
  d.window.AudioContext = ac.AudioContext;
  d.runScripts(SCRIPTS);
  return { ...d, shim, sent, ac, send: (m) => shim.sendToBackground(m) };
}

T.runAsync('jsdom: media inserted after enabling, even nested, is attached without polling', async () => {
  const { document, send, sent } = bootDom('<!doctype html><body><video src="/a.mp4"></video></body>');
  await send({ type: 'applyBoost', enabled: true, boostPercent: 150 });
  T.eq(counts(sent), [1, 0]);
  const audio = document.createElement('audio');
  audio.src = '/late.mp3';
  document.body.append(audio);
  const wrap = document.createElement('div');
  wrap.innerHTML = '<section><video src="https://cdn.other.test/v.mp4"></video></section>';
  document.body.append(wrap);
  await T.sleep(10); // MutationObserver callbacks are microtasks
  T.eq(counts(sent), [3, 0]);
  T.eq(wrap.querySelector('video').crossOrigin, 'anonymous', 'nested cross-origin video switched to CORS mode');
});

T.runAsync('jsdom: an element given a source later attaches on its loadstart; nothing happens while off', async () => {
  const { document, window, send, sent } = bootDom('<!doctype html><body><video id="v"></video></body>');
  await send({ type: 'applyBoost', enabled: true, boostPercent: 150 });
  const video = document.getElementById('v');
  T.eq(counts(sent), [0, 0], 'no source yet');
  video.src = '/now.mp4';
  video.dispatchEvent(new window.Event('loadstart')); // does not bubble: reaches document only in the capture phase
  T.eq(counts(sent), [1, 0]);
  await send({ type: 'applyBoost', enabled: false });
  const later = document.createElement('audio');
  later.src = '/off.mp3';
  document.body.append(later);
  later.dispatchEvent(new window.Event('loadstart'));
  await T.sleep(10);
  T.eq(counts(sent), [1, 0], 'not attached while boost is off');
});

await T.exit();
