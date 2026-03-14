# Framework API Consolidation Plan

## Summary

- [x] T1 Foundation API refactor
- [x] T2 Shared artifact-capture module extraction
- [x] T3 Vault content/index waiting API
- [x] T4 Plugin readiness/data waiting API
- [x] T5 Client default exec options and sleep
- [x] T6 Fixture integration cleanup
- [x] T7 Documentation and examples refresh
- [x] T8 Test suite expansion and regression coverage

Refactor the current fixture-internal conveniences into two shared subsystems:

1. A diagnostics/artifacts module for failure capture that is independent of Vitest fixtures.
2. A domain-specific waiting layer built on the existing `ObsidianClient.waitFor()` primitive, with vault- and plugin-level helpers instead of test-local polling.

## Public API Changes

- Add standalone artifact capture exports from a new shared module, not from `fixtures/`.
- Extend `VaultApi` with `waitForContent(path, predicate, options?)` and `write(path, content, options?)`.
- Extend `PluginHandle` with `reload(options?)`, `waitUntilReady(options?)`, and `waitForData(predicate, options?)`.
- Extend client creation with `defaultExecOptions`.
- Add `obsidian.sleep(ms)` as a thin shared helper over the existing wait engine.

## Dependency Graph

- `T1` Foundation API refactor: `depends_on: []`
- `T2` Shared artifact-capture module extraction: `depends_on: [T1]`
- `T3` Vault content/index waiting API: `depends_on: [T1]`
- `T4` Plugin readiness/data waiting API: `depends_on: [T1]`
- `T5` Client default exec options and sleep: `depends_on: [T1]`
- `T6` Fixture integration cleanup: `depends_on: [T2, T3, T4, T5]`
- `T7` Documentation and examples refresh: `depends_on: [T2, T3, T4, T5, T6]`
- `T8` Test suite expansion and regression coverage: `depends_on: [T2, T3, T4, T5, T6]`

## Tasks

### T1. Foundation API refactor

depends_on: []

Description:

- Introduce missing shared option/types in `src/core/types.ts` so waiting and exec behavior are modeled once.
- Keep `waitForValue()` in `src/core/wait.ts` as the only polling engine.
- Add small reusable helpers for sleep and merge-default-exec-options near the core client layer rather than inside vault/plugin code.

Acceptance Criteria:

- Shared types exist for client default exec options, waitable write options, and plugin wait/reload options.
- No duplicate polling engine is introduced.
- Reusable core helpers exist for sleep and default exec option merging.

Validation:

- `vp test tests/core/client.test.ts tests/core/wait.test.ts`

Work Log:

- Added shared core types for vault content waits, plugin readiness/data waits, and client default exec options.
- Added reusable `sleep()` and `mergeExecOptions()` helpers for higher-level APIs to share.
- Threaded the new shared types/helpers through existing core surfaces and added focused client coverage.

Files:

- `api-consolidation-plan.md`
- `src/core/client.ts`
- `src/core/exec-options.ts`
- `src/core/types.ts`
- `src/core/wait.ts`
- `src/plugin/plugin.ts`
- `src/vault/vault.ts`
- `tests/core/client.test.ts`
- `tests/helpers/stub-obsidian-client.ts`

Errors / Gotchas:

- The repo's pre-commit hook surfaced one missing type annotation on `plugin.waitForData()`, which was fixed before sealing the task.

### T2. Shared artifact-capture module extraction

depends_on: [T1]

Description:

- Split `src/fixtures/failure-artifacts.ts` into a shared non-fixture module under `src/artifacts/` that owns config normalization, directory naming, and capture execution, plus a thin fixture adapter that only hooks `onTestFailed`.
- Export the new shared capture API from `src/index.ts`.

Acceptance Criteria:

- Standalone artifact capture is available without fixture APIs.
- Fixtures call into the shared implementation instead of owning the logic.
- Artifact config and output naming remain consistent with current behavior.

Validation:

- `vp test tests/fixtures/failure-artifacts.test.ts`

Work Log:

- Extracted failure artifact config, directory naming, and capture execution into `src/artifacts/failure-artifacts.ts`.
- Collapsed fixture registration down to a thin `onTestFailed` adapter that delegates to the shared capture API.
- Added direct standalone API coverage for plugin artifact capture and moved fixture types to reuse the shared artifact option type.

Files:

- `api-consolidation-plan.md`
- `src/artifacts/failure-artifacts.ts`
- `src/fixtures/create-plugin-test.ts`
- `src/fixtures/failure-artifacts.ts`
- `src/fixtures/types.ts`
- `src/index.ts`
- `tests/fixtures/failure-artifacts.test.ts`
- `tests/helpers/stub-obsidian-client.ts`

Errors / Gotchas:

- None

### T3. Vault content/index waiting API

depends_on: [T1]

Description:

- Extend `VaultApi` with `waitForContent(path, predicate, options?)` and a write option that can wait for observable content after write.
- Implement both in `src/vault/vault.ts` as thin wrappers over `obsidian.waitFor()`.

Acceptance Criteria:

- `VaultApi.waitForContent()` exists and is implemented via shared polling.
- `VaultApi.write()` supports opt-in post-write waiting without changing default behavior.
- Timeout messaging includes the vault path context.

Validation:

- `vp test tests/vault/sandbox.test.ts`

Work Log:

- Added focused vault tests for content polling, timeout messaging, and post-write observability waits.
- Kept the vault implementation on top of `obsidian.waitFor()` with path-aware timeout messaging.
- Verified the new `waitForContent()` and `write(..., { waitForContent })` behavior with targeted tests.

