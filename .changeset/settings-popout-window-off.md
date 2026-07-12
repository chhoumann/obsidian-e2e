---
"obsidian-e2e": patch
---

Provisioned vaults now enforce harness-invariant `app.json` keys on every provision (other keys are preserved, so existing vaults are corrected on their next run):

- `settingsPopoutWindow: false` - Obsidian 1.13+ defaults to opening Settings in a separate popout window, outside the main window the harness drives.
- `spellcheck: false` - OS-dictionary squiggles added per-machine variance to screenshots and failure artifacts.
- `trashOption: "local"` - the "system" default leaked UI-driven test deletions into the OS trash instead of the disposable vault's `.trash`.
