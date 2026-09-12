# Messaging protocol

All communication goes through the background script. The popup never messages
the content script directly.

- **Popup → Background:** `browser.runtime.sendMessage(message)`
- **Background → Content script:** `browser.tabs.sendMessage(tabId, message)`

Every message is a plain object with a `type` string. Every handler responds
(the background listener returns `true` to keep the channel open for its async
handler). Unknown or malformed messages get `{ ok: false, error: "..." }`.

## Popup → Background

### `getState`

Fetch everything the popup needs to render.

```js
// request
{ type: "getState", tabId }

// response
{
  enabled: boolean,        // is *this* tab the currently boosted tab
  boostPercent: number,    // resolved for this tab (per-site if applicable)
  maxBoostPercent: number,
  perSite: boolean
}
```

### `setBoost`

Change the boost level. Persists (debounced) and, if this tab is currently
boosted, pushes the new level to the content script immediately.

```js
// request
{ type: "setBoost", tabId, value: number }

// response
{ boostPercent: number }   // clamped to 0..maxBoostPercent
```

In per-site mode this also writes `siteBoosts[origin] = value` for the tab's
origin (HTTP/HTTPS only).

### `reset`

Alias for `setBoost` with `value: 100`. The popup currently calls `setBoost`
directly for Reset, but the message exists for future use (e.g. a keyboard
command).

```js
{ type: "reset", tabId }
// response: same as setBoost
```

### `setMaxBoost`

Change the slider ceiling. Clamps the global level and every stored per-site
level down to the new max, then re-applies to the boosted tab if any.

```js
// request
{ type: "setMaxBoost", value: number }

// response
{ maxBoostPercent: number }   // clamped to 1..5000
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

### `setEnabled`

Turn boost on or off for a tab.

```js
// request
{ type: "setEnabled", tabId, value: boolean, boostPercent?: number }
```

`boostPercent` is optional; if omitted the background resolves it via the
per-site logic.

Possible responses:

```js
{ enabled: true }
{ enabled: true,  warning: "Media on this page could not be boosted" }
{ enabled: false }
{ enabled: false, error: "Tab is not active" }
{ enabled: false, error: "<message from tabs.sendMessage failure>" }
```

- `"Tab is not active"` — the popup's tab is no longer the active tab in the
  current window. Only the active tab may be boosted.
- The `warning` variant means the content script responded but reported
  `failed > 0` and `attached === 0`: every media element on the page refused to
  attach (usually because another `AudioContext` already owns them).
- A `tabs.sendMessage` failure (typically "Could not establish connection" on
  a restricted page) is returned as `error`, and the tab is not marked enabled.

## Background → Content script

### `applyBoost`

The only command the content script accepts from the background. Both fields
are optional; omitted fields leave the content script's state untouched.

```js
// request
{ type: "applyBoost", enabled?: boolean, boostPercent?: number }

// response
{
  ok: true,
  enabled: boolean,
  boostPercent: number,     // clamped to 0..5000
  attached: number,         // media elements successfully routed through Web Audio
  failed: number            // media elements that threw on attach
}
```

Behaviour on receipt:

- `enabled: true` → build the audio graph if needed, set gain, start the 1 s
  scan loop.
- `enabled: false` → set gain to 1.0, stop scanning. Graph and existing source
  nodes are retained (see [architecture.md](./architecture.md#attach-lifecycle)).

The background sends `applyBoost { enabled: false, boostPercent: 100 }` when
disabling; the content script ignores the percent in that case since gain is
forced to 100 anyway.

### `getState` (content script)

Diagnostic query; not currently used by the background or popup but available
for debugging from the console.

```js
// request
{ type: "getState" }

// response: identical shape to the applyBoost response
```

## Sequence: enabling boost from the popup

```
Popup                       Background                        Content script
  │                              │                                   │
  │ setBoost {value: 250}        │                                   │
  │─────────────────────────────▶│ state.boostPercent = 250          │
  │                              │ siteBoosts[origin] = 250 (if perSite)
  │                              │ scheduleSave()                    │
  │◀─────────────────────────────│ {boostPercent: 250}               │
  │                              │                                   │
  │ setEnabled {value: true,     │                                   │
  │             boostPercent:250}│                                   │
  │─────────────────────────────▶│ verify tab is active              │
  │                              │ disable previous tab (if any)     │
  │                              │ enabledTabId = tabId              │
  │                              │ corsTabs.add(tabId)               │
  │                              │ applyBoost {enabled:true, 250}    │
  │                              │──────────────────────────────────▶│ ensureAudioGraph()
  │                              │                                   │ setGain(250)
  │                              │                                   │ startScanning()
  │                              │◀──────────────────────────────────│ {ok, attached, failed}
  │◀─────────────────────────────│ {enabled: true[, warning]}        │
  │ setEnabledUI(true)           │                                   │
```

## Sequence: user switches tabs

```
Firefox                     Background                        Content script (old tab)
  │ tabs.onActivated             │                                   │
  │─────────────────────────────▶│ enabledTabId !== newTab?          │
  │                              │ applyBoost {enabled:false, 100}   │
  │                              │──────────────────────────────────▶│ setGain(100)
  │                              │ enabledTabId = null               │ stopScanning()
  │                              │ (tab stays in corsTabs)           │
```
