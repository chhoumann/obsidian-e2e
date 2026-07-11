---
"obsidian-e2e": patch
---

Three consumer-reported fixes:

- `evalJson`/`evalJsonAsync` now wrap their JSON result envelope in per-call
  nonce sentinel markers, so plugin console output emitted on the shared eval
  channel (e.g. `QuickAdd: ...`/`MetaEdit: ...` notices during the exercised
  operation) can no longer corrupt the parsed result (#18). Window-global
  polling workarounds in consumer suites are no longer needed.
- Teardown now cleans the sandbox while the vault lock is still held, then
  clears the in-app ownership marker, and only then releases the lock, so a
  waiting run can never acquire the vault mid-cleanup; marker-clear failures
  fail the suite (with a warning) instead of being silently swallowed, and the
  marker is only touched when a shared vault lock is actually in play (#19).
- `createPluginTest`/`createObsidianTest` (and the fixture type surface) now
  bind to `vitest` instead of `vite-plus/test`, matching the
  `createPluginHarness` fix from #14, so consumers running under real Vitest
  get fixtures registered on their own runner; the dist guard asserts the
  built `vitest` entry externalizes `vitest` and carries no `vite-plus/test`
  binding (#17).
