# Volume Boost — documentation

| Document | Read this when… |
| --- | --- |
| [architecture.md](./architecture.md) | You want to understand how the pieces fit: background / content script / popup, the Web Audio graph, the state model, and why CORS headers get rewritten. |
| [messaging.md](./messaging.md) | You're adding or changing a feature and need the exact shape of every message between popup, background, and content script. |
| [permissions.md](./permissions.md) | You're reviewing the extension (or submitting to AMO) and need to justify each permission and its scope. |
| [development.md](./development.md) | You're setting up locally, debugging, running the manual test checklist, or cutting a release. |
| [troubleshooting.md](./troubleshooting.md) | Something isn't working and you want a symptom → cause → fix table. |
| [learnings-reference-extension.md](./learnings-reference-extension.md) | Background: notes from studying a comparable published extension that informed the design. |
| [learnings-firefox-popup.md](./learnings-firefox-popup.md) | Background: Firefox-specific popup sizing and rendering gotchas. |

The product spec is [spec.md](./spec.md) in this folder. The rules AI coding
agents follow for every extension in this repository are in the root
[`AGENTS.md`](../../AGENTS.md).
