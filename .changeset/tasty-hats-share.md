---
"obsidian-e2e": minor
---

Export vault lock helpers and related types from the main `obsidian-e2e`
entry point so manual `beforeAll` / `afterAll` lifecycle setups can acquire,
inspect, and release shared-vault locks without importing
`obsidian-e2e/vitest`.
