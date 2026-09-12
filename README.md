# Volume Boost

A Firefox extension that boosts the audio of the active tab beyond 100%, with a
built-in limiter to keep extreme boost levels from clipping into painful
distortion.

**Version:** 0.2.0 · **Manifest:** v2 · **Minimum Firefox:** 78

## What it does

- Boosts audio on the **active tab only** — switching tabs turns the boost off
  for the previous tab.
- Horizontal slider from 0% up to a user-defined maximum (default 600%, hard
  cap 5000%) with a live percentage readout.
- One-click presets: 10%, 50%, 80%, 100%, 200%, and MAX−20.
- **Reset** button returns the tab to 100%.
- Optional **Remember per-site** mode that stores a separate boost level for
  each site origin.
- A dynamics compressor acts as a safety limiter so high boost levels are loud
  rather than distorted.
- Popup follows the system light/dark theme.
- A warning appears in the popup when boost is set to 1000% or higher.

## How it works (short version)

When you enable boost, a content script finds every `<audio>` and `<video>`
element on the page and routes it through the Web Audio API:

```
<audio>/<video> ─▶ MediaElementSource ─▶ GainNode ─▶ DynamicsCompressor ─▶ speakers
```

The gain node applies the boost; the compressor limits peaks. The content script
re-scans the page once a second while boost is on, so media added later (e.g.
an autoplaying next episode) gets picked up too.

For the full explanation, see [docs/architecture.md](./docs/architecture.md).

## Installation

There is no build step — the folder is loadable as-is.

### Temporary install (for trying it out)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this folder.

The extension is removed when Firefox restarts.

### With `web-ext` (for development)

```sh
npm install --global web-ext
web-ext run --source-dir ./volume-boost
```

This launches a clean Firefox profile with the extension loaded and reloads it
automatically when a file changes.

### Permanent install

Firefox only permanently installs signed extensions. Build a package with
`web-ext build --source-dir ./volume-boost` and submit it to
[addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
(unlisted self-distribution is fine). Details are in
[docs/development.md](./docs/development.md#releasing).

## Usage

1. Open a tab with playing audio or video.
2. Click the Volume Boost toolbar icon.
3. Flip the toggle in the popup header to **Boost On**.
4. Drag the slider, click a preset, or press **Reset** to return to 100%.

### Changing the maximum

Double-click the **Max 600%** label under the slider and enter a new value
(1–5000). The slider range and the MAX−20 preset update immediately, and the
setting persists.

### Per-site levels

Tick **Remember per-site**. From then on the boost value you set is saved
against the current site's origin (e.g. `https://www.youtube.com`) and restored
the next time you enable boost on that site. Sites without a saved value fall
back to the global level.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `activeTab`, `tabs` | Identify the active tab, read its URL for per-site settings, and show its title/favicon in the popup. |
| `storage` | Persist boost level, maximum, per-site toggle, and per-site levels. |
| `<all_urls>` (content script) | The content script must run on any page in order to find and boost its media elements. |
| `webRequest`, `webRequestBlocking` | Adds `Access-Control-Allow-Origin: *` to **media** responses, and only for tabs where boost has been enabled. Without this, Web Audio outputs silence for cross-origin media (CDN-hosted video, for instance). |

The CORS header injection is scoped as tightly as the API allows: it only
touches responses of type `media`, only for tabs that have had boost enabled,
and the listener is removed entirely when no such tabs remain. See
[docs/permissions.md](./docs/permissions.md) for the full reasoning.

## Known limitations

- **DRM-protected media** (EME/Widevine) cannot be routed through Web Audio and
  will not be boosted.
- **Muted tabs** stay silent — boost multiplies whatever the page is outputting.
- **Some cross-origin media** still refuses CORS-mode loading even with the
  injected header (e.g. servers that reject the `Origin` header outright).
  The popup shows "Media on this page could not be boosted" when every element
  on the page failed to attach.
- **Restricted pages** (`about:*`, `moz-extension:*`, addons.mozilla.org)
  don't allow content scripts; enabling boost there shows an error.
- Boost is **per browser session** — reopening Firefox starts with boost off,
  though your slider value and settings are remembered.

## Documentation

| File | Contents |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | Component overview, audio graph, state model, CORS strategy |
| [docs/messaging.md](./docs/messaging.md) | Every message type exchanged between popup, background, and content script |
| [docs/permissions.md](./docs/permissions.md) | Justification and scope of each permission |
| [docs/development.md](./docs/development.md) | Local setup, manual test checklist, release process |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | Common problems and how to diagnose them |
| [docs/learnings-reference-extension.md](./docs/learnings-reference-extension.md) | Notes from studying a comparable published extension |
| [docs/learnings-firefox-popup.md](./docs/learnings-firefox-popup.md) | Firefox popup sizing/rendering gotchas |
| [agents.md](./agents.md) | Product spec and guidance for AI coding agents working on this extension |

## License

No license has been chosen yet. Until one is added, all rights are reserved.
