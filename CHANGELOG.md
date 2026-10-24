# Changelog

## [1.1.0] — 2026-10-24

### Changed

- Redesigned popup, same 360×271 size and the same controls: one flat
  surface instead of the gradient background and inner card, the system
  font, and tighter spacing.
- The level is shown in decibels as well as percent (200% is +6 dB).
- The slider marks 100% and shades the range above 300%. From 300% the level,
  the slider and a "may distort" note turn amber, instead of a warning
  squeezed in beside Reset.
- With boost off, the level and slider are greyed: the level is kept but not
  applied.
- The preset matching the level is highlighted; Reset is greyed at 100%.
- The maximum opens with a single click on **Max 200%** (now with a pencil
  icon) instead of a double-click.
- The status line under the tab's title appears only when something needs
  attention, with a coloured dot: "On — waiting for audio or video", "On —
  this page's media can't be boosted", errors and notes. While boost is off,
  or on and working, it is hidden; the switch shows the state.
- **Remember per-site** is now **Remember level for this site**.
- **Forget saved sites** sits in a footer and asks with **Cancel** and
  **Forget** buttons, instead of "click again to confirm" that lapsed after
  four seconds.

## [1.0.1] — 2026-10-06

### Fixed

- Boosting made little or no audible difference on YouTube and other
  streaming sites: the limiter took back most of the boost on audio that is
  already mastered close to full scale (200% came out only about 2 dB louder
  than 100%). The limiter is now a soft clipper that leaves the sound
  untouched below its peaks and rounds the peaks off instead of clipping
  them, so 200% is +6 dB and 300% about +9 dB. 100% is now exactly the
  original volume (the old limiter changed it slightly even at 100%).
- After Volume Boost was reloaded, updated or re-enabled with a boosted video
  open, that video stayed at the old level for good: the earlier copy's
  audio routing kept playing it out of reach, so the slider seemed to do
  nothing, and switching boost on again played the sound twice. The new copy
  now takes such media over (at 100% until boost is switched on) and closes
  the old routing.
- A boosted tab no longer opens an audio stream in every embedded frame (ads,
  sign-in widgets); only frames that have media do.

### Changed

- The popup is shorter: the empty space under **Forget saved sites** is gone.
  The distortion warning now appears next to the level instead of in a row
  of its own.
- Code reorganised: what the background, popup and content script share is
  in `lib/common.js`; switching boost on is one message instead of two. No
  behaviour change.

### Removed

- The update step from 0.x that turned a saved maximum of exactly 600% into
  200%. No installation can still need it: temporary installs lose their
  settings when Firefox restarts.

## [1.0.0] — 2026-10-05

### Added

- The toolbar icon shows the boost level (e.g. `250`) on a boosted tab.
- **Forget saved sites**: one button (click twice to confirm) that clears
  every per-site level and resets the maximum, the level and per-site mode to
  their defaults. Boosted tabs stay on, at 100%.
- The popup says when boost is on but no media has been found yet, and
  totals media across a page and its embedded players.
- An embedded player loaded after boost was switched on (an iframe inserted
  later) is boosted too.

### Changed

- Boost stays on in a tab until it is switched off there; switching tabs no
  longer turns it off. Several tabs can be boosted at once, each at its own
  level.
- Default maximum 200% (was 600%); the hard cap is 1000% (was 5000%).
  Updating from 0.x turns a saved maximum of exactly 600% (the old default)
  into 200%; other saved values are kept, capped at 1000%.
- Presets are 10%, 50%, 80%, 100%, 120% and MAX (were …, 200% and MAX−20).
- The distortion warning appears at 300% (was 1000%).
- The maximum is edited in place: double-click **Max**, or focus it and press
  Enter, then type a value and press Enter (Esc cancels).
- The popup is keyboard-operable (the on/off switch is reachable with Tab and
  shows a focus ring) and uses 13 px text or larger.
- Media added to a page is noticed as it appears instead of by a scan every
  second.
- A page the extension can't reach (`about:` pages, addons.mozilla.org, the
  PDF viewer) says "Can't boost this page. Try reloading it." instead of a raw
  error.
- After navigating, a boosted tab keeps its level unless per-site mode has a
  level saved for the new site.

### Fixed

- A saved level of 0% came back as 100% after restarting Firefox.
- "Media on this page could not be boosted" could be wrong, or missing, when
  the player was in an embedded frame.

### Removed

- The `tabs` and `activeTab` permissions: the access Volume Boost already has
  to every page covers what they gave.

## [0.2.1] — 2026-09-20

### Changed

- Repository housekeeping: the product spec moved from `agents.md` (which
  `web-ext build` used to package) to `docs/spec.md`; added `CHANGELOG.md`,
  an AI-generated notice and a data-collection statement to the README. No
  behaviour change.

## [0.2.0] — 2026-09-11

### Added

- First version in this repository: active-tab boost with a limiter, slider
  with presets, user-defined maximum, optional per-site levels, and scoped
  CORS header injection for cross-origin media.

### Changed

- Requires Firefox 140+ (`strict_min_version`), declares
  `data_collection_permissions: { required: ["none"] }`, released under the
  Unlicense.

_Changes before 0.2.0 predate this repository and are not recorded._
