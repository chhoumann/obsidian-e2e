---
"obsidian-e2e": minor
---

Add the `android` runner family (`obsidian-e2e android <start|stop|run>`): run
the plugin inside the real Obsidian Android app on an emulator, driven over the
webview devtools socket (CDP). `start` boots or reuses the configured AVD,
installs the official APK when needed, provisions and selects the vault (folder

- `mobile-selected-vault`, no first-run UI automation), pushes the plugin
  artifacts, seeds `data.json` on first provision, enables the plugin, and runs
  the ready probe; `run` evaluates `eval code=<js>` over CDP; `stop` shuts the
  emulator down. Configured by a new optional `android` block in
  `obsidian-e2e.config.mjs` (only `avd` is required).
