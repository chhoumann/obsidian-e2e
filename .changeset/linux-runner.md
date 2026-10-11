---
"obsidian-e2e": minor
---

The instance runner now works on Linux, including headless hosts, so consumers
can drop their Linux shims.

- On Linux, `start` and `run` launch the Obsidian executable directly
  (`appName`, default `/opt/Obsidian/obsidian`), wrapped in `xvfb-run` when
  there is no `$DISPLAY`. App output goes to `obsidian.log` in the instance
  directory.
- Each instance keeps its CLI socket private. Linux Obsidian puts the socket in
  `$XDG_RUNTIME_DIR`, so the runner, `resolveObsidianEnvOptions`, and the
  forwarded `run` command point it at the private `HOME` in each process they
  start. The `start --print-env` output is unchanged, so evaluating it never
  changes `XDG_RUNTIME_DIR` in your shell.
- On Linux, `start` and `run` fail before launching when the CLI socket path is
  longer than the 107 bytes Linux allows, and suggest a shorter `profileRoot` or
  vault name. Before, Obsidian could not listen and the runner timed out.
- The version guard finds Linux installs: cached asars in
  `${XDG_CONFIG_HOME:-~/.config}/obsidian` and the installer asar in
  `resources/` next to the executable, following symlinks.
- `obsidian-e2e/runner` now exports `guardWarmInstance`.
