---
"obsidian-e2e": minor
---

Add the worktree-isolated instance runner: a new `obsidian-e2e` bin
(`provision|start|stop|run`) and an `obsidian-e2e/runner` programmatic export,
configured per repo via an `obsidian-e2e.config.mjs`.

The runner stands up an isolated Obsidian instance per git worktree - its own
vault, private `HOME`, and app process - so parallel checkouts never collide and
a run never touches another plugin's instance. It folds in the app-version guard
(refuse to run below `minAppVersion`, hard-fail reuse on a mid-session update),
secure `/tmp` profile handling (fail closed on symlinked or foreign-owned roots),
socket-gated readiness probing, reuse-and-reload of a warm instance, and an
orphan reaper keyed on the worktree being gone. `--print-env` emits canonical
`OBSIDIAN_E2E_*` exports (plus legacy `<PREFIX>_E2E_*` aliases when `envPrefix`
is set) on stdout only, keeping `eval "$(...)"` safe.
