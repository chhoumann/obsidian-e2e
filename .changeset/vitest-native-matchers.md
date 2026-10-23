---
"obsidian-e2e": minor
---

Drop the `vite-plus` peer dependency so consumers no longer install vulnerable `vite-plus` 0.1.x. `obsidian-e2e/matchers` now extends the `expect` from `vitest`, the same runner the `obsidian-e2e/vitest` fixtures already bind to, so the matchers also work in plain Vitest projects. Its typings target Vitest 5. With Vite+ 1.1 or later, `vite-plus/test` re-exports Vitest, so `expect` from either module has the matchers. Vite+ 0.1.x projects should upgrade to Vite+ 1.1 or later. The `yaml` dependency now requires 2.8.3 or later.
