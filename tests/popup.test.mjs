// Volume Boost — popup.js in jsdom, talking to the real background.js through
// the browser.* shim. Proves the popup renders what the background holds,
// the level display (dB, warning, slider marks, highlighted preset), the max
// editor (mouse and keyboard), the status line for each state, a page it
// cannot reach and Forget saved sites with its Cancel / Forget confirm.
import fs from 'node:fs';
import { T, loadScripts, makeBrowserShim, makeDom } from '../../firefox-tools/harness/lib.mjs';

const HTML = fs.readFileSync(T.extFile('popup.html'), 'utf8').replace('<script src="popup.js"></script>', '');

const okContent = (message, _sender, sendResponse) => {
  sendResponse({ ok: true, enabled: message.enabled, boostPercent: message.boostPercent, attached: 0, failed: 0 });
  return false;
};

async function boot({ tab = { id: 1, url: 'https://a.test/watch', title: 'A video', favIconUrl: 'https://a.test/f.ico' }, storage = {}, content = true } = {}) {
  const shim = makeBrowserShim({ tabs: [{ active: true, ...tab }], storage });
  if (content) shim.attachContent(tab.id, okContent);
  loadScripts([T.extFile('lib/common.js'), T.extFile('background.js')], { browser: shim.browser });
  const d = makeDom({ html: HTML, url: 'https://ext.test/popup.html', browser: shim.browser });
  d.runScripts([T.extFile('lib/common.js'), T.extFile('popup.js')]);
  await T.sleep(30);
  const $ = (id) => d.document.getElementById(id);
  const popupListener = () => shim.listeners.message[1].fn;
  // What the background does when a frame reports, then the broadcast the popup would get.
  const frameReports = async (attached, failed, frameId = 0) => {
    await shim.sendToBackground({ type: 'frameStatus', attached, failed }, { tab: shim.tabs[0], frameId, id: 'content' });
    popupListener()({ type: 'statusChanged', tabId: tab.id }, {}, () => {});
    await T.sleep(20);
  };
  const click = (el, init = {}) => el.dispatchEvent(new d.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }));
  const toggle = async (on) => { $('enabledToggle').checked = on; $('enabledToggle').dispatchEvent(new d.window.Event('change', { bubbles: true })); await T.sleep(30); };
  return { ...d, shim, $, frameReports, click, toggle, state: () => shim.sendToBackground({ type: 'getState', tabId: tab.id }) };
}

T.runAsync('renders the tab and the background\'s state: max 200, six presets ending Max, boost off', async () => {
  const { $, document } = await boot();
  T.eq($('tabTitle').textContent, 'A video');
  T.eq($('favicon').getAttribute('src'), 'https://a.test/f.ico');
  T.eq($('faviconWrap').dataset.hasIcon, 'true');
  T.eq([$('statusLine').hidden, $('statusText').textContent], [true, ''], 'no status line while off');
  T.eq($('statusLine').dataset.tone, 'off');
  T.eq($('app').dataset.enabled, 'false');
  T.eq($('enabledToggle').disabled, false);
  T.eq($('maxText').textContent, 'Max 200%');
  T.eq($('maxLabel').getAttribute('aria-label'), 'Change maximum, now 200%');
  T.eq($('boostSlider').max, '200');
  T.eq($('readout').textContent, '100%');
  T.eq($('dbText').textContent, '0 dB');
  T.eq($('resetBtn').disabled, true, 'nothing to reset at 100%');
  T.eq([...document.querySelectorAll('[data-preset]')].map((b) => b.textContent), ['10%', '50%', '80%', '100%', '120%', 'Max']);
  T.eq([...document.querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.preset), ['100']);
  T.eq($('app').dataset.warn, 'false');
});

T.runAsync('presets move the slider, send the level and are highlighted; Max means the current maximum', async () => {
  const { $, document, click, state } = await boot();
  click(document.querySelector('[data-preset="max"]'));
  T.eq([$('boostSlider').value, $('readout').textContent, $('dbText').textContent], ['200', '200%', '+6.0 dB']);
  T.eq(document.querySelector('[data-preset="max"]').getAttribute('aria-pressed'), 'true');
  T.eq(document.querySelector('[data-preset="100"]').getAttribute('aria-pressed'), 'false');
  T.eq($('resetBtn').disabled, false);
  await T.sleep(50); // the setBoost goes out on the next animation frame
  T.eq((await state()).boostPercent, 200);
  click(document.querySelector('[data-preset="120"]'));
  await T.sleep(50);
  T.eq((await state()).boostPercent, 120);
  click($('resetBtn'));
  await T.sleep(50);
  T.eq((await state()).boostPercent, 100);
  T.eq($('resetBtn').disabled, true);
});