Files:

- `api-consolidation-plan.md`
- `tests/vault/sandbox.test.ts`

Errors / Gotchas:

- None

### T4. Plugin readiness/data waiting API

depends_on: [T1]

Description:

- Extend `PluginHandle` with `waitUntilReady(options?)`, `waitForData(predicate, options?)`, and `reload(options?)` supporting `waitUntilReady`.
- Implement in `src/plugin/plugin.ts` on top of shared polling and observable state.

Acceptance Criteria:

- Plugin reload can wait for readiness.
- Plugin data can be polled through a first-class API.
- Implementation uses shared wait behavior and tolerates transient missing/invalid data while polling.

Validation:

- `vp test tests/core/plugin.test.ts`

Work Log:

- Strengthened plugin readiness to wait for observable command registration instead of treating enabled state alone as ready.
- Threaded reload exec options through `plugin.reload()` before optional readiness waits.
- Added plugin tests covering command-based reload readiness and resilient data polling across missing/invalid files.

Files:

- `api-consolidation-plan.md`
- `src/plugin/plugin.ts`
- `tests/core/plugin.test.ts`

Errors / Gotchas:

- None

### T5. Client default exec options and sleep

depends_on: [T1]

Description:

- Extend `CreateObsidianClientOptions` with `defaultExecOptions`.
- Apply merged defaults in `src/core/client.ts` for client, app, dev, command, and plugin flows.
- Add `obsidian.sleep(ms)`.

Acceptance Criteria:

- Default exec options apply automatically across client surfaces.
- Explicit per-call options override defaults.
- `obsidian.sleep(ms)` is available as a first-class helper.

Validation:

- `vp test tests/core/client.test.ts`

Work Log:

- Added focused client coverage for default exec options on the non-standard `verify()` path.
- Confirmed the T1 shared helpers already satisfy merged exec defaults and first-class sleep behavior.
- Reused the existing core helpers rather than adding any new client-local merge or timing logic.

Files:

- `api-consolidation-plan.md`
- `tests/core/client.test.ts`

Errors / Gotchas:

- None

### T6. Fixture integration cleanup

depends_on: [T2, T3, T4, T5]

Description:

- Update fixture code to consume the new shared APIs instead of duplicate logic.
- Keep fixture ergonomics unchanged except for transparent behavior improvements.

Acceptance Criteria:

- Fixture internals delegate to shared artifact and wait APIs.
- No duplicate capture/wait logic remains in fixtures for the new capabilities.
- Existing fixture behavior remains intact.

Validation:

- `vp test tests/fixtures/create-plugin-test.test.ts tests/fixtures/create-obsidian-test.test.ts tests/fixtures/shared-vault-lock-fixture.test.ts`

Work Log:

- Reworked plugin vault seeding to go through shared vault path resolution and `vault.write(..., { waitForContent: true })` instead of hand-rolled filesystem writes.
- Left fixture registration thin: failure capture still delegates to the shared artifact module, and fixture seeding now delegates to shared vault helpers.
- Kept fixture behavior stable while removing duplicated path and write/indexing logic from `createPluginTest()`.

Files:

- `api-consolidation-plan.md`
- `src/fixtures/create-plugin-test.ts`
- `src/vault/paths.ts`
- `src/vault/vault.ts`

Errors / Gotchas:

- None

### T7. Documentation and examples refresh

depends_on: [T2, T3, T4, T5, T6]

Description:

- Update `README.md` to document standalone artifact capture, vault content waits, plugin readiness/data waits, client default exec options, and `obsidian.sleep(ms)`.
- Replace examples that imply manual polling or fixture-only diagnostics.

Acceptance Criteria:

- README documents all new public APIs.
- Examples reflect the preferred consolidated abstractions.

Validation:

- Documentation review only

Work Log:

- Documented standalone failure artifact capture from the main package, including plugin artifact capture outside Vitest fixtures.
- Refreshed low-level client examples to show `defaultExecOptions`, `vault.write(..., { waitForContent: true })`, plugin reload readiness waits, and `obsidian.sleep(ms)`.
- Added a dedicated vault/plugin wait helper section so the preferred high-level polling APIs are documented instead of ad hoc `waitFor()` loops.

Files:

- `README.md`
- `api-consolidation-plan.md`

Errors / Gotchas:

- None

### T8. Test suite expansion and regression coverage

depends_on: [T2, T3, T4, T5, T6]

Description:

- Add coverage for standalone artifact capture, vault content waiting, plugin readiness/data waits, client default exec options, and sleep behavior.
- Keep existing fixture tests proving no regressions.

Acceptance Criteria:

- New public APIs are covered by focused tests.
- Existing regression coverage still passes.

Validation:

- `vp test`

Work Log:

- Confirmed focused coverage exists for standalone artifact capture, vault content waits, plugin readiness/data waits, and default exec option propagation.
- Ran the full project validation after the consolidation work: `vp check` and `vp test`.
- Fixed a vault-lock subprocess compatibility regression by keeping its timer helper local; the rest of the consolidation remains intact and the full suite now passes.

Files:

- `api-consolidation-plan.md`
- `src/fixtures/vault-lock.ts`

Errors / Gotchas:

- `tests/fixtures/vault-lock.test.ts` exercises `src/fixtures/vault-lock.ts` through a direct child-process import path, which is incompatible with the shared `src/core/wait.ts` module's current extensionless internal imports. Keeping the vault-lock timer helper local avoids breaking that path.
