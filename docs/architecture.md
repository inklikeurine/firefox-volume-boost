# Architecture

Volume Boost is a Manifest V2 WebExtension with three runtime pieces and no
build step. This document explains what each piece owns, how audio is boosted,
and why the CORS header injection exists.

## Components

```text
┌────────────┐ runtime.sendMessage ┌──────────────────┐ tabs.sendMessage ┌────────────────┐
│ popup.js   │ ──────────────────▶ │ background.js    │ ───────────────▶ │ content.js     │
│ (UI)       │ ◀────────────────── │ (state + policy) │ ◀─────────────── │ (every frame)  │
└────────────┘ responses,          └──────────────────┘ responses,       └────────────────┘
               statusChanged                │           frameReady,
                                            │           frameStatus
                                            ▼
                                   storage.local
                                   browserAction badge
                                   webRequest.onHeadersReceived
```

| File | Runs in | Responsibility |
| --- | --- | --- |
| `background.js` | Persistent background page | Single source of truth for settings and for which tabs are boosted, at what level. Persists settings to `storage.local`. Totals the media each frame reports. Sets the toolbar badge. Owns the CORS header-injection listener. Reacts to tab navigation and close. **Why persistent, not an event page:** the boosted tabs, the per-frame media counts and the set of CORS-armed tabs are session state that cannot be rebuilt from storage, and the blocking `webRequest` listener must stay registered while any tab is armed. |
| `content.js` | Every page and every frame (`<all_urls>`, `document_idle`, `all_frames`) | Builds the Web Audio graph, attaches media elements to it, applies gain, reports its counts. Stateless with respect to settings — it only knows what the background last told it. |
| `popup.js` / `popup.html` / `popup.css` | Browser-action popup | Renders the current tab's state, sends user intent to the background. Never talks to the content script directly. |

The message protocol between these pieces is documented in
[messaging.md](./messaging.md).

## Audio graph (content script)

On the first `applyBoost` with `enabled: true`, the content script lazily
creates one `AudioContext` per frame and wires:

```text
GainNode ─▶ DynamicsCompressorNode ─▶ AudioContext.destination
```

Each `<audio>`/`<video>` element found in the frame is wrapped in a
`MediaElementAudioSourceNode` and connected to the shared `GainNode`. The
mapping element → source node is kept in a `WeakMap` so it is garbage-collected
with the element and an element is never attached twice.

The whole script runs inside a guard (`globalThis.volumeBoostLoaded`): content
scripts of one extension share a sandbox per frame, so a second injection of
the file returns at once instead of building a second graph.

### Gain

`GainNode.gain` is set to `boostPercent / 100` via `setTargetAtTime` with a
15 ms time constant, giving a short ramp rather than an audible click on every
slider movement. Percent is clamped to 0–1000 in the content script regardless
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

This keeps a few hundred percent of boost usable. It cannot make 1000% sound
good; the popup warns at ≥300%.

### Attach lifecycle

- **Finding media.** When boost is enabled (and on every `applyBoost` while it
  is on) the content script runs `document.querySelectorAll("audio, video")`.
  While boost is on it also watches for media that appears later, without
  polling:
  - a `MutationObserver` on the document (`childList`, `subtree`) attaches
    inserted `<audio>`/`<video>` elements, including ones inside an inserted
    subtree;
  - capture-phase `loadstart` and `play` listeners on `document` attach an
    element that gets a source after it was inserted (`src`, a `<source>`
    child, `srcObject`). Media events don't bubble, but they do pass `document`
    in the capture phase. `play` also resumes the `AudioContext` if Firefox
    left it suspended.

  The observer and listeners are removed when boost is disabled.
- **Skip rules.** Elements are skipped if they have no source yet
  (`src`, `currentSrc`, or `srcObject` all empty), if they are already
  attached, or if a previous attach attempt threw.
- **Failure tracking.** `createMediaElementSource` throws if the element is
  already connected to another `AudioContext` (some players create their own).
  Such elements go into a `WeakSet` and are counted as failed.
- **Reporting.** Whenever its attached/failed counts change, a frame sends
  `frameStatus` to the background. The background keeps the counts per frame
  (`sender.frameId`), so the popup shows a page's total across the page and
  its embedded players.
- **Frames that load later.** On load, every frame sends `frameReady`; the
  background answers whether the tab is boosted and at what level. A reload,
  or an embedded player inserted after boost was switched on, starts boosted
  this way.
- **Disable.** Disabling boost sets gain back to 1.0 and stops watching. The
  audio graph and existing source nodes are **kept** — once an element is
  routed through a `MediaElementAudioSourceNode` it cannot be un-routed, and
  tearing the context down would silence it.

What is not found: media the page never adds to the document (created in a
script and played detached), and elements inside a shadow root — the observer
and `querySelectorAll` don't enter shadow trees, and media events don't leave
them.

## Why CORS handling is required

`MediaElementAudioSourceNode` enforces the same-origin policy: if a media
element's resource was fetched without CORS from a different origin, the source
node outputs **silence** (the audio is "tainted"). This affects a large share of
real-world media, which is typically served from a CDN on a different origin
than the page.

