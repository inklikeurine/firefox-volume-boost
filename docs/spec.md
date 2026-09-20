## About
 - This repo contains a Firefox extension that boosts the current tab's audio by routing page media elements through a Web Audio gain + limiter.

## Goals
- Simple, reliable volume boost for the active tab.
- Safe defaults that avoid clipping or painfully loud output.
- Minimal permissions and clear user control.

## Non-Goals
- System-wide audio amplification.
- Permanent audio modification outside the browser session.

## Core Functionality
- Boost audio for the current tab only.
- Slider-based boost control with a visible on/off state.
- Reset to normal volume.
- Per-site remembered boost levels (opt-in).
- Safe limiter to reduce clipping at high boost.
- Horizontal slider with live percentage readout.
- Slider presest (10%, 50%, 80%, 100%, 200%, (max-20%))
- Audio is boosted via a content script that attaches to audio/video elements on the page.

## Optional / Future Functionality
- Keyboard shortcut to toggle boost on/off.
- Visual indicator on the extension icon when boost is active.

## Permissions
- Use the minimum permissions required to control the active tab and store settings.
- Host access to pages is required for the content script to attach to audio/video elements.
- `webRequest` + `webRequestBlocking` (with `<all_urls>`) are used to add `Access-Control-Allow-Origin` to media responses, but only for tabs where boost has been enabled and only for `media`-type requests. Without this, Web Audio outputs silence for cross-origin media. The injection stays active on a tab until it closes or navigates with boost off, because CORS-tainted elements would otherwise break on later range requests.
- If additional permissions are needed, explain why in the UI and in the README.

## Architecture Overview
- Background script stores settings, resolves per-site levels, and sends boost commands to the active tab.
- Content script scans for audio/video elements and routes them through AudioContext -> GainNode -> DynamicsCompressor -> destination.
- Popup UI controls boost level and displays current status via background messaging.

## Settings and Storage
- Store user settings (boost level, presets, per-site preference) in extension storage.
- Max boost is user-configurable via double-click input; default max is 600%.
- Provide sensible defaults and a quick reset to defaults.

## UI Requirements
- Popup is a rectangle layout.
- Slider is horizontal and ranges from 0% to the user-defined max.
- Live readout is in percentage (e.g., 125%).
- Popup respects system theme (light/dark).

## Performance Notes
- Live percentage readout should be lightweight and only update while the popup is open.
- Prefer throttled updates (e.g., 20-30 FPS) and minimal DOM changes.
- Content script should avoid heavy DOM churn; scan at a modest interval or use a MutationObserver.

## UX Guidelines
- Default boost should be conservative.
- Warn or cap when a user selects extreme boost values (1000+%).
- Always show whether boost is active for the current tab.

## Testing
Manual checks before release:
- Can boost audio on the active tab.
- Switching tabs stops boosting the previous tab.
- Reset returns audio to normal level.
- Settings persist across browser restarts (if enabled).
- UI reflects current state reliably.
- Slider respects 0% to user-defined max, default 600%.
- Double-click to set max works and persists.
- Popup respects system theme (light/dark).
- Restricted pages (about:, moz-extension:, addons.mozilla.org) gracefully show a boost error.

## Known Limitations
- Some DRM-protected media may not be capturable.
- Muted tabs will not produce audio even when boosted.
- Some cross-origin media may not allow Web Audio routing.

## Release Checklist
- Update version in manifest.
- Verify permissions are accurate and minimal.
- Run manual test checklist.
- Package and validate extension.

## Troubleshooting
- No audio captured: confirm tab is playing and not muted.
- Boost not applied: check permissions and extension status.
- UI out of sync: reload extension and retry.
