---
"obsidian-e2e": minor
---

`obsidian-e2e run` now attaches to a warm instance that already serves the
vault. It no longer reloads the plugin, turns off Restricted Mode, or runs the
ready probe before every forwarded command. The read-only version guard still
runs, so an Obsidian update mid-session still fails closed. Plugin and UI state
now survive between separate commands, and a disabled plugin stays disabled. Pass
`run --reload` or use `start` to redeploy a rebuilt plugin. If no instance is
running, `run` still launches and verifies one.

`run dev:mobile on|off` now waits until the reloaded renderer reports the new
mode with its layout ready, so the next command does not race the reload.

`start`, and a `run` that launches an instance, no longer return while
Obsidian is still reloading after Restricted Mode is turned off. Before, the
ready probe could pass on the renderer that was about to reload, so the next
command could get `Command "eval" not found`.
