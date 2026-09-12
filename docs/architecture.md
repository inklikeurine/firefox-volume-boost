# Architecture

Volume Boost is a Manifest V2 WebExtension with three runtime pieces and no
build step. This document explains what each piece owns, how audio is boosted,
and why the CORS header injection exists.

## Components

```
┌──────────────┐   runtime.sendMessage   ┌────────────────────┐   tabs.sendMessage   ┌──────────────────┐
│  popup.js    │ ──────────────────────▶ │   background.js    │ ───────────────────▶ │   content.js     │
│  (UI)        │ ◀────────────────────── │   (state + policy) │ ◀─────────────────── │   (audio graph)  │
└──────────────┘        response         └────────────────────┘       response       └──────────────────┘
                                                   │
                                                   ▼
                                          storage.local
                                          webRequest.onHeadersReceived
```

| File | Runs in | Responsibility |
| --- | --- | --- |
| `background.js` | Persistent background page | Single source of truth for settings and which tab is boosted. Persists to `storage.local`. Owns the CORS header-injection listener. Reacts to tab activation/navigation/close. |
| `content.js` | Every page and every frame (`<all_urls>`, `document_idle`) | Builds the Web Audio graph, attaches media elements to it, applies gain. Stateless with respect to settings — it only knows what the background last told it. |
| `popup.js` / `popup.html` / `popup.css` | Browser-action popup | Renders state, sends user intent to the background. Never talks to the content script directly. |

The message protocol between these pieces is documented in
[messaging.md](./messaging.md).

## Audio graph (content script)

On the first `applyBoost` with `enabled: true`, the content script lazily
creates one `AudioContext` per frame and wires:

```
GainNode ─▶ DynamicsCompressorNode ─▶ AudioContext.destination
```

Each `<audio>`/`<video>` element found on the page is wrapped in a
`MediaElementAudioSourceNode` and connected to the shared `GainNode`. The
mapping element → source node is kept in a `WeakMap` so it is garbage-collected
with the element and an element is never attached twice.

### Gain

`GainNode.gain` is set to `boostPercent / 100` via `setTargetAtTime` with a
15 ms time constant, giving a short ramp rather than an audible click on every
slider movement. Percent is clamped to 0–5000 in the content script regardless
of what the background sends.

### Limiter

The `DynamicsCompressorNode` is configured as a fast limiter:

| Parameter | Value | Effect |
| --- | --- | --- |
| threshold | −6 dB | Compression begins 6 dB below full scale |
| knee | 0 | Hard knee — no compression below threshold |
| ratio | 12:1 | Near-limiting |
| attack | 3 ms | Catches transients quickly |
| release | 250 ms | Avoids pumping on sustained loudness |

This keeps 300–600% boost usable. It cannot make 5000% sound good; the popup
warns at ≥1000%.

### Attach lifecycle

- **Scanning.** While boost is enabled the content script runs
  `document.querySelectorAll("audio, video")` immediately and then every
  1000 ms. Scanning stops when boost is disabled. A `MutationObserver` was
  considered but the interval is simpler and cheap at this frequency.
- **Skip rules.** Elements are skipped if they have no source yet
  (`src`, `currentSrc`, or `srcObject` all empty), if they are already
  attached, or if a previous attach attempt threw.
- **Failure tracking.** `createMediaElementSource` throws if the element is
  already connected to another `AudioContext` (some players create their own).
  Such elements go into a `WeakSet` and are counted in `failedCount`, which
  the background uses to surface "Media on this page could not be boosted"
  when nothing at all could be attached.
- **Disable.** Disabling boost sets gain back to 1.0 and stops scanning. The
  audio graph and existing source nodes are **kept** — once an element is
  routed through a `MediaElementAudioSourceNode` it cannot be un-routed, and
  tearing the context down would silence it.

## Why CORS handling is required

`MediaElementAudioSourceNode` enforces the same-origin policy: if a media
element's resource was fetched without CORS from a different origin, the source
node outputs **silence** (the audio is "tainted"). This affects a large share of
real-world media, which is typically served from a CDN on a different origin
than the page.

Two things are needed to un-taint the element:

