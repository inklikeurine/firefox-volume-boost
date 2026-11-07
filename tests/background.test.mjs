// Volume Boost — background.js (after lib/common.js, as in the manifest)
// under the browser.* shim. Exercises every message type through the real
// onMessage listener plus the tab lifecycle hooks, the badge and the CORS
// header injector.
import { T, loadScripts, makeBrowserShim } from '../../firefox-tools/harness/lib.mjs';

const TABS = [
  { id: 1, url: 'https://a.test/watch?v=1', active: true, title: 'A' },
  { id: 2, url: 'https://b.test/', active: false, title: 'B' },
  { id: 3, url: undefined, active: false, title: undefined }, // a Firefox page: no origin for per-site
];

function boot({ storage = {}, tabs = TABS, content = {} } = {}) {
  const shim = makeBrowserShim({ tabs: structuredClone(tabs), storage });
  for (const [id, responder] of Object.entries(content)) shim.attachContent(Number(id), responder);
  const ctx = loadScripts([T.extFile('lib/common.js'), T.extFile('background.js')], { browser: shim.browser });
  return { shim, ctx };
}
const send = (shim, msg) => shim.sendToBackground(msg);
// A message from a content script in frame `frameId` of tab `tabId`.
const fromFrame = (shim, tabId, frameId, msg) => shim.sendToBackground(msg, { tab: shim.tabs.find((t) => t.id === tabId), frameId, id: 'content' });
const okContent = (attached = 1, failed = 0) => (message, _sender, sendResponse) => {
  sendResponse({ ok: true, enabled: message.enabled, boostPercent: message.boostPercent, attached, failed });
  return false;
};
const badgeFor = (shim, tabId) => shim.callsTo('browserAction.setBadgeText').map((c) => c.args[0]).filter((d) => d.tabId === tabId).at(-1)?.text;
const lastApply = (shim, tabId) => shim.callsTo('tabs.sendMessage').filter((c) => c.args[0] === tabId).at(-1)?.args[1];

T.runAsync('registers message, install and tab listeners; badge colour set once', async () => {
  const { shim } = boot();
  T.eq(shim.listeners.message.length, 1, 'onMessage');
    T.eq(shim.listeners.activated.length, 0, 'switching tabs changes nothing, so no onActivated');
  T.eq(shim.listeners.updated.length, 1, 'tabs.onUpdated');
  T.eq(shim.listeners.removed.length, 1, 'tabs.onRemoved');
  T.eq(shim.listeners.headers.length, 0, 'no CORS listener until a tab is boosted');
  T.eq(shim.callsTo('browserAction.setBadgeBackgroundColor').map((c) => c.args[0]), [{ color: '#1f7a75' }]);
});

T.runAsync('getState returns defaults on empty storage', async () => {
  const { shim } = boot();
  const r = await send(shim, { type: 'getState', tabId: 1 });
  T.eq(r, { enabled: false, boostPercent: 100, maxBoostPercent: 200, perSite: false, savedSites: 0, attached: 0, failed: 0 });
});

T.runAsync('corrupt storage falls back to defaults and clamps; 0% is a real value', async () => {
  const { shim } = boot({ storage: { maxBoostPercent: 'abc', boostPercent: 99999, perSite: 'yes', siteBoosts: 'nope' } });
  const r = await send(shim, { type: 'getState', tabId: 1 });
  T.eq(r.maxBoostPercent, 200, 'NaN max → default');
  T.eq(r.boostPercent, 200, 'boost clamped to max');
  T.eq(r.perSite, true, 'truthy string → true (Boolean cast)');
  T.eq(r.savedSites, 0, 'garbage siteBoosts → none');
  const { shim: s2 } = boot({ storage: { boostPercent: 0, maxBoostPercent: 5000, siteBoosts: { 'https://a.test': 'x', 'https://b.test': 4000 }, perSite: true } });
  const r2 = await send(s2, { type: 'getState', tabId: 2 });
  T.eq(r2.maxBoostPercent, 1000, 'stored max above the 1000 cap is clamped');
  T.eq(r2.boostPercent, 1000, 'site level clamped to the max');
  T.eq(r2.savedSites, 1, 'non-number site level dropped');
  T.eq((await send(s2, { type: 'getState', tabId: 3 })).boostPercent, 0, 'stored 0% survives a restart');
});