Two things are needed to un-taint the element:

1. **The element must be fetched in CORS mode** — `crossorigin="anonymous"`.
   The content script sets this on any element whose source URL origin differs
   from the frame's origin (`blob:`, `data:`, and `srcObject` streams are
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
state = {                            // persisted to storage.local, same keys
  boostPercent:    number,           // last level set, 0..maxBoostPercent
  maxBoostPercent: number,           // 1..1000, default 200
  perSite:         boolean,          // whether to consult siteBoosts
  siteBoosts:      { [origin: string]: number }
}
boostedTabs: Map<tabId, percent>     // session only: which tabs are boosted, at what level
mediaCounts: Map<tabId, Map<frameId, { attached, failed }>>   // session only
corsTabs:    Set<tabId>              // session only, see above
```

Saves are debounced by 200 ms so dragging the slider doesn't hammer storage;
`resetSettings` saves at once and cancels a pending save. `loadSettings()` runs
once at startup and every message handler awaits it before touching state, so
there is no race on cold start. A read that fails, or values of the wrong
type, fall back to the defaults; numbers are clamped to their ranges; a
per-site entry that isn't a number is dropped.

### The level a tab gets

When boost is switched on in a tab the popup sends the slider's value, which
the popup took from `getState`:

```text
tab boosted               → its level in boostedTabs
else if perSite and siteBoosts[origin] → clamp(siteBoosts[origin], 0, max)
else                      → boostPercent
```

`origin` is derived from the tab's URL and is `null` for non-HTTP(S) URLs,
which fall through to the global value. `setBoost` writes `boostPercent` (and
`siteBoosts[origin]` in per-site mode), and re-applies to the tab if it is
boosted; other boosted tabs keep their levels.

### Boosted tabs

- Any number of tabs can be boosted. `setEnabled` acts on the tab it names and
  nothing else; switching tabs changes nothing.
- `tabs.onUpdated` with `status: "loading"` clears the tab's media counts (a
  new document will report its own). With `status: "complete"` on a boosted
  tab, boost is re-applied — at the tab's own level, unless per-site mode has
  a level saved for the new site — and the badge is set again.
- `tabs.onRemoved` forgets the tab.
- `setMaxBoost` clamps the global level, every per-site level and every
  boosted tab's level to the new maximum, and re-applies to boosted tabs.
- `resetSettings` restores the defaults, forgets every site, and re-applies
  100% to every boosted tab (they stay on).

### Badge

A boosted tab's toolbar badge shows its level (`browserAction.setBadgeText`
with the tab's id; the colour is set once at startup). Firefox clears a tab's
badge when the tab navigates to a new page, so it is set again on
`status: "complete"`. Turning boost off sets the tab's badge to an empty
string.

### Update from 0.x

Before 1.0 the default maximum was 600% and it was saved with every other
setting. `runtime.onInstalled` with `reason: "update"` from a `0.x` version
turns a stored `maxBoostPercent` of exactly 600 into the new default 200 and
clamps the stored levels to it; any other stored maximum is kept (capped at
1000).

## Popup

The popup is a fixed 360×316 px layout. Firefox sizes a browser-action popup
from the `<body>`'s layout, so `width`/`height` (and `min-` versions) are set on
`body`, with `overflow: hidden`, and the `.app` grid has one
`minmax(0, 1fr)` column so a long tab title is cut with an ellipsis instead of
widening the popup. The header reserves two lines for the status text.

On open it:

1. Queries the active tab for title and favicon.
2. Sends `getState` to the background and paints the toggle, slider, max label,
   per-site checkbox and status line from the response.

Slider `input` events update the readout immediately; the `setBoost` message is
coalesced with `requestAnimationFrame`, so at most one message per frame is sent
while dragging. The slider's filled part is the `::-moz-range-progress`
pseudo-element.

Enabling boost from the popup is a two-step sequence: `setBoost` with the
current slider value (so per-site storage is written), then `setEnabled`. If
the background reports an error the toggle is flipped back and the error text
replaces the status line. While the popup is open, the background sends it
`statusChanged` whenever a frame of a tab reports new counts; the popup
re-reads `getState` and updates the status line only (not the slider, which
the user may be dragging).

The Max label is a button: double-click, or a keyboard activation (Enter or
Space — a click with `detail === 0`), opens a number field in its place. Enter
saves a value from 1 to 1000; anything else shows a message and keeps the
field open; Esc or leaving the field cancels. **Forget saved sites** needs a
second click within four seconds.

The on/off switch is a real checkbox made transparent over the drawn track, so
it stays in the tab order and gets a focus ring. All popup text is 13 px or
larger.

## Design background

The approach — boosting page media through Web Audio from a content script,
`crossorigin="anonymous"` on the elements, and an injected
`Access-Control-Allow-Origin` header for media responses — is the one a
comparable published Firefox extension uses, and it avoids `tabCapture`,
which isn't available in Firefox in a usable form.
