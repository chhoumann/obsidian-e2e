# obsidian-e2e Instance Runner Plan

## Goal

Absorb the worktree-isolated Obsidian instance orchestration that quickadd, podnotes, and metaedit each vendor as four diverged `scripts/*-e2e-*.mjs` copies (~1,400-1,900 lines per repo plus unit tests) into this package, as:

- a bin: `obsidian-e2e <provision|start|stop|run> [flags] [-- <obsidian command>]`
- a programmatic subpath export: `obsidian-e2e/runner`
- a per-repo config file: `obsidian-e2e.config.mjs` at the worktree root

Consumers keep their existing npm script names (`provision:e2e-vault`, `start:e2e-obsidian`, `stop:e2e-obsidian`, `obsidian:e2e`) pointing at the bin, so AGENTS.md playbooks and the global `verify-in-obsidian` skill keep working unchanged.

## Inputs

Four reconciliation reports (in `.reconciliation/`, untracked) analyzed every divergence across the three repos and judged winners. The merge is union-of-best:

| Adopt                                                                                                                   | From              | Why                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| Worktree-anchored default vault root                                                                                    | podnotes/metaedit | quickadd anchors to cwd - real isolation bug                            |
| `--print-env` summary to stderr, stdout export-only                                                                     | podnotes/metaedit | quickadd pollutes stdout, breaks `eval "$(...)"`                        |
| Provision = pure filesystem, no `obsidian` CLI                                                                          | podnotes/metaedit | single responsibility; quickadd's trust/verify moves to the launcher    |
| Socket-gated readiness probe (`cliSocketExists` before CLI probe)                                                       | podnotes/metaedit | quickadd's cold probe can auto-launch a competing instance              |
| Reuse warm instance + `plugin:reload` before verify                                                                     | podnotes/metaedit | quickadd's warm reuse serves a stale bundle after rebuild               |
| Keychain symlink self-reference guard                                                                                   | podnotes/metaedit | quickadd breaks its own keychain link when HOME is already the profile  |
| `OBSIDIAN_BIN` propagation when non-default                                                                             | podnotes/metaedit | harnesses read `OBSIDIAN_BIN ?? "obsidian"`                             |
| `pidAlive`: EPERM alive, ESRCH dead, else throw                                                                         | podnotes          | quickadd/metaedit treat unknown errors as dead and delete live profiles |
| Guarded JSON reads (`isRecord` on marker/registry)                                                                      | podnotes          | strictly safer, tested                                                  |
| Typed arg parsing, shared error helpers                                                                                 | podnotes          | merged into real TS                                                     |
| asar/minAppVersion guard (pickle parser, bundled-asar floor, sandbox seeding)                                           | quickadd          | prevents silently testing against an older app build                    |
| App-version-stamped instance marker, preserved across re-prepares                                                       | quickadd          | detects mid-session Obsidian updates; hard-fail reuse on version change |
| TOCTOU/temp-squat hardening (`ensureSecureDir`, `assertOwnedDir`, `assertSecureDirIfPresent`) in start, stop, reap, run | quickadd          | /tmp profile roots are attack surface; fail closed                      |
| `userDataPath` set once inside profile prep                                                                             | quickadd/metaedit | podnotes forgot the reassignment                                        |
| Four-guard instance-path safety + exact `--user-data-dir=<path>/` matching + descendant walk                            | all three         | keep verbatim                                                           |

Fixes for bugs present in all three copies:

- Guarantee at least one post-SIGTERM liveness recheck before SIGKILL (grace loop can currently skip straight to SIGKILL with a tiny graceMs).
- Drop the dead `pid`/`pidPath` fields from launch results (always null, summary guard is dead code).
- Make bare `--` a real end-of-options terminator in arg parsing.

## Package shape

Same package (no monorepo split): the runner shares the package's domain, audience, and release cadence, and adds zero runtime dependencies (node stdlib only).

