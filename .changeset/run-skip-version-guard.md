---
"obsidian-e2e": patch
---

Accept `--skip-version-guard` on `obsidian-e2e run`. The flag was documented as a
bypass for `run` (which applies the same `minAppVersion` / mid-session update
guard as `start` during bring-up), but it was never registered on the `run`
argument spec, so `run --skip-version-guard` failed with `Unknown option` before
the command could execute. It is now a real escape hatch, matching `start`.