1. **The element must be fetched in CORS mode** — `crossorigin="anonymous"`.
   The content script sets this on any element whose source URL origin differs
   from the page origin (`blob:`, `data:`, and `srcObject` streams are
   same-origin and skipped). Because `crossorigin` only affects the *next*
   fetch, an element that has already started loading is reloaded: the current
   time and play/pause state are captured, `load()` is called, and both are
   restored on `loadedmetadata`.
2. **The server must answer with `Access-Control-Allow-Origin`.** Most media
   CDNs don't. The background script therefore registers a blocking
   `webRequest.onHeadersReceived` listener that adds (or overwrites)
   `Access-Control-Allow-Origin: *` on responses.

### Scope of the header injection

The listener is deliberately narrow:

- Filter is `types: ["media"]` only — no documents, scripts, XHR, or images.
- It early-returns unless `details.tabId` is in `corsTabs`, a `Set` of tab IDs
  that have had boost enabled.
- The listener is **added only when `corsTabs` is non-empty and removed when
  it becomes empty**, so with boost never used there is zero request
  interception.

### Why a tab stays in `corsTabs` after boost is turned off

Once an element has been switched to `crossorigin="anonymous"` and routed
through Web Audio, the browser will keep issuing CORS-mode range requests for it
as playback continues (seeking, buffering). If the injected header disappeared
at that point those requests would fail and playback would break. So a tab is
only removed from `corsTabs` when:

- the tab is closed (`tabs.onRemoved`), or
- the tab starts a navigation (`tabs.onUpdated` with `status: "loading"`)
  while boost is **not** enabled on it — navigation discards the old media
  elements, so the header is no longer needed.

If enabling boost fails outright (e.g. the content script isn't reachable on a
restricted page), the tab is released immediately unless it was already in the
set.

## State model (background)

```js
state = {
  enabledTabId:    number | null,   // at most one tab is boosted at a time
  boostPercent:    number,          // global level, 0..maxBoostPercent
  maxBoostPercent: number,          // 1..5000, default 600
  perSite:         boolean,         // whether to consult siteBoosts
  siteBoosts:      { [origin: string]: number }
}
```

Everything except `enabledTabId` is persisted to `storage.local` under the same
keys. Saves are debounced by 200 ms so dragging the slider doesn't hammer
storage. `loadSettings()` runs once at startup and every message handler
awaits it before touching state, so there is no race on cold start.

### Resolving the boost level for a tab

```
if !perSite               → boostPercent
else if siteBoosts[origin] → clamp(siteBoosts[origin], 0, max)
else                       → boostPercent
```

`origin` is derived from `tabs.get(tabId).url` and is `null` for non-HTTP(S)
URLs, which fall through to the global value. When per-site mode is on,
`setBoost` writes to **both** `boostPercent` and `siteBoosts[origin]`, so the
global value always reflects the last level the user chose.

### Single-tab invariant

Only one tab can be boosted at a time:

- `setEnabled(true)` refuses unless the target tab is the active tab in the
  current window.
- If another tab was boosted, it is sent `applyBoost { enabled: false }` first.
- `tabs.onActivated` disables the previously boosted tab when the user switches
  away from it.
- `tabs.onUpdated` (`status: "complete"`) re-applies boost after a navigation
  or reload of the boosted tab, since the content script's state was lost.

## Popup

The popup is a fixed 360×190 px layout (Firefox needs explicit popup sizing;
see [learnings-firefox-popup.md](./learnings-firefox-popup.md)). On open it:

1. Queries the active tab for title and favicon.
2. Sends `getState` to the background and paints the toggle, slider, max label,
   and per-site checkbox from the response.

Slider `input` events update the readout and fill immediately but the
`setBoost` message is coalesced with `requestAnimationFrame`, so at most one
message per frame is sent while dragging. The slider fill is a CSS gradient
recomputed from the current value and max.

Enabling boost from the popup is a two-step sequence: `setBoost` with the
current slider value (so per-site storage is written), then `setEnabled`. If
the background reports an error the toggle is flipped back and the error text
replaces the status line.

## Browser compatibility

Both `browser.*` (promise-based, Firefox) and `chrome.*` (callback-based) are
supported via a small shim in each script — `sendMessage` returns the promise
if the API gives one, otherwise wraps the callback form. The manifest is still
MV2 with `webRequestBlocking`, which Chrome no longer supports, so porting to
Chrome would require moving to `declarativeNetRequest` and a service worker.
