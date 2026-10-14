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
- One-click presets: 10%, 50%, 80%, 100%, 120%, and MAX.
- **Reset** button returns the tab to 100%.
- **Remember per-site** mode that stores a separate boost level for
  each site origin.
- **Forget saved sites** clears every remembered level and puts the settings
  back to their defaults.
- A soft limiter rounds off the loudest peaks instead of letting them clip, so
  the sound is unchanged below its peaks and high boost levels stay loud
  without harsh crackle.
- Popup follows the system light/dark theme and works from the keyboard.
- A warning appears next to the level when boost is set to 300% or higher.
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

There is no build step — clone the repository
(`git clone https://github.com/inklikeurine/firefox-volume-boost`); its folder loads as-is.

### Temporary install (for trying it out)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `manifest.json` inside this folder.

The extension is removed when Firefox restarts.

### With `web-ext` (for development)

```sh
npm install --global web-ext
web-ext run --source-dir .
```

This launches a clean Firefox profile with the extension loaded and reloads it
automatically when a file changes.

### Permanent install

Firefox only permanently installs signed extensions. Build a package with
`web-ext build --source-dir .` and submit it to
[addons.mozilla.org](https://addons.mozilla.org/developers/) for signing
(unlisted self-distribution is fine). Details are in
[docs/development.md](./docs/development.md#releasing).

Source: https://github.com/inklikeurine/firefox-volume-boost

## Usage

1. Open a tab with playing audio or video.
2. Click the Volume Boost toolbar icon.
3. Flip the toggle in the popup header to **Boost On**.
4. Drag the slider, click a preset, or press **Reset** to return to 100%.

The boost stays on in that tab, even while you use other tabs, until you open
the popup there and flip the toggle off. To boost another tab as well, open
the popup on it and turn it on there too.

Everything in the popup works from the keyboard: Tab moves between the
controls, Space flips the toggle, and the arrow keys move the slider.

### Changing the maximum

Double-click the **Max 200%** label under the slider and enter a new value
(1–1000). The slider range and the MAX preset update immediately, and the
setting persists. From the keyboard, Tab to the label and press Enter; then
type the value and press Enter to save, or Esc to cancel.

### Per-site levels

Tick **Remember per-site**. From then on the boost value you set is saved
against the current site's origin (e.g. `https://www.youtube.com`) and restored
the next time you enable boost on that site. Sites without a saved value fall
back to the global level.

### Forgetting saved sites

Click **Forget saved sites**, then click it again within a few seconds to
confirm. Every per-site level is forgotten, and the maximum (200%), the boost
level (100%) and **Remember per-site** (off) go back to their defaults. Tabs
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
  The popup shows "Media on this page could not be boosted" when every element
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

AI code generators are trained on enormous pools of public code, released under
every license imaginable — permissive, copyleft, and non-commercial alike. The
origin of any individual generated line is untraceable. Output built from that
pool cannot honestly be owned by anyone.

My position: code built from the commons belongs to the commons. Since no one
can know which licenses any given line was originally released under,
AI-generated code should be treated as unlicensable — public domain by default.

Accordingly, all code in this repository is released into the public domain
under the [Unlicense](UNLICENSE).