T.runAsync('the level in dB: Muted at 0, minus below 100, whole decibels from 10 dB', async () => {
  const { $, window } = await boot({ storage: { maxBoostPercent: 1000 } });
  const slide = (v) => { $('boostSlider').value = String(v); $('boostSlider').dispatchEvent(new window.Event('input', { bubbles: true })); return $('dbText').textContent; };
  T.eq([slide(0), slide(50), slide(100), slide(150), slide(1000)], ['Muted', '−6.0 dB', '0 dB', '+3.5 dB', '+20 dB · may distort']);
});

T.runAsync('from 300% the warning shows; the slider marks 100% and shades 300%+ only when the max reaches them', async () => {
  const { $, window, click } = await boot({ storage: { maxBoostPercent: 600 } });
  const slide = (v) => { $('boostSlider').value = String(v); $('boostSlider').dispatchEvent(new window.Event('input', { bubbles: true })); };
  slide(299);
  T.eq([$('app').dataset.warn, $('boostSlider').getAttribute('aria-valuetext')], ['false', '299 percent']);
  slide(300);
  T.eq([$('app').dataset.warn, $('boostSlider').getAttribute('aria-valuetext')], ['true', '300 percent, may distort']);
  T.eq($('readout').textContent, '300%');
  T.eq($('level').style.getPropertyValue('--f'), '0.5');
  T.eq($('level').style.getPropertyValue('--f300'), '0.5');
  T.eq([$('sliderZone').hidden, $('sliderNotch').hidden, $('unityLabel').hidden], [false, false, false]);
  const setMax = async (v) => {
    click($('maxLabel'));
    $('maxInput').value = String(v);
    $('maxEditor').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await T.sleep(30);
  };
  await setMax(200);
  T.eq([$('sliderZone').hidden, $('sliderNotch').hidden, $('unityLabel').hidden], [true, false, false], 'max 200: no zone');
  await setMax(120);
  T.eq([$('sliderNotch').hidden, $('unityLabel').hidden], [false, true], 'max 120: the 100% label would hit Max');
  await setMax(100);
  T.eq($('sliderNotch').hidden, true, 'max 100: no mark');
});