T.runAsync('setBoost clamps to [0, max] and persists after the debounce', async () => {
  const { shim } = boot();
  T.eq((await send(shim, { type: 'setBoost', tabId: 1, value: 900 })).boostPercent, 200, 'above max');
  T.eq((await send(shim, { type: 'setBoost', tabId: 1, value: -5 })).boostPercent, 0, 'below zero');
  T.eq((await send(shim, { type: 'setBoost', tabId: 1, value: 'x' })).boostPercent, 0, 'non-number → 0');
  T.eq((await send(shim, { type: 'setBoost', tabId: 1, value: 150 })).boostPercent, 150, 'in range');
  T.eq(shim.callsTo('storage.local.set').length, 0, 'not saved synchronously (debounced)');
  await T.sleep(300);
  T.eq(shim.callsTo('storage.local.set').length, 1, 'one save after the debounce');
  T.eq(shim.store.boostPercent, 150, 'persisted value');
});

T.runAsync('setMaxBoost re-clamps the boost, every per-site level and every boosted tab', async () => {
  const { shim } = boot({
    storage: { boostPercent: 500, maxBoostPercent: 800, perSite: true, siteBoosts: { 'https://a.test': 550, 'https://b.test': 100 } },
    content: { 1: okContent(), 2: okContent() },
  });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 700 });
  await send(shim, { type: 'setEnabled', tabId: 2, value: true, boostPercent: 100 });
  const r = await send(shim, { type: 'setMaxBoost', value: 300 });
  T.eq(r.maxBoostPercent, 300);
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).boostPercent, 300, 'boosted tab 1 clamped');
  T.eq(lastApply(shim, 1), { type: 'applyBoost', enabled: true, boostPercent: 300 }, 'and re-applied');
  T.eq(badgeFor(shim, 1), '300', 'badge follows');
  T.eq((await send(shim, { type: 'getState', tabId: 2 })).boostPercent, 100, 'tab 2 under the max: untouched');
  await send(shim, { type: 'setEnabled', tabId: 1, value: false });
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).boostPercent, 300, 'site a level clamped');
  T.eq((await send(shim, { type: 'setMaxBoost', value: 0 })).maxBoostPercent, 200, 'zero → default 200');
  T.eq((await send(shim, { type: 'setMaxBoost', value: 99999 })).maxBoostPercent, 1000, 'hard cap 1000');
  T.eq((await send(shim, { type: 'setMaxBoost', value: 'abc' })).maxBoostPercent, 200, 'non-number → default');
});

T.runAsync('setEnabled applies boost, sets the badge and arms the CORS injector for that tab only', async () => {
  const { shim, ctx } = boot({ content: { 1: okContent(2) } });
  const r = await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 150 });
  T.eq(r, { enabled: true });
  const sent = shim.callsTo('tabs.sendMessage');
  T.eq(sent.length, 1, 'one message to the tab');
  T.eq(sent[0].args, [1, { type: 'applyBoost', enabled: true, boostPercent: 150 }]);
  T.eq(badgeFor(shim, 1), '150', 'badge shows the level');
  T.eq(shim.listeners.headers.length, 1, 'onHeadersReceived registered');
  T.eq(shim.listeners.headers[0].rest, [{ urls: ['<all_urls>'], types: ['media'] }, ['blocking', 'responseHeaders']], 'filter: media only, blocking');
  const withTab = ctx.injectCorsHeaders({ tabId: 1, responseHeaders: [{ name: 'Content-Type', value: 'audio/mpeg' }] });
  T.eq(withTab.responseHeaders.find((h) => h.name === 'Access-Control-Allow-Origin')?.value, '*', 'ACAO added for the boosted tab');
  const otherTab = ctx.injectCorsHeaders({ tabId: 2, responseHeaders: [{ name: 'Content-Type', value: 'audio/mpeg' }] });
  T.eq(otherTab, {}, 'untouched for other tabs');
  const existing = ctx.injectCorsHeaders({ tabId: 1, responseHeaders: [{ name: 'access-control-allow-origin', value: 'https://x.test' }] });
  T.eq(existing.responseHeaders[0].value, '*', 'existing ACAO widened, not duplicated');
  T.eq(existing.responseHeaders.length, 1);
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).enabled, true, 'state reflects enabled tab');
  T.eq((await send(shim, { type: 'getState', tabId: 2 })).boostPercent, 150, 'the level is stored as the last level set');
});

T.runAsync('setEnabled with no content script reports a plain error and disarms CORS and the badge', async () => {
  const { shim } = boot(); // tab 1 has no content handler → sendMessage rejects
  const r = await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 200 });
  T.eq(r, { enabled: false, error: "Can't boost this page. Try reloading it." });
  T.eq(shim.listeners.headers.length, 0, 'CORS listener removed again');
  T.eq(badgeFor(shim, 1), '', 'badge cleared');
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).enabled, false);
});

