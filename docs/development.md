# Development

## Prerequisites

- Firefox 140 or newer (Developer Edition or Nightly recommended — they allow
  unsigned extensions permanently via `xpinstall.signatures.required = false`).
- Node.js (for `web-ext` only; the extension itself has no dependencies).

```sh
npm install --global web-ext
```

## Running locally

From the repository root:

```sh
web-ext run --source-dir ./volume-boost
```

This opens a temporary Firefox profile with the extension installed and
auto-reloads it whenever a file in the folder changes. Useful flags:

```sh
# Use a specific Firefox binary
web-ext run --source-dir ./volume-boost --firefox /path/to/firefox

# Reuse a persistent dev profile so settings survive restarts
web-ext run --source-dir ./volume-boost --firefox-profile volume-boost-dev --keep-profile-changes

# Open a URL on start
web-ext run --source-dir ./volume-boost --start-url https://www.youtube.com
```

Without `web-ext`: open `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on…** → pick `volume-boost/manifest.json`. Click **Reload** on
the same page after edits.

## Debugging

| What | Where |
| --- | --- |
| Background script console | `about:debugging` → this extension → **Inspect** |
| Content script console | The page's regular devtools console; filter by the frame if needed. Content script logs appear alongside page logs. |
| Popup | Open the popup, then in the background inspector use the toolbox's frame picker (the icon in the top-right of the console) to select `popup.html`. Or: `about:debugging` → **Inspect**, then open the popup — it stays open while the inspector has focus. |
| Storage | Background inspector → Storage tab → Extension Storage |

Handy console snippets in the **background** inspector:

```js
// Settings in memory
state

// Which tabs are boosted, at what level
[...boostedTabs]

// Media attached / failed per tab and frame
[...mediaCounts].map(([tab, frames]) => [tab, [...frames]])

// Which tabs currently get the CORS header
[...corsTabs]

// Is the webRequest listener registered?
browser.webRequest.onHeadersReceived.hasListener(injectCorsHeaders)

