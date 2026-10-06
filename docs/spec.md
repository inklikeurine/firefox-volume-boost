# Volume Boost — product spec

**Status:** 1.0. Released in the repository; not signed or listed on AMO.

## About

- Boosts a tab's audio past 100% by routing the page's media elements through
  a Web Audio gain stage and a limiter.

## Goals

- Simple, reliable volume boost for the tabs the user chooses.
- Safe defaults that avoid clipping or painfully loud output.
- Minimal permissions and clear user control.

## Non-goals

- System-wide audio amplification.
- Permanent audio modification outside the browser session.
- Browsers other than desktop Firefox.

## Who it's for

- Anyone whose video or audio in a tab is too quiet even at full volume:
  quiet uploads, lectures, podcasts, films with low dialogue.

## Core functionality

- Boost is switched on and off per tab from the popup. It stays on in a tab
  until it is switched off there; switching tabs does not change it. Several
  tabs can be boosted at once, each at its own level.
- A boosted tab stays boosted through reloads and navigation. It keeps its
  level, unless per-site mode has a level saved for the new site.
- Horizontal slider from 0% to a user-defined maximum (default 200%, hard cap
  1000%), with a live percentage readout.
- Presets: 10%, 50%, 80%, 100%, 120%, MAX (the current maximum).
- Reset returns the level to 100%.
- Remember per-site (opt-in): the level is saved per site origin and restored
  when boost is switched on there.
- Forget saved sites: clears every per-site level and resets the maximum, the
  level and per-site mode to their defaults, after a second click to confirm.
  Boosted tabs stay on, at 100%.
- A limiter (dynamics compressor) keeps high levels loud rather than distorted.
- A warning in the popup at 300% and above.
- The toolbar icon shows the level on a boosted tab.
- The popup's status line says what is happening: Boost Off; Boost On; Boost
  On — no media found yet; Media on this page could not be boosted; Can't
  boost this page. Try reloading it.
- Audio is boosted by a content script that attaches to the page's `<audio>`
  and `<video>` elements, in every frame, including media added after boost
  was switched on.

## Optional / future functionality

- Keyboard shortcut to toggle boost on the current tab.

## Permissions

- `<all_urls>` — the content script runs on any page and in every frame
  (players are often in embedded frames); the same access gives the tab's
  address (for per-site levels), title and icon (for the popup), and is the
  URL filter of the `webRequest` listener.
- `webRequest` + `webRequestBlocking` — add `Access-Control-Allow-Origin: *`
  to `media` responses, only for tabs where boost has been switched on.
  Without it Web Audio outputs silence for cross-origin media. A tab stays
  armed until it closes or navigates with boost off, because elements already
  switched to CORS mode would otherwise break on later range requests.
- `storage` — the settings below.
- `data_collection_permissions: { required: ["none"] }` — nothing leaves the
  browser.

## Architecture overview

- `background.js` (persistent background page): settings in `storage.local`;
  which tabs are boosted and at what level; media counts per frame; the badge;
  the CORS listener. Persistent because the boosted tabs and armed CORS tabs
  are session state and the blocking listener must stay registered while any
  tab is armed.
- `content.js` (every page and frame): builds the audio graph, attaches media
  elements, applies the gain, reports its counts.
- `popup.html/.js/.css`: the controls; talks only to the background.

Details in [architecture.md](./architecture.md) and
[messaging.md](./messaging.md).

## Settings and storage

`storage.local`, defaults applied on read, corrupt values replaced by defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `boostPercent` | `100` | Last level set (0 – max) |
| `maxBoostPercent` | `200` | Slider maximum (1 – 1000) |
| `perSite` | `false` | Remember a level per site |
| `siteBoosts` | `{}` | Site origin → level |

Which tabs are boosted is not stored: boost is off after Firefox restarts.

## UI requirements

- Fixed-size popup, follows the system light/dark theme, text 13 px or larger.
- Every control is reachable and operable from the keyboard. The maximum is
  changed by double-clicking the Max label, or focusing it and pressing Enter;
  a number field opens in place (Enter saves, Esc cancels).
- The status line always says whether boost is on for the current tab.

## Testing

Manual checklist (the click-list in the verification report is written from
this):

- Turn boost on on a page with audio → it is audibly louder, without crackling.
- Switch to another tab and back → still boosted; the popup still says
  Boost On.
- Boost a second tab → both stay boosted, each at its own level; each tab's
  icon badge shows its own level.
- Reload a boosted tab → still boosted at the same level, badge back.
- Reset → 100%; each preset → its level; MAX → the maximum.
- Change the maximum (double-click, and keyboard) → slider range and MAX follow;
  survives reopening the popup and restarting Firefox.
- Warning appears at 300% and disappears below.
- Remember per-site: two sites at different levels each get theirs back.
- Forget saved sites: asks first; then levels forgotten and defaults restored.
- A page with an embedded player (iframe) → the player is boosted.
- A cross-origin `<video>` (CDN-hosted) → boosted, not silent.
- `about:addons` → turning boost on says "Can't boost this page. Try
  reloading it." and the toggle goes back off.
- Popup in light and dark themes; keyboard only.

## Known limitations

- DRM-protected media cannot be routed through Web Audio.
- Muted tabs stay silent.
- Some cross-origin servers refuse CORS-mode requests outright.
- Media never added to the document, and players inside a shadow root, are
  not found.
- A page whose player already routes its media through its own AudioContext
  cannot be boosted.

## Release checklist

- Bump `version` in `manifest.json`; add the `CHANGELOG.md` entry.
- `node .dev/tools/check.mjs` clean; `node .dev/harness/run.mjs volume-boost --spec` passes.
- Manual checklist in a fresh profile.
- `web-ext build`; sign on AMO as unlisted once the owner has an AMO account.
