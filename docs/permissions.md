# Permissions

Volume Boost asks for a fairly broad set of permissions for what looks like a
small feature. This page explains what each one is used for, where in the code
it's exercised, and what scoping is in place. The goal is that anyone reviewing
the extension (including AMO reviewers) can verify the claims against the
source.

## Summary

| Permission | Used in | Scope |
| --- | --- | --- |
| `activeTab` | popup.js, background.js | Active tab only |
| `tabs` | popup.js, background.js | Read `url`, `title`, `favIconUrl`; tab lifecycle events |
| `storage` | background.js | `storage.local` only, four keys |
| `<all_urls>` | manifest (content script), background.js | Content script on all pages; webRequest filter |
| `webRequest` | background.js | `onHeadersReceived`, `types: ["media"]` |
| `webRequestBlocking` | background.js | Required to *modify* response headers |

## Details

### `activeTab` and `tabs`

**What for:**

- `tabs.query({ active: true, currentWindow: true })` — the popup needs to know
  which tab it was opened on, and the background verifies that a
  `setEnabled` request targets the active tab.
- `tabs.get(tabId).url` — to derive the site origin for per-site boost
  levels. Only the origin (`scheme://host:port`) is kept; the full URL is
  never stored.
- `tab.title` and `tab.favIconUrl` — shown in the popup header so the user can
  see which tab they're boosting.
- `tabs.onActivated`, `tabs.onUpdated`, `tabs.onRemoved` — to disable boost
  when the user switches away, re-apply after a reload, and clean up the
  CORS tab set.
- `tabs.sendMessage` — to talk to the content script.

`activeTab` alone would not be enough because `tabs.onActivated` / `onUpdated`
listeners and reading the URL of a tab that is *not* the one the popup was
opened on (when disabling a previously boosted tab) need the `tabs`
permission.

### `storage`

Four keys in `storage.local`:

| Key | Type | Default |
| --- | --- | --- |
| `boostPercent` | number | 100 |
| `maxBoostPercent` | number | 600 |
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
- It does nothing at all until it receives an `applyBoost` message — no audio
  graph is created and no scanning runs on pages where the user never enables
  boost.

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
- **Only tabs where boost has been enabled.** `corsTabs` is populated in
  `setEnabled(true)` and emptied on tab close or on navigation while boost is
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

## Permissions not requested

- `tabCapture` — an alternative approach captures the tab's audio stream and
  re-plays it boosted. It's not available in Firefox in a usable form, and it
  doubles audio latency.
- `storage.sync` / `unlimitedStorage` — not needed.
- `notifications`, `alarms`, `history`, `bookmarks`, `cookies` — not used.