T.runAsync('setEnabled false turns the tab off and clears its badge', async () => {
  const { shim } = boot({ content: { 1: okContent() } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 200 });
  const r = await send(shim, { type: 'setEnabled', tabId: 1, value: false });
  T.eq(r, { enabled: false });
  T.eq(lastApply(shim, 1), { type: 'applyBoost', enabled: false, boostPercent: 100 });
  T.eq(badgeFor(shim, 1), '');
  T.eq(shim.listeners.headers.length, 1, 'CORS stays armed until the tab navigates or closes (tainted elements)');
});

T.runAsync('two tabs boosted at once; switching tabs leaves both on', async () => {
  const { shim } = boot({ content: { 1: okContent(), 2: okContent() } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 180 });
  await shim.activateTab(2);
  await send(shim, { type: 'setEnabled', tabId: 2, value: true, boostPercent: 120 });
  await shim.activateTab(1);
  await T.sleep(10);
  const s1 = await send(shim, { type: 'getState', tabId: 1 });
  const s2 = await send(shim, { type: 'getState', tabId: 2 });
  T.eq([s1.enabled, s1.boostPercent], [true, 180], 'tab 1 still boosted at its own level');
  T.eq([s2.enabled, s2.boostPercent], [true, 120], 'tab 2 boosted at its own level');
  T.eq([badgeFor(shim, 1), badgeFor(shim, 2)], ['180', '120'], 'each tab has its own badge');
  T.ok(!shim.callsTo('tabs.sendMessage').some((c) => c.args[1].enabled === false), 'nobody was told to stop');
});

T.runAsync('setBoost on a boosted tab re-applies to that tab only', async () => {
  const { shim } = boot({ content: { 1: okContent(), 2: okContent() } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 150 });
  await send(shim, { type: 'setEnabled', tabId: 2, value: true, boostPercent: 120 });
  await send(shim, { type: 'setBoost', tabId: 1, value: 190 });
  T.eq(lastApply(shim, 1), { type: 'applyBoost', enabled: true, boostPercent: 190 });
  T.eq(lastApply(shim, 2), { type: 'applyBoost', enabled: true, boostPercent: 120 }, 'tab 2 untouched');
  T.eq(badgeFor(shim, 1), '190');
});

T.runAsync('navigation keeps a boosted tab boosted at its level, re-sets its badge, and releases CORS on others', async () => {
  const { shim } = boot({ content: { 1: okContent(), 2: okContent() } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 150 });
  await send(shim, { type: 'setEnabled', tabId: 2, value: true, boostPercent: 130 });
  await send(shim, { type: 'setBoost', tabId: 1, value: 170 }); // global level now 170
  await send(shim, { type: 'setEnabled', tabId: 1, value: false });
  T.eq(shim.listeners.headers.length, 1, 'listener shared; two tabs armed');
  await shim.updateTab(1, { status: 'loading' }); // tab 1 no longer boosted → released
  await shim.updateTab(2, { status: 'loading' });
  await shim.updateTab(2, { status: 'complete' }); // tab 2 boosted → re-applied at ITS level, not the global one
  await T.sleep(10);
  T.eq(lastApply(shim, 2), { type: 'applyBoost', enabled: true, boostPercent: 130 }, 're-applied after load at the tab\'s level');
  T.eq(shim.callsTo('browserAction.setBadgeText').filter((c) => c.args[0].tabId === 2).length, 2, 'badge set again after navigation');
  T.eq(shim.listeners.headers.length, 1, 'boosted tab keeps CORS through its own navigation');
  await shim.removeTab(2);
  T.eq(shim.listeners.headers.length, 0, 'last armed tab closed → listener removed');
  T.eq((await send(shim, { type: 'getState', tabId: 2 })).enabled, false);
});

T.runAsync('per-site mode: navigation to a site with a saved level switches to it', async () => {
  const { shim } = boot({ content: { 1: okContent() }, storage: { perSite: true, siteBoosts: { 'https://b.test': 60 } } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 150 });
  await shim.updateTab(1, { status: 'loading', url: 'https://b.test/other' });
  await shim.updateTab(1, { status: 'complete' });
  await T.sleep(10);
  T.eq(lastApply(shim, 1), { type: 'applyBoost', enabled: true, boostPercent: 60 });
  T.eq(badgeFor(shim, 1), '60');
});

