# Changelog

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
