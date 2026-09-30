---
"obsidian-e2e": patch
---

Support Vitest 5. `obsidian-e2e/vitest` imported `getFn`/`setFn` from
`vitest/suite`, which Vitest 5 removed, so loading it failed with
`Package subpath './suite' is not defined by "exports"`. Failure capture now
adds its hook through `TestRunner.getSuiteHooks` (Vitest 4.1+, falling back to
`vitest/suite` before 4.1) and still runs as soon as the test body fails,
before your `afterEach` hooks, fixture teardown and `onTestFinished`.
