---
"obsidian-e2e": patch
---

Provisioned vaults now force `settingsPopoutWindow: false` in `app.json`, so Obsidian 1.13+ opens Settings embedded in the main window instead of the new default popout window. The flag is re-applied on every provision (other keys are preserved), so vaults provisioned before this release are corrected on their next run.