T.runAsync('max editor: a click or a keyboard click opens it; Escape closes it', async () => {
  const { $, click, window } = await boot();
  click($('maxLabel'));
  T.eq($('maxEditor').hidden, false, 'click opens');
  T.eq($('maxLabel').hidden, true);
  T.eq(window.document.activeElement, $('maxInput'), 'input focused');
  T.eq($('maxInput').value, '200');
  $('maxInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  T.eq($('maxEditor').hidden, true, 'Escape closes');
  T.eq(window.document.activeElement, $('maxLabel'), 'focus back on the Max button');
  click($('maxLabel'), { detail: 0 });
  T.eq($('maxEditor').hidden, false, 'Enter/Space (click with detail 0) opens');
});

T.runAsync('max editor: Enter saves a valid value; out-of-range input is refused with a message', async () => {
  const { $, click, window, state } = await boot();
  click($('maxLabel'));
  $('maxInput').value = '5000';
  $('maxEditor').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await T.sleep(20);
  T.eq([$('statusLine').hidden, $('statusText').textContent], [false, 'Max must be between 1% and 1000%']);
  T.eq($('statusLine').dataset.tone, 'warn');
  T.eq($('maxEditor').hidden, false, 'stays open');
  $('maxInput').value = '400';
  $('maxEditor').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await T.sleep(30);
  T.eq($('maxEditor').hidden, true);
  T.eq($('maxText').textContent, 'Max 400%');
  T.eq($('boostSlider').max, '400');
  T.eq((await state()).maxBoostPercent, 400, 'saved in the background');
  T.eq([$('statusLine').hidden, $('statusText').textContent], [true, ''], 'message cleared by the repaint');
});

T.runAsync('status line: waiting for media and can\'t be boosted shown with their tone; boosting and off hidden', async () => {
  const { $, toggle, frameReports } = await boot();
  await toggle(true);
  T.eq([$('statusLine').hidden, $('statusText').textContent, $('statusLine').dataset.tone], [false, 'On — waiting for audio or video', 'wait']);
  T.eq($('statusText').title, $('statusText').textContent, 'full text as the tooltip');
  T.eq($('app').dataset.enabled, 'true');
  await frameReports(0, 2);
  T.eq([$('statusText').textContent, $('statusLine').dataset.tone], ["On — this page's media can't be boosted", 'warn']);
  await frameReports(1, 0, 4); // an embedded player in frame 4 attached
  T.eq([$('statusLine').hidden, $('statusText').textContent, $('statusLine').dataset.tone], [true, '', 'on'], 'boosting: no line');
  await toggle(false);
  T.eq([$('statusLine').hidden, $('statusText').textContent, $('statusLine').dataset.tone], [true, '', 'off'], 'off: no line');
  T.eq($('enabledToggle').checked, false);
  T.eq($('app').dataset.enabled, 'false');
});

T.runAsync('a page the extension cannot reach: plain message, switch back off', async () => {
  const { $, toggle } = await boot({ content: false });
  await toggle(true);
  T.eq([$('statusText').textContent, $('statusLine').dataset.tone], ["Can't boost this page. Try reloading it.", 'warn']);
  T.eq($('enabledToggle').checked, false);
});

T.runAsync('a Firefox page (no content script, no url or icon): the switch works and says it can\'t boost', async () => {
  const { $, toggle } = await boot({ tab: { id: 1, url: undefined, title: undefined }, content: false });
  T.eq($('enabledToggle').disabled, false);
  T.eq($('statusLine').hidden, true);
  T.eq($('tabTitle').textContent, 'Active Tab', 'placeholder title kept');
  T.eq($('faviconWrap').dataset.hasIcon, 'false', 'generic icon instead');
  await toggle(true);
  T.eq([$('statusLine').hidden, $('statusText').textContent], [false, "Can't boost this page. Try reloading it."]);
  T.eq($('enabledToggle').checked, false);
});

T.runAsync('Forget saved sites asks first; Forget resets everything', async () => {
  const { $, click, state } = await boot({ storage: { maxBoostPercent: 500, boostPercent: 300, perSite: true, siteBoosts: { 'https://a.test': 300, 'https://b.test': 90 } } });
  T.eq($('perSiteToggle').checked, true);
  click($('forgetBtn'));
  await T.sleep(10);
  T.eq([$('footerNormal').hidden, $('footerConfirm').hidden], [true, false]);
  T.eq([$('confirmText').textContent, $('confirmForgetBtn').textContent], ['Forget 2 sites and reset?', 'Forget']);
  T.eq($('cancelForgetBtn').ownerDocument.activeElement, $('cancelForgetBtn'), 'Cancel focused');
  T.eq((await state()).savedSites, 2, 'nothing forgotten yet');
  click($('confirmForgetBtn'));
  await T.sleep(40);
  const s = await state();
  T.eq([s.savedSites, s.maxBoostPercent, s.boostPercent, s.perSite], [0, 200, 100, false]);
  T.eq([$('footerNormal').hidden, $('footerConfirm').hidden], [false, true]);
  T.eq([$('statusLine').hidden, $('statusText').textContent], [false, 'Saved sites forgotten, settings reset']);
  T.eq($('statusLine').dataset.tone, 'off', 'a note, not a problem');
  T.eq([$('maxText').textContent, $('readout').textContent, $('perSiteToggle').checked], ['Max 200%', '100%', false]);
});

T.runAsync('Forget saved sites: Cancel or Escape keeps everything', async () => {
  const { $, click, window, state } = await boot({ storage: { perSite: true, siteBoosts: { 'https://a.test': 150 } } });
  click($('forgetBtn'));
  T.eq($('confirmText').textContent, 'Forget 1 site and reset?');
  click($('cancelForgetBtn'));
  T.eq([$('footerNormal').hidden, $('footerConfirm').hidden], [false, true]);
  T.eq(window.document.activeElement, $('forgetBtn'), 'focus back on Forget saved sites');
  click($('forgetBtn'));
  $('cancelForgetBtn').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  T.eq($('footerConfirm').hidden, true, 'Escape cancels');
  await T.sleep(20);
  T.eq((await state()).savedSites, 1, 'nothing forgotten');
});

T.runAsync('Forget saved sites with none saved is a plain reset', async () => {
  const { $, click } = await boot();
  click($('forgetBtn'));
  T.eq([$('confirmText').textContent, $('confirmForgetBtn').textContent], ['Reset all settings?', 'Reset']);
  click($('confirmForgetBtn'));
  await T.sleep(40);
  T.eq($('statusText').textContent, 'Settings reset');
});

T.runAsync('the popup answers statusChanged and leaves every other message to the background', async () => {
  const { shim } = await boot();
  const listener = shim.listeners.message[1].fn;
  T.eq(await listener({ type: 'statusChanged', tabId: 99 }, {}, () => {}), { ok: true });
  T.eq(listener({ type: 'frameStatus', attached: 1, failed: 0 }, {}, () => {}), undefined);
});

await T.exit();
