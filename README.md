# Volume Boost

A Firefox extension that boosts a tab's audio beyond 100%, with a built-in
limiter to keep extreme boost levels from clipping into painful distortion.

**Version:** 1.0.1 · **Manifest:** v2 · **Minimum Firefox:** 140 (desktop)

## What it does

- Boosts audio in the tabs you choose. The boost **stays on in a tab until you
  turn it off there** — switching tabs doesn't change it — and several tabs
  can be boosted at once, each at its own level.
- The toolbar icon shows the boost level (e.g. `150`) while the tab you're
  looking at is boosted.
- Horizontal slider from 0% up to a user-defined maximum (default 200%, hard
  cap 1000%) with a live percentage readout.
- One-click presets: 10%, 50%, 80%, 100%, 120%, and Max; the one you're on
  is highlighted.
- The level is also shown in decibels (200% is +6 dB), and the slider marks
  100%.
- **Reset** button returns the tab to 100%.
- **Remember level for this site** stores a separate boost level for each
  site origin.
- **Forget saved sites** clears every remembered level and puts the settings
  back to their defaults.
- A soft limiter rounds off the loudest peaks instead of letting them clip, so
  the sound is unchanged below its peaks and high boost levels stay loud
  without harsh crackle.
- Popup follows the system light/dark theme and works from the keyboard.
- From 300%, where distortion becomes audible, the level and the slider turn
  amber and say "may distort"; the slider shades that range.
- The popup says when boost is on but the page has no media yet, and when the
  page's media could not be boosted.

## How it works (short version)

When you enable boost, a content script finds every `<audio>` and `<video>`
element on the page and routes it through the Web Audio API:

```
<audio>/<video> ─▶ MediaElementSource ─▶ GainNode ─▶ soft clipper (WaveShaper) ─▶ speakers
```

The gain node applies the boost; the soft clipper rounds off peaks that would
go past full scale. While boost is on
the content script watches the page, so media added later (e.g. an autoplaying
next episode, or an embedded player) gets picked up too.

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

Source: https://github.com/inklikeurine/firefox-extensions/tree/main/volume-boost

## Usage

1. Open a tab with playing audio or video.
2. Click the Volume Boost toolbar icon.
3. Flip the switch in the popup header on. The status line says
   **Boosting this tab** once it has found the page's audio or video.
4. Drag the slider, click a preset, or press **Reset** to return to 100%.

The boost stays on in that tab, even while you use other tabs, until you open
the popup there and flip the toggle off. To boost another tab as well, open
the popup on it and turn it on there too.

Everything in the popup works from the keyboard: Tab moves between the
controls, Space flips the toggle, and the arrow keys move the slider.

### Changing the maximum

Click **Max 200%** (with the pencil) under the slider and enter a new value
(1–1000). The slider range and the Max preset update immediately, and the
setting persists. From the keyboard, Tab to it and press Enter; then type the
value and press Enter to save, or Esc to cancel.

### Per-site levels

Tick **Remember level for this site**. From then on the boost value you set is saved
against the current site's origin (e.g. `https://www.youtube.com`) and restored
the next time you enable boost on that site. Sites without a saved value fall
back to the global level.

### Forgetting saved sites

Click **Forget saved sites** at the bottom of the popup. It asks first
("Forget 2 sites and reset?"): click **Forget** to go ahead, or **Cancel**
(or press Esc) to keep everything. Every per-site level is forgotten, and the maximum (200%), the boost
level (100%) and **Remember level for this site** (off) go back to their defaults. Tabs
that are boosted stay on, at 100%.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `storage` | Persist boost level, maximum, per-site toggle, and per-site levels. |
| `<all_urls>` | The content script must run on any page in order to find and boost its media elements. It runs in every frame (`all_frames: true`) because players are frequently embedded in iframes — a page's `<video>` is often inside a third-party player frame. The same access lets the popup show the tab's title and icon, and lets per-site mode read the tab's site. |
| `webRequest`, `webRequestBlocking` | Adds `Access-Control-Allow-Origin: *` to **media** responses, and only for tabs where boost has been enabled. Without this, Web Audio outputs silence for cross-origin media (CDN-hosted video, for instance). |

The CORS header injection is scoped as tightly as the API allows: it only
touches responses of type `media`, only for tabs that have had boost enabled,
and the listener is removed entirely when no such tabs remain. See
[docs/permissions.md](./docs/permissions.md) for the full reasoning.

Data collection: **none**. Nothing leaves the browser — settings stay in
Firefox's local extension storage, and the manifest declares
`data_collection_permissions: { required: ["none"] }`.

## Known limitations

- **DRM-protected media** (EME/Widevine) cannot be routed through Web Audio and
  will not be boosted.
- **Muted tabs** stay silent — boost multiplies whatever the page is outputting.
- **Some cross-origin media** still refuses CORS-mode loading even with the
  injected header (e.g. servers that reject the `Origin` header outright).
  The popup shows "On — this page's media can't be boosted" when every element
  on the page failed to attach.
- **Restricted pages** (`about:*`, `moz-extension:*`, addons.mozilla.org,
  the built-in PDF viewer) don't allow content scripts; turning boost on there
  says "Can't boost this page. Try reloading it."
- **Media the page never adds to the document** (created in a script and
  played without being inserted), and players inside a shadow root, are not
  found.
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
| [docs/spec.md](./docs/spec.md) | Product spec: goals, non-goals, functionality, settings, testing, release checklist |

## AI-generated

This extension was generated by an AI agent under human direction. It is
provided as-is, with no warranty, and used at your own risk. Read the source
before installing — it is short.

## License

Public domain under [The Unlicense](../UNLICENSE). Copy it, fork it, sell it,
strip the name off it — no attribution required.
