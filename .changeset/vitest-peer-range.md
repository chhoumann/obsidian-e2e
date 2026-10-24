---
"obsidian-e2e": minor
---

The optional `vitest` peer range is now `^5.0.0` (was `>=3`). The matcher typings already targeted Vitest 5: under Vitest 4 they turn `expect(...)` into an untyped assertion. Failure-artifact capture now reads suite hooks through `TestRunner.getSuiteHooks`, and the `vitest/suite` fallback for Vitest before 4.1 is gone.