T.runAsync('per-site mode stores and restores a level per origin', async () => {
  const { shim } = boot({ content: { 1: okContent(), 2: okContent() } });
  await send(shim, { type: 'setBoost', tabId: 1, value: 200 });
  T.eq((await send(shim, { type: 'setPerSite', tabId: 1, value: true })).perSite, true);
  await send(shim, { type: 'setBoost', tabId: 1, value: 180 });
  await send(shim, { type: 'setBoost', tabId: 2, value: 50 });
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).boostPercent, 180, 'a.test remembers 180');
  T.eq((await send(shim, { type: 'getState', tabId: 2 })).boostPercent, 50, 'b.test remembers 50');
  T.eq((await send(shim, { type: 'getState', tabId: 3 })).boostPercent, 50, 'no origin → global (last set)');
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).savedSites, 2);
  await T.sleep(300);
  T.eq(shim.store.siteBoosts, { 'https://a.test': 180, 'https://b.test': 50 }, 'persisted per origin');
  await send(shim, { type: 'setPerSite', tabId: 1, value: false });
  T.eq((await send(shim, { type: 'getState', tabId: 1 })).boostPercent, 50, 'per-site off → global');
});

T.runAsync('resetSettings forgets every site, restores defaults now, and keeps boosted tabs on at 100%', async () => {
  const { shim } = boot({
    content: { 1: okContent() },
    storage: { boostPercent: 400, maxBoostPercent: 500, perSite: true, siteBoosts: { 'https://a.test': 300, 'https://b.test': 50 } },
  });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 300 });
  await send(shim, { type: 'setBoost', tabId: 1, value: 250 }); // leaves a debounced save pending
  const r = await send(shim, { type: 'resetSettings' });
  T.eq(r, { ok: true, forgotten: 2, boostPercent: 100, maxBoostPercent: 200, perSite: false });
  T.eq(shim.store, { boostPercent: 100, maxBoostPercent: 200, perSite: false, siteBoosts: {} }, 'saved immediately');
  await T.sleep(300);
  T.eq(shim.store.boostPercent, 100, 'the pending debounced save did not overwrite the reset');
  const s = await send(shim, { type: 'getState', tabId: 1 });
  T.eq([s.enabled, s.boostPercent, s.savedSites], [true, 100, 0]);
  T.eq(lastApply(shim, 1), { type: 'applyBoost', enabled: true, boostPercent: 100 });
  T.eq(badgeFor(shim, 1), '100');
});

T.runAsync('frameReady tells a new frame whether its tab is boosted', async () => {
  const { shim } = boot({ content: { 1: okContent() } });
  T.eq(await fromFrame(shim, 1, 5, { type: 'frameReady' }), { enabled: false });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 140 });
  T.eq(await fromFrame(shim, 1, 5, { type: 'frameReady' }), { enabled: true, boostPercent: 140 });
  T.eq(await shim.sendToBackground({ type: 'frameReady' }, { id: 'popup' }), { enabled: false }, 'not from a tab → off');
});

T.runAsync('frameStatus totals media across frames, notifies the popup, and resets on navigation', async () => {
  const { shim } = boot({ content: { 1: okContent() } });
  await send(shim, { type: 'setEnabled', tabId: 1, value: true, boostPercent: 150 });
  T.eq(await fromFrame(shim, 1, 0, { type: 'frameStatus', attached: 0, failed: 1 }), { ok: true });
  let s = await send(shim, { type: 'getState', tabId: 1 });
  T.eq([s.attached, s.failed], [0, 1], 'top frame alone: one failure');
  await fromFrame(shim, 1, 7, { type: 'frameStatus', attached: 2, failed: 0 });
  await fromFrame(shim, 1, 7, { type: 'frameStatus', attached: 3, failed: 0 }); // same frame again: replaces, not adds
  s = await send(shim, { type: 'getState', tabId: 1 });
  T.eq([s.attached, s.failed], [3, 1], 'embedded player counted');
  T.eq(shim.callsTo('runtime.sendMessage').filter((c) => c.args[0].type === 'statusChanged').map((c) => c.args[0].tabId), [1, 1, 1], 'popup told each time');
  await shim.updateTab(1, { status: 'loading' });
  s = await send(shim, { type: 'getState', tabId: 1 });
  T.eq([s.attached, s.failed], [0, 0], 'new document: counts cleared');
  T.eq((await shim.sendToBackground({ type: 'frameStatus', attached: 1, failed: 0 }, { id: 'popup' })).ok, false, 'not from a tab → refused');
});

T.runAsync('malformed and unknown messages are answered, never dropped', async () => {
  const { shim } = boot();
  T.eq(await send(shim, { type: 'nope' }), { ok: false, error: 'Unknown message' });
  T.eq(await send(shim, {}), { ok: false, error: 'Invalid message' });
  T.eq(await send(shim, null), { ok: false, error: 'Invalid message' });
});

await T.exit();
