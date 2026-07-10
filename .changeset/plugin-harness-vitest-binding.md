---
"obsidian-e2e": patch
---

Fix `createPluginHarness` so its `beforeAll`/`beforeEach`/`afterEach`/`afterAll` hooks bind to `vitest` instead of `vite-plus/test`. The harness registers these hooks inside the consumer's test files, which run under the consumer's own vitest; binding them to a different runner instance left every e2e file failing at collection with "Vitest failed to find the current suite". `vitest` is now declared as an optional peer dependency.
