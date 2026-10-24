# Messaging protocol

All communication goes through the background script. The popup never messages
the content script directly.

- **Popup → Background:** `browser.runtime.sendMessage(message)`
- **Content script → Background:** `browser.runtime.sendMessage(message)`
  (`frameReady`, `frameStatus`; the background reads the tab and frame from
  `sender`)
- **Background → Content script:** `browser.tabs.sendMessage(tabId, message)`
  (every frame of the tab)
- **Background → Popup:** `browser.runtime.sendMessage(message)`
  (`statusChanged`; fails harmlessly when no popup is open)

Every message is a plain object with a `type` string. Every handler responds
(the background listener returns `true` to keep the channel open for its async
handler). Unknown or malformed messages get `{ ok: false, error: "..." }`. The
popup's listener answers only `statusChanged` and leaves every other type to
the background.

## Popup → Background

### `getState`

Fetch everything the popup needs to render.

```js
// request
{ type: "getState", tabId }

// response
{
  enabled: boolean,        // is this tab boosted
  boostPercent: number,    // the tab's level if boosted, else the level it would get (per-site if applicable)
  maxBoostPercent: number,
  perSite: boolean,
  savedSites: number,      // how many per-site levels are stored
  attached: number,        // media elements boosted, all frames of the tab
  failed: number           // media elements that refused, all frames of the tab
}
```

### `setBoost`

Change the boost level. Persists (debounced) and, if this tab is boosted,
pushes the new level to it immediately and updates its badge. Other boosted
tabs keep their levels.

```js
// request
{ type: "setBoost", tabId, value: number }

// response
{ boostPercent: number }   // rounded, clamped to 0..maxBoostPercent
```

In per-site mode this also writes `siteBoosts[origin] = value` for the tab's
origin (HTTP/HTTPS only).

### `setMaxBoost`

Change the slider ceiling. Clamps the global level, every stored per-site
level and every boosted tab's level down to the new max, and re-applies to the
boosted tabs.

```js
// request
{ type: "setMaxBoost", value: number }

// response
{ maxBoostPercent: number }   // 1..1000; a non-number or a value below 1 gives the default 200
```

### `setPerSite`

Toggle per-site memory. When turning it **on**, the current global level is
immediately stored for the current tab's origin so the site doesn't appear to
"lose" its level.

```js
// request
{ type: "setPerSite", tabId, value: boolean }

// response
{ perSite: boolean }
```

### `resetSettings`

Forget every per-site level and restore the defaults (max 200, level 100,
per-site off). Saved at once. Boosted tabs stay boosted, at 100%.

```js
// request
{ type: "resetSettings" }

// response
{ ok: true, forgotten: number, boostPercent: 100, maxBoostPercent: 200, perSite: false }
```

### `setEnabled`

Turn boost on or off for a tab. Turning it on in one tab never turns it off in
another.

```js
// request
{ type: "setEnabled", tabId, value: boolean, boostPercent?: number }
```

With `boostPercent`, switching on also stores that level exactly as `setBoost`
does (the last level set, and the site's level in per-site mode). Without
it, the tab gets its site's level in per-site mode, otherwise the last level
set.

Possible responses:

```js
{ enabled: true }
{ enabled: false }
{ enabled: false, error: "Can't boost this page. Try reloading it." }
```

The error means `tabs.sendMessage` failed: no content script answered in the
tab (Firefox's own `about:` pages, addons.mozilla.org, the PDF viewer, or a
page still loading). The tab is not marked boosted and its CORS arming is
undone. Whether media was actually found is not part of this answer; it
arrives through `frameStatus` and `getState`.

## Content script → Background

### `frameReady`

Sent once by every frame when its content script loads. The answer says
whether the frame's tab is boosted, so a reloaded page or an embedded player
inserted later starts boosted.

```js
// request
{ type: "frameReady" }

// response
{ enabled: true, boostPercent: number }
{ enabled: false }
```

### `frameStatus`

Sent by a frame whenever its own counts change. The background stores them per
`sender.frameId` (replacing that frame's previous report), clears a tab's
counts when it starts loading a new document, and sends the popup
`statusChanged`.

```js
// request
{ type: "frameStatus", attached: number, failed: number }

// response
{ ok: true }
{ ok: false, error: "Not sent from a tab" }
```

## Background → Popup

### `statusChanged`

A frame of `tabId` reported new counts. The popup, if it shows that tab,
re-reads `getState` and updates its status line.

```js
// request
{ type: "statusChanged", tabId }

// response (popup)
{ ok: true }
```

## Background → Content script

### `applyBoost`

The only command the content script accepts from the background. It goes to
every frame of the tab. Both fields are optional; omitted fields leave the
content script's state untouched.

```js
// request
{ type: "applyBoost", enabled?: boolean, boostPercent?: number }

// response (the first frame to answer)
{ ok: true }
```

The background only needs to know that some frame answered; each frame's
media counts arrive separately as `frameStatus`. The level is clamped to
0–1000 in the content script.

Behaviour on receipt:

- `enabled: true` → set gain, attach the frame's media (the audio graph is
  built when the first element attaches; a frame without media has none),
  start watching for more (`MutationObserver` plus capture-phase
  `loadstart`/`play` listeners), report counts if they changed.
- `enabled: false` → set gain to 1.0, stop watching. Graph and existing source
  nodes are retained (see [architecture.md](./architecture.md#attach-lifecycle)).

The background sends `applyBoost { enabled: false, boostPercent: 100 }` when
disabling; the content script ignores the percent in that case since gain is
forced to 100 anyway.

## Sequence: enabling boost from the popup

```text
Popup                       Background                        Content script (each frame)
  │                              │                                   │
  │ setEnabled {value: true,     │                                   │
  │             boostPercent:150}│                                   │
  │─────────────────────────────▶│ state.boostPercent = 150          │
  │                              │ siteBoosts[origin] = 150 (if perSite)
  │                              │ scheduleSave()                    │
  │                              │ boostedTabs.set(tab, 150)         │
  │                              │ corsTabs.add(tab)                 │
  │                              │ applyBoost {enabled:true, 150}    │
  │                              │──────────────────────────────────▶│ setGain(150), attach media
  │                              │                                   │ (graph built on first attach), start watching
  │                              │◀──────────────────────────────────│ {ok: true}
  │                              │ badge "150"                       │
  │◀─────────────────────────────│ {enabled: true}                   │
  │ getState → status line       │                                   │
  │                              │◀──────────────────────────────────│ frameStatus {attached, failed}
  │◀─────────────────────────────│ statusChanged {tabId}             │
  │ getState → "Boosting…"       │                                   │
```

## Sequence: a frame loads into a boosted tab

```text
Content script (new frame)        Background
  │ frameReady                         │
  │───────────────────────────────────▶│ boostedTabs.has(sender.tab.id)?
  │◀───────────────────────────────────│ {enabled: true, boostPercent: 150}
  │ applyState(): gain, attach (graph) │
  │ frameStatus {attached, failed}     │
  │───────────────────────────────────▶│ mediaCounts[tab][frameId] = …
```
