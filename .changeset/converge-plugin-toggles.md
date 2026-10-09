---
"obsidian-e2e": patch
---

A lost Obsidian CLI reply no longer leaves the plugin under test disabled for
the rest of the run, and no CLI client outlives its test worker.

- `plugin.enable()` and `plugin.disable()` read the plugin's enabled flag back
  instead of trusting the reply. A toggle whose reply was lost resolves once the
  flag matches, and a toggle whose request was lost is sent once more. When
  Obsidian answers but the flag does not change, they now throw
  `ObsidianCommandError` instead of resolving silently.
- `plugin.reload()` enables a disabled plugin. Obsidian answers a reload of a
  disabled plugin with `Error: Plugin "<id>" is not enabled.` on exit code 0,
  which used to pass as success. Any other `Error:` reply to a reload (for
  example `Failed to reload`) now throws `ObsidianCommandError`.
- `createPluginHarness()` leaves the plugin enabled after the suite, even when
  it found the plugin disabled, and every data restore re-enables the plugin
  and waits until it is ready, even when the restore fails. `afterEach` now uses
  `teardownTimeoutMs`, whose default rises from 30 to 90 seconds.
- A CLI client still waiting for its reply is killed when Vitest stops the test
  worker with SIGTERM. It used to keep running after the worker exited.
- A CLI client killed by a signal now fails with exit code `128 + signal`
  (`ObsidianCommandError`) instead of resolving as a successful empty reply.