// Wipe persisted settings
browser.storage.local.clear()
```

In a **page** console where boost has been enabled (the content script's
variables aren't reachable from the page, but its side effects are):

```js
// Which media elements were switched to CORS mode, and what they're playing
document.querySelectorAll("audio, video").forEach(el =>
  console.log(el.crossOrigin, el.currentSrc || el.src)
)
```

## Linting

```sh
web-ext lint --source-dir ./volume-boost --warnings-as-errors
```

CI runs this on every push and pull request (see
[`.github/workflows/lint.yml`](../.github/workflows/lint.yml)) and fails on
any warning.

The manifest declares `data_collection_permissions: { required: ["none"] }`,
which Firefox 140+ requires for AMO submissions. That key is why
`strict_min_version` is `140.0` for desktop and `142.0` for Android
(`gecko_android`) — older builds don't recognise it and the linter flags the
mismatch.

## Manual test checklist

Automated checks — headless suites and a live check in a headless Firefox —
live in the repository's private agent workspace. They can't hear anything
and can't see the popup, so run through this before every release.

### Core

- [ ] On a page with playing audio, enabling boost audibly increases volume.
- [ ] Dragging the slider changes volume live, without clicks or dropouts.
- [ ] Each preset (10 / 50 / 80 / 100 / 120 / Max) sets the slider and the
      audio level and is highlighted; Max sets the current maximum.
- [ ] **Reset** returns to 100% and the audio matches un-boosted playback.
- [ ] Disabling boost returns the audio to normal level.
- [ ] Switching to another tab and back leaves the first tab boosted (audibly,
      and the popup on it still says Boosting this tab).
- [ ] Two tabs boosted at different levels each keep their own level.
- [ ] The toolbar icon shows the level on a boosted tab and nothing on others.
- [ ] Reloading a boosted tab keeps it boosted at the same level, badge
      included.

### Settings

- [ ] Slider value survives closing and reopening the popup.
- [ ] Slider value, max, and per-site toggle survive a Firefox restart.
- [ ] Clicking **Max 200%** opens a number field; Enter saves (slider range and
      Max follow, and the value persists), Esc cancels.
- [ ] Entering a max below the current slider value clamps the slider.
- [ ] Entering `0`, `5000` or text shows "Max must be between 1% and 1000%"
      and leaves the max unchanged.
- [ ] With **Remember level for this site** on, setting different levels on two sites and
      switching between them restores each site's level.
- [ ] With per-site off, all sites share the global level.
- [ ] **Forget saved sites** asks ("Forget N sites and reset?"); **Cancel**
      or Esc keeps everything; **Forget** resets the max to 200%, the level to
      100% and per-site to off.

### UI

- [ ] Popup renders at the correct size with no scrollbars, also with a very
      long tab title (cut with an ellipsis).
- [ ] Popup follows the system light/dark theme (toggle the OS theme with the
      popup closed, reopen).
- [ ] Tab title and favicon show in the header.
- [ ] At ≥ 300% the readout, "may distort" and the slider turn amber; below,
      they don't. The slider shows the 100% mark and the hatched 300%+ range.
- [ ] Status line reads "Boosting this tab" / "Off for this tab" and matches
      actual state; "On — waiting for audio or video" on a page without media.
- [ ] Keyboard only: Tab reaches the switch (focus ring visible), Space flips
      it; Tab to **Max** and Enter opens the field.

### Edge cases

- [ ] `about:addons`, `addons.mozilla.org`: turning boost on says "Can't boost
      this page. Try reloading it." and the toggle goes back off.
- [ ] Cross-origin media (e.g. a `<video>` whose `src` is on a CDN): boost
      works, not silence. Check the network panel for
      `Access-Control-Allow-Origin: *` on the media response.
- [ ] Media inside an iframe (e.g. an embedded player) is boosted, including
      a player the page loads after boost was turned on.
- [ ] A page that creates its own `AudioContext` for its player (some
      web-based players do): the popup shows "Media on this page could not be
      boosted" rather than silently doing nothing.
- [ ] Seeking in a boosted cross-origin video after boost is turned off
      continues to work (verifies the tab stays in `corsTabs`).

### Suggested test pages

- YouTube — media via MSE/blob; tests the `blob:` skip path.
- A direct `.mp4` / `.mp3` URL — simplest case, same-origin.
- An HTML page you host that embeds a `<video src="https://other-origin/…">` —
  the core CORS case.
- Any site with an embedded third-party player iframe.

## Releasing

1. Bump `version` in `manifest.json`. Use semver; patch for fixes, minor for
   features.
2. Run the manual test checklist above.
3. Lint: `web-ext lint --source-dir ./volume-boost --warnings-as-errors`.
4. Build:
   ```sh
   web-ext build --source-dir ./volume-boost --overwrite-dest
   ```
   Output goes to `volume-boost/web-ext-artifacts/volume_boost-<version>.zip`
   (git-ignored).
5. Sign / publish. Firefox requires signing for permanent installs. Either:
   - **Listed on AMO:** upload the zip at
     <https://addons.mozilla.org/developers/>. The `webRequestBlocking` +
     `<all_urls>` combination will trigger manual review; point reviewers at
     [permissions.md](./permissions.md).
   - **Self-distributed (unlisted):** sign via AMO with
     `web-ext sign --source-dir ./volume-boost --api-key … --api-secret …
     --channel unlisted` and distribute the resulting `.xpi` yourself.
6. Tag the commit: `git tag volume-boost-v<version>`. Since this repo holds
   multiple extensions, tags are prefixed with the extension name.

## Code conventions

- Plain ES2017+; no transpiler, no bundler, no `import`. Every script is a
  single file loaded directly by the manifest.
- `const API = typeof browser !== "undefined" ? browser : chrome;` at the top
  of every script. Use `API.*`, not `browser.*` directly.
- Clamp any number that crosses a process boundary (popup → background →
  content) on the receiving side; never trust the sender's range.
- Message handlers always respond, even on error.
- Keep [docs/spec.md](./spec.md) in sync when behaviour or permissions change —
  it's the spec AI coding tools read before editing this extension; the
  the rules are in [AGENTS.md](../AGENTS.md), which imports the private workshop's rulebook.
