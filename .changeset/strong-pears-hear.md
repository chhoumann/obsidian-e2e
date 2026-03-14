---
"obsidian-e2e": minor
---

Add experimental shared-vault locking for `createObsidianTest()` and
`createPluginTest()` so separate runs can serialize access to one live Obsidian
dev vault. This release also adds lock diagnostics and real multi-process smoke
coverage for both the raw lock manager and the fixture layer.
