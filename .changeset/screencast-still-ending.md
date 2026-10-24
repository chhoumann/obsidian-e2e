---
"obsidian-e2e": patch
---

`capture record` with the `screencast` backend no longer rejects a take that ends on a still screen. The encoder used to hold the last frame for about twice its on-screen time, so the video ran past the recorded wall-clock time and failed the duration check. The encoded video now ends at the stop time.
