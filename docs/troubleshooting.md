# Troubleshooting

Symptoms first, then likely causes and how to confirm each.

## Boost is on but nothing sounds louder

**The tab is muted, or the page's own volume is at zero.**
Boost multiplies whatever the page outputs. Check the tab's mute icon and the
player's volume control.

**Media is cross-origin and the CORS header injection isn't reaching it.**
Web Audio outputs silence for tainted media — but in that case you'd hear
*nothing*, not just "no louder". If you hear normal-volume audio, this isn't
the cause. If you hear silence, see the next section.

**The media element couldn't be attached.**
Open the popup: if the status line says *"Media on this page could not be
boosted"*, every element on the page threw on
`createMediaElementSource`. The usual reason is that the page's player already
routes the element through its own `AudioContext` — an element can only belong
to one. There is no fix from our side; the page's player owns the audio.

**The media element hasn't been found yet.**
The scan runs every second. If the player creates the `<video>` after boost
was enabled it will be picked up on the next tick. If it's inside a
closed shadow root, `querySelectorAll` can't see it — this is a known gap.

**Boost got disabled because you switched tabs.**
Only the active tab is boosted. Switching away and back turns it off; reopen
the popup and toggle it on again.

## Audio goes silent when boost is enabled

This is the signature of Web Audio's same-origin taint: the element was
connected to the graph but its bytes were loaded without CORS approval.

1. Open devtools → Network, filter by **Media**, reload the media (seek or
   reload the page with boost still on).
2. Look at a media response. Is `Access-Control-Allow-Origin: *` present?
   - **No** → the background's `webRequest` listener isn't firing for this
     tab. In the background inspector check `[...corsTabs]` includes the tab
     ID and `browser.webRequest.onHeadersReceived.hasListener(injectCorsHeaders)`
     is `true`. If the request type isn't `media` (some players fetch via
     XHR/fetch and feed MSE), the filter deliberately won't touch it — but MSE
     sources are `blob:` and same-origin, so they shouldn't taint either.
   - **Yes** → check the request has `crossorigin="anonymous"` on the element
     (`document.querySelector("video").crossOrigin`). If it's `null` the
     content script decided the source was same-origin; verify with
     `new URL(el.currentSrc).origin === location.origin`.
3. If the header is present and the element is CORS-mode but audio is still
   silent, the element may have been attached *before* the CORS reload
   completed. Toggle boost off and on, or reload the page.

**The server rejects CORS-mode requests outright.** Some servers 403 any
request carrying an `Origin` header. The header injection can't help there;
the media will fail to load at all in CORS mode. Turning boost off and
reloading the page restores normal playback.

## Video restarts or jumps when enabling boost

Expected on first enable for cross-origin media: the element is reloaded with
`crossorigin="anonymous"`, and the content script restores `currentTime` and
play state on `loadedmetadata`. A brief stutter is normal. If it restarts from
0 every time, the seek is failing — check the console for errors; some
streaming players reject external `currentTime` writes.

## Popup shows an error instead of "Boost On"

| Status text | Meaning |
| --- | --- |
| `Tab is not active` | The popup was opened, the user switched tabs (e.g. via keyboard) before toggling. Close and reopen the popup on the tab you want. |
| `Could not establish connection. Receiving end does not exist.` | No content script in this tab. Restricted page (`about:*`, `moz-extension:*`, AMO, PDF viewer, reader view), or the extension was just installed/reloaded and the page hasn't been reloaded since. Reload the page. |
| `Media on this page could not be boosted` | Boost *is* on, but no media element could be attached. See above. |
| `Max must be 1% or higher` | The max-boost prompt got a non-number or a value below 1. |

## Boost doesn't come back after reload

`tabs.onUpdated` re-applies boost when the boosted tab reaches
`status: "complete"`. If it doesn't:

- Confirm the tab is still `state.enabledTabId` in the background inspector.
  Switching tabs during the reload would have cleared it.
- Some pages fire `complete` before their player has created any media
  element. Boost is applied (gain set, scanning started) and the element is
  attached on a later scan tick — give it a second.

## Settings didn't persist

- Saves are debounced 200 ms. Closing Firefox within that window after the
  last change can lose it. Rare in practice.
- Temporary add-ons (loaded via `about:debugging`) get a fresh storage area on
  every Firefox restart. Use `web-ext run --keep-profile-changes` with a named
  profile, or a signed install, to test persistence.
- Check `about:debugging` → Inspect → Storage → Extension Storage to see what's
  actually stored.

## Popup renders wrong (cut off, blank, scrollbars)

Firefox sizes browser-action popups from the document's layout, and gets it
wrong if the body isn't explicitly sized. `popup.css` sets fixed
`width`/`height` on `body` and `overflow: hidden`. If you've edited the CSS and
the popup is misbehaving, that's the first place to look. Details in
[learnings-firefox-popup.md](./learnings-firefox-popup.md).

## Distortion at high boost

The limiter (12:1 above −6 dB) keeps things listenable up to a few hundred
percent. Beyond ~1000% you're asking a compressor to absorb 20 dB of gain and it
will pump and crunch. The popup warns at 1000%. If you need that much boost,
the source is probably broken (badly mastered, wrong channel) and a lower value
plus system volume will sound better.

## Extension works in one tab but not after opening a second instance of the same site

Only one tab is boosted at a time, by design. Per-site memory stores the
*level* per origin, not the *enabled* state — you still have to toggle boost on
in each tab.

## Reporting a bug

Include:

- Firefox version and OS.
- The page URL (or a description if private) and whether the media is
  same-origin, cross-origin, or an embedded iframe player.
- The popup status text.
- Output of `state` and `[...corsTabs]` from the background inspector.
- Any errors in the background inspector console and the page console.
