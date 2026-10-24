# Troubleshooting

Symptoms first, then likely causes and how to confirm each.

## Boost is on but nothing sounds louder

**The level is only a little above 100%.**
Loudness is heard in decibels: 120% is +1.6 dB, which is hard to notice;
150% is +3.5 dB, 200% +6 dB (clearly louder), 300% about +9 dB. Try 200%
before concluding it doesn't work.

**The tab is muted, or the page's own volume is at zero.**
Boost multiplies whatever the page outputs. Check the tab's mute icon and the
player's volume control.

**Media is cross-origin and the CORS header injection isn't reaching it.**
Web Audio outputs silence for tainted media — but in that case you'd hear
*nothing*, not just "no louder". If you hear normal-volume audio, this isn't
the cause. If you hear silence, see the next section.

**The media element couldn't be attached.**
Open the popup: if the status line says *"Media on this page could not be
boosted"*, every element on the page and its embedded frames threw on
`createMediaElementSource`. There is no fix from our side; the browser console
has a `[volume-boost]` warning with the reason.

**The page's own player also routes the element through Web Audio.**
Firefox lets one element feed several `AudioContext`s, so the page's copy of
the sound keeps playing at its own level and the boost only changes Volume
Boost's copy: the volume changes less than the slider says. Volume Boost
can't reach the page's context.

**A page left over from before Volume Boost was restarted.**
After Volume Boost is reloaded or updated, it takes over media that its earlier
copy was boosting, at 100%. If a page still behaves oddly, reload the page.

**The media element hasn't been found.**
If the status line says *"On — waiting for audio or video"*, no frame of the page
has a media element with a source. A player that adds its `<video>` later, or
gives it a source later, is picked up as soon as it does. Two cases are never
found: media the page plays without adding it to the document, and elements
inside a shadow root.

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
   - **Yes** → check the element is in CORS mode
     (`document.querySelector("video").crossOrigin` is `"anonymous"`). If it's
     `null` the content script decided the source was same-origin; verify with
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
0 every time, the seek is failing — the page console shows a
`[volume-boost] could not restore the playback position` warning; some
streaming players reject external `currentTime` writes.

## What the popup's status line means

| Status text | Meaning |
| --- | --- |
| `Off for this tab` | This tab is not boosted. |
| `Boosting this tab` | This tab is boosted and at least one media element is routed through the boost. |
| `On — waiting for audio or video` | This tab is boosted, but no frame has media with a source yet. It changes to `Boosting this tab` when media appears. |
| `On — this page's media can't be boosted` | Boost *is* on, but every media element refused to attach. See above. |
| `Can't boost this page. Try reloading it.` | No content script answered in this tab: Firefox's own pages (`about:`, `moz-extension:`…), addons.mozilla.org and the PDF viewer refuse them; a page still loading may not have one yet. |
| `Max must be between 1% and 1000%` | The Max field got a non-number or a value outside 1–1000. |

## Boost doesn't come back after reload

A boosted tab stays boosted through reloads: each frame asks the background
when it loads, and the tab is re-applied when it finishes loading. If it
doesn't come back:

- In the background inspector, check `boostedTabs.has(<tab id>)`. Closing the
  tab, or turning boost off, removes it.
- Some pages load their player after `complete`; the content script attaches
  it when it appears, so give it a second.

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
`width`/`height` on `body` and `overflow: hidden`, and the `.app` grid's single
`minmax(0, 1fr)` column keeps a long tab title from widening the popup. If
you've edited the CSS and the popup is misbehaving, that's the first place to
look. Details in [architecture.md](./architecture.md#popup).

## Distortion at high boost

The soft limiter only touches peaks, so up to about 200% it is hard to hear
on most audio. From about 300% (where the popup warns) more and more of the
sound is being rounded off and it starts to crunch; at 600% and above it is
heavily distorted. If you need much more, the
source is probably broken (badly mastered, wrong channel) and a lower value
plus system volume will sound better.

## Two tabs, two levels

Each tab has its own switch and its own level, shown on the toolbar icon while
that tab is selected. Per-site memory stores the *level* per origin, not
whether boost is on — you still turn boost on in each tab.

## Reporting a bug

Include:

- Firefox version and OS.
- The page URL (or a description if private) and whether the media is
  same-origin, cross-origin, or an embedded iframe player.
- The popup status text.
- Output of `state`, `[...boostedTabs]`, `[...corsTabs]` and
  `[...mediaCounts].map(([tab, frames]) => [tab, [...frames]])` from the
  background inspector.
- Any `[volume-boost]` warnings in the background inspector console and the
  page console.
