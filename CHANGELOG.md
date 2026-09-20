# Changelog

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
