---
"obsidian-e2e": patch
---

A lost CLI reply now starts recovery after an in-app grace of about 1.5s and
a 2.5s attempt budget, instead of a 5s process kill. Slow commands reply
`{state:'pending'}` so the CLI socket is not held and then killed. Recovery
polls start at once, then back off from 100ms to 1s.

This is the first slice of #28. `evalJsonAsync` stays its own protocol.
