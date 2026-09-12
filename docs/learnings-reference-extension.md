## Learnings From 600_sound_volume-2.0.4.xpi_FILES
- They avoid `tabCapture` and instead boost audio by injecting a content script that targets `<audio>`/`<video>` elements.
- The content script creates Web Audio nodes (`AudioContext`, `MediaElementSource`, `GainNode`) and applies gain based on a global percent value.
- A periodic scan (every ~200ms) ensures newly added media elements are attached and boosted.
- Elements are set to `crossorigin="anonymous"` to improve compatibility with Web Audio processing.
- The background/popup uses `tabs.sendMessage` to tell the content script to change volume and to query the current value.
- They add `webRequest`/`webRequestBlocking` rules to inject `Access-Control-Allow-Origin: *` on media responses, reducing CORS issues for Web Audio routing.
- UI shows current percent and can drive volume changes without needing direct audio capture permissions.