- `package.json`: add `"bin": { "obsidian-e2e": "./dist/runner/cli.mjs" }` and a `"./runner"` export.
- New `src/runner/` modules:
  - `types.ts` - `RunnerConfig`, `InstanceOptions`, `ProvisionOptions/Result`, `ProfileResult`, `StopOptions/Result`, `ReapOptions/Result`, `ProcessInfo`, dependency-injection types (from podnotes' `obsidian-e2e-types.d.ts`, promoted to real interfaces)
  - `config.ts` - config discovery (`obsidian-e2e.config.mjs` at worktree root via dynamic import), validation, resolution precedence: CLI flag > env > config > default
  - `args.ts` - shared parse machinery (value/boolean option sets, typed option-key mapping, `--` terminator, throw-on-unknown)
  - `fs-utils.ts` - `pathExists` (lstat), atomic `writeJson`/`writeJsonIfMissing` (0o600, refuses symlink/non-file), `slugify`/`safeName`, `shellQuote`, shell-export emission
  - `security.ts` - `resolveCurrentUid`, `assertOwnedDir`, `ensureSecureDir`, `assertSecureDirIfPresent`
  - `provision.ts` - `resolveProvisionOptions`, `provisionVault`, `linkPluginFile`
  - `instance.ts` - `resolveInstanceOptions`, `stableInstanceId`, `stableVaultId`, marker read/write/stamp (appVersion-preserving), `prepareObsidianProfile`, `linkHostKeychains`
  - `version-guard.ts` - `readAsarPackageVersion` (pickle parser), `resolveObsidianAppVersion`, `compareObsidianVersions`, `readPluginMinAppVersion`, `assertObsidianMeetsMinAppVersion`, `reconcileSandboxAppAsar`, `bundledAsarCandidates`, `macObsidianConfigDir`
  - `launch.ts` - `launchObsidianInstance`, `cliSocketExists`, `isInstanceReady` (socket-gated), `waitForInstanceReady`, `reloadPlugin`, `trustVaultAndVerifyPlugin` (readyProbe-driven)
  - `stop.ts` - `parsePsOutput`, `commandMatchesInstance`, `collectInstancePids`, `assertSafeInstancePath`, `stopInstance`, `readInstanceVaultPaths`, `readInstanceMarker`, `isInstanceOrphaned`, `reapOrphanedInstances`
  - `ensure.ts` - `ensureObsidianInstance` composition (marker-before-prepare, provision, prepare, version guard, socket-gated ready check, version-mismatch throw / unmarked warn, reload-before-verify vs launch+wait+stamp, verify)
  - `cli.ts` - bin entrypoint with the four subcommands, per-subcommand help, summary-to-stderr discipline under `--print-env`/`--json`
- Fold podnotes' `errorHasCode`/`isRecord`/`commandErrorMessage` into the existing `src/core/errors.ts` (dedupe with what is already there).
- Tests in `tests/runner/*.test.ts`.

## Config schema

```ts
interface RunnerConfig {
  pluginId: string; // required; drives plugin dir, community-plugins, reload id, ready eval
  vaultPrefix?: string; // default: pluginId
  pluginArtifacts?: string[]; // default ["manifest.json", "main.js"]; repos with real styles.css add it
  defaultData?: unknown; // data.json seed; default {}
  buildCommand?: string; // used in "build first" error text; default "npm run build"
  defaultCommand?: string[]; // `run` subcommand default; default ["eval", "code=app.vault.getName()"]
  readyProbe?: // default { kind: "eval", code: `Boolean(app.plugins.plugins["<id>"])`, match: "=> true" }
    | { kind: "eval"; code: string; match: string }
    | { kind: "command"; args: string[]; match: string };
  envPrefix?: string; // e.g. "QUICKADD" - emits legacy <PREFIX>_E2E_* aliases during migration
  profileRoot?: string; // default `/tmp/<pluginId>-obsidian-e2e`
  appName?: string; // default "Obsidian"
  obsidianBin?: string; // default "obsidian"
}
```

Data seeds stay mirrored constants in each consumer's config; each consumer keeps its drift test comparing the seed against the plugin's real `DEFAULT_SETTINGS` (vitest can import both).

## CLI surface

Shared flags: `--vault --root --worktree --data --profile-root --obsidian-app --obsidian-bin --config` (value), `--force --json --help` (boolean).

- `provision`: + `--print-env`
- `start`: + `--print-env --no-launch --skip-version-guard`
- `stop`: + `--dry-run --prune`
- `run`: forwards everything after the first non-option token (or after `--`) as the `obsidian` command; default from config.

## Env contract

Canonical emissions (`--print-env`): `OBSIDIAN_E2E_VAULT`, `OBSIDIAN_E2E_VAULT_PATH`, `OBSIDIAN_E2E_OBSIDIAN_HOME`, plus `OBSIDIAN_BIN` only when non-default. When `envPrefix` is configured, additionally emit legacy `<PREFIX>_E2E_VAULT`, `<PREFIX>_E2E_VAULT_PATH`, `<PREFIX>_E2E_OBSIDIAN_HOME` aliases. Legacy aliases are removed only after all three consumer harnesses migrate to the canonical names.

## Task graph

- [ ] `R1` Foundation: types, errors fold-in, args, fs-utils, security, config loader (+ tests)
- [ ] `R2` provision.ts port (+ parameterized tests incl. root-anchoring regressions, print-env hygiene, linkPluginFile reconcile paths) - depends_on: [R1]
- [ ] `R3` instance.ts + version-guard.ts + launch.ts port (+ quickadd's gold-standard tests, socket-gating tests, keychain self-ref test) - depends_on: [R1]
- [ ] `R4` stop.ts port (+ podnotes' suite, secure-root integration tests, grace-recheck test) - depends_on: [R1]
- [ ] `R5` ensure.ts + cli.ts + bin/export wiring (+ orchestration table-tests, spawn signal re-raise, env alias emission) - depends_on: [R2, R3, R4]
- [ ] `R6` README runner section + changeset (minor) + `vp check` + `vp test` + `vp pack` green - depends_on: [R5]
- [ ] `R7` Real-world validation: migrate metaedit in place on a branch, run `test:e2e` against a live isolated instance - depends_on: [R6]

## Verification

Unit: `vp test` (ported parameterized suites + the gap tests named in the reports). Real-world: R7 runs the actual metaedit e2e suite through the bin on this machine - launching and reaping a real isolated Obsidian instance - before the first consumer PR is opened.

## Work log

- Branch `feat/instance-runner` created; reconciliation reports saved under `.reconciliation/` (untracked).
