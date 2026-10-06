# Permissions

Volume Boost asks for a fairly broad set of permissions for what looks like a
small feature. This page explains what each one is used for, where in the code
it's exercised, and what scoping is in place. The goal is that anyone reviewing
the extension (including AMO reviewers) can verify the claims against the
source.

## Summary

| Permission | Used in | Scope |
| --- | --- | --- |
| `storage` | background.js | `storage.local` only, four keys |
| `<all_urls>` | manifest (content script), background.js, popup.js | Content script on all pages; a tab's `url`, `title`, `favIconUrl`; webRequest filter |
| `webRequest` | background.js | `onHeadersReceived`, `types: ["media"]` |
| `webRequestBlocking` | background.js | Required to *modify* response headers |

## Details

### Tabs without the `tabs` permission

Volume Boost does not request `tabs` or `activeTab`. What it needs from tabs
comes with `<all_urls>` or needs no permission at all:

- `tabs.query({ active: true, currentWindow: true })` — the popup finds the
  tab it was opened on. No permission needed.
- `tab.url`, `tab.title`, `tab.favIconUrl` — per MDN (`tabs.Tab`), present
  with the `tabs` permission **or a matching host permission**, which
  `<all_urls>` is for every web page. The URL gives the site origin for
  per-site levels (only the origin, `scheme://host:port`, is kept; the full URL
  is never stored); the title and icon are shown in the popup header.
- `tabs.onUpdated`, `tabs.onRemoved` — re-apply boost and the badge after a
  navigation, and clean up when a tab closes. The events fire without the
  `tabs` permission; only the URL/title properties are gated.
- `tabs.sendMessage` — to talk to the content script. No permission needed
  beyond the content script being there.
- `browserAction.setBadgeText` — the level on the toolbar icon. No permission
  needed.

### `storage`

Four keys in `storage.local`:

| Key | Type | Default |
| --- | --- | --- |
| `boostPercent` | number | 100 |
| `maxBoostPercent` | number | 200 |
| `perSite` | boolean | false |
| `siteBoosts` | `{ [origin]: number }` | `{}` |

Nothing is synced (`storage.sync` is not used) and no browsing history beyond
site origins with a saved level is retained.

### `<all_urls>` — content script

The content script must be present on any page that might play media. There is
no way to know in advance which pages will, and injecting on demand via
`tabs.executeScript` would still require `<all_urls>` host permission for
arbitrary sites.

What the content script does **not** do:

- It does not read page content, form data, or cookies.
- It does not make network requests.
- On a page where the user never enables boost it does one thing: when it
  loads, it asks Volume Boost's own background page whether the tab is boosted
  (`frameReady`, a message inside the browser). The answer is no, and nothing
  else happens — no audio graph, no observer, no listeners on the page.

### `<all_urls>` — webRequest filter

The `onHeadersReceived` listener is registered with `urls: ["<all_urls>"]`
because media can be served from any origin. The actual scoping is done by the
`types: ["media"]` filter and the per-tab `corsTabs` check (below).

### `webRequest` and `webRequestBlocking`

This is the permission most worth scrutinising, so here is the exact behaviour
from `background.js`:

```js
const CORS_FILTER = { urls: ["<all_urls>"], types: ["media"] };

function injectCorsHeaders(details) {
  if (!corsTabs.has(details.tabId)) {
    return {};                                    // ← untouched
  }
  // ...set Access-Control-Allow-Origin: * on responseHeaders
}
```

- **Only `media` requests.** Documents, scripts, stylesheets, images, XHR,
  fetch, WebSocket, fonts — all untouched.
- **Only tabs where boost has been enabled.** A tab is added to `corsTabs` in
  `setEnabled(true)` and removed on tab close or on navigation while boost is
  off. Any other tab's media requests are returned unmodified.
- **Listener only exists while needed.** `updateCorsListener()` adds the
  listener when `corsTabs` becomes non-empty and removes it when the set
  empties. If the user never enables boost, no `webRequest` listener is ever
  registered.
- **Only one header is touched.** `Access-Control-Allow-Origin` is set to `*`
  (added if absent, overwritten if present). No other header is read or
  modified.

**Why it's needed:** `MediaElementAudioSourceNode` outputs silence for
cross-origin media that wasn't loaded with CORS approval. Setting
`crossorigin="anonymous"` on the element makes the browser *request* CORS mode,
but the server still has to *grant* it, and most media CDNs don't. Rewriting
the response header is the only way to make Web Audio work on such media
without a proxy. See the
[CORS section of architecture.md](./architecture.md#why-cors-handling-is-required).

**Security consideration:** Setting `Access-Control-Allow-Origin: *` on a media
response means any script on that page could `fetch()` the media bytes
cross-origin for the lifetime of that tab. For public media files this is not a
meaningful exposure — the bytes are already playable by the page. It could
matter for media behind cookie-based auth on a third-party origin, which is why
the injection is limited to tabs where the user has explicitly opted in by
enabling boost.

## Data collection declaration

The manifest declares:

```json
"data_collection_permissions": { "required": ["none"] }
```

This is the Firefox 140+ built-in data-consent declaration. `"none"` is
accurate: the extension makes no network requests of its own, stores only
site origins with a saved boost level (locally, unsynced), and transmits
nothing anywhere.

## Permissions not requested

- `tabs`, `activeTab` — `<all_urls>` already gives what they would (see
  above).
- `tabCapture` — an alternative approach captures the tab's audio stream and
  re-plays it boosted. It's not available in Firefox in a usable form, and it
  doubles audio latency.
- `storage.sync` / `unlimitedStorage` — not needed.
- `notifications`, `alarms`, `history`, `bookmarks`, `cookies` — not used.
