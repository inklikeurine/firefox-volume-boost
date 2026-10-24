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
| `lib/common.js` | Loaded first in all three | What they share: the `API` global, the 1000% cap (`MAX_PERCENT`), the default maximum (`DEFAULT_MAX_PERCENT`, 200), `clamp` and `warnOnce` (each problem logged once). Only `var` and function declarations, so a second load into the same content-script sandbox is harmless. |
| `popup.js` / `popup.html` / `popup.css` | Browser-action popup | Renders the current tab's state, sends user intent to the background. Never talks to the content script directly. |

The message protocol between these pieces is documented in
[messaging.md](./messaging.md).

## Audio graph (content script)

When boost is on and the first media element of a frame attaches, the
content script creates one `AudioContext` for that frame and wires:

```text
GainNode ─▶ GainNode (÷ 10) ─▶ WaveShaperNode (soft clipper) ─▶ AudioContext.destination
```

A frame without media never creates a context, so a boosted tab does not open
an audio stream in every ad or widget frame.

Each `<audio>`/`<video>` element found in the frame is wrapped in a
`MediaElementAudioSourceNode` and connected to the shared `GainNode`. Attached
and refused elements are kept in `WeakSet`s, so they are garbage-collected with
the element and an element is never attached twice.

The whole script runs inside a guard (`globalThis.volumeBoostLoaded`): content
scripts of one extension share a sandbox per frame, so a second injection of
the file returns at once instead of building a second graph.

### Gain

`GainNode.gain` is set to `boostPercent / 100` via `setTargetAtTime` with a
15 ms time constant, giving a short ramp rather than an audible click on every
slider movement. Percent is clamped to 0–1000 in the content script regardless
of what the background sends.

### Limiter

The safety stage is a soft clipper: a `WaveShaperNode` whose curve is linear
up to 0.8 of full scale (`SOFT_KNEE`) and above it follows a `tanh` shoulder
that leaves the knee at slope 1 and flattens out at full scale.
Below the knee the boosted signal is untouched; only peaks are rounded off,
and the output never passes full scale, so Firefox never hard-clips it.

A `WaveShaperNode` clamps its input to [−1, 1]. The curve therefore covers
amplitudes up to 10 (`CURVE_RANGE`, the most 1000% can produce): a fixed
`GainNode` scales the signal by 1/10 on the way in and the curve maps it back.
The curve has 8193 points (odd, so 0 maps to exactly 0); the shaper runs
without oversampling, whose resampling filters overshoot full scale.

Measured in Firefox on speech-like audio peaking at −1 dBFS (as streaming
audio does):

| Level | Louder by | Distortion (error ÷ signal) |
| --- | --- | --- |
| 100% | 0 dB | none |
| 150% | +3.5 dB | −47 dB |
| 200% | +6.0 dB | −32 dB |
| 300% | +9.2 dB | −20 dB |
| 600% | +13.3 dB | −11 dB |

The popup warns from 300%, where the distortion becomes audible.

A `DynamicsCompressorNode` is not used. On audio that already peaks near full
scale, its gain reduction holds the level down long after each peak, so it
takes back most of the boost: on the same signal, threshold −6 dB and ratio
12:1 gave +2.4 dB at 200% and +4.4 dB at 1000%; with the threshold at −1 dB
and ratio 20:1, 1000% gave +6.2 dB, what the soft clipper gives at 200%.

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
- **Failure tracking.** An element whose `createMediaElementSource` throws goes
  into a `WeakSet` and is counted as failed. Firefox does not throw for an
  element that another `AudioContext` already routes: it plays the element
  through both. That is why an earlier copy's context is closed before an
  element is attached (next item).
- **Taking over from an earlier copy.** When Volume Boost is reloaded, updated
  or re-enabled with a page open, Firefox discards the old content script but
  not its `AudioContext`, which belongs to the page: it keeps playing the
  element at the old level, and nothing can reach it. So on every attach the
  content script also stores its context on the page's side of the element
  (`element.wrappedJSObject.volumeBoostAudioContext`). The next copy looks
  there before attaching an element, re-wraps what it finds with
  `XPCNativeWrapper` (so only a real `AudioContext`'s own methods are used,
  never anything the page put there) and closes it. On start-up it does this
  for every media element that has a live earlier context and attaches the
  element at 100%: closing the old context alone would leave the element
  silent, because Firefox keeps its sound captured. The page can see and
  close that property; closing it would only stop the boost.
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

When boost is switched on in a tab the popup sends the slider's value (which
it took from `getState`), and the background stores it as the last level set,
and as the site's level in per-site mode. The value `getState` shows, and the
one `setEnabled` uses when no level is sent:

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

## Popup

The popup is a fixed 360×271 px layout on one flat surface, top to bottom:
header (tab icon and title, status line, switch), level (readout with dB,
Reset; slider; 0% / 100% / Max scale), presets, and a footer (per-site
checkbox, Forget saved sites). Firefox sizes a browser-action popup from the
`<body>`'s layout, so `width`/`height` (and `min-` versions) are set on
`body`, with `overflow: hidden`. The `.app` column is a flex box with the
footer pushed to the bottom; the tab title and the status line are one line
each, cut with an ellipsis (the status text's full wording is its tooltip).
The status line is `hidden` while its text is empty: boost off, or on with
media attached. The header keeps its height, so the title then sits centred
and nothing below moves.

State is shown with data attributes on `.app`, so the CSS does the styling:
`data-enabled` greys the readout and slider when boost is off, `data-warn`
(level ≥ 300%) turns them amber and shows the warning icon. The status line's
`data-tone` (`off`, `on`, `wait`, `warn`) colours its dot and text.

The slider is the native range input with a transparent track; only its thumb
is drawn. Under it, `<span>`s draw the track, the fill (amber past 300%), the
notch at 100% and the hatched zone above 300%. Their positions come from three
custom properties on `.level` that `popup.js` sets: `--f` (level / max),
`--f100` and `--f300` (where 100% and 300% fall); a value's centre is at
`(width − 20px) × f + 10px`, the thumb being 20 px wide.

On open it:

1. Queries the active tab for title and favicon.
2. Sends `getState` to the background and paints the toggle, slider, max label,
   per-site checkbox and status line from the response.

Slider `input` events update the readout immediately; the `setBoost` message is
coalesced with `requestAnimationFrame`, so at most one message per frame is sent
while dragging.

Enabling boost from the popup is one `setEnabled` with the slider's value. If
the background reports an error the toggle is flipped back and the error text
replaces the status line. While the popup is open, the background sends it
`statusChanged` whenever a frame of a tab reports new counts; the popup
re-reads `getState` and updates the status line only (not the slider, which
the user may be dragging).

The Max label is a button: a click (or Enter or Space) opens a number field in
its place. Enter saves a value from 1 to 1000; anything else shows a message
and keeps the field open; Esc or leaving the field cancels. **Forget saved
sites** swaps the footer for a question with **Cancel** (focused) and
**Forget**; Esc cancels too.

The on/off switch is a real checkbox made transparent over the drawn track, so
it stays in the tab order and gets a focus ring. All popup text is 13 px or
larger.

## Design background

The approach — boosting page media through Web Audio from a content script,
`crossorigin="anonymous"` on the elements, and an injected
`Access-Control-Allow-Origin` header for media responses — is the one a
comparable published Firefox extension uses, and it avoids `tabCapture`,
which isn't available in Firefox in a usable form.
