# Obsidian-Aware Test API Refactor

## Summary

- [ ] T1 App Harness + Structured Eval
- [ ] T2 Metadata Cache Service
- [x] T3 Note Model + YAML Serializer
- [ ] T4 Sandbox Note/Frontmatter API
- [ ] T5 Plugin Data Ergonomics
- [ ] T6 Public Test Context
- [ ] T7 Obsidian Waits + Matchers
- [ ] T8 Failure Artifact Expansion
- [ ] T9 Fixture Refactor + Seed Support
- [ ] T10 Docs + Migration + Regression Matrix

Build these features around one shared foundation instead of adding more ad hoc
`dev.eval(...)` calls and fixture-local polling.

- Keep `VaultApi` generic and filesystem-only.
- Add Obsidian-aware metadata and diagnostics through a versioned in-app
  harness.
- Add note/frontmatter ergonomics on `sandbox`, not on raw `vault`.
- Replace repetitive teardown logic with a public context/lifecycle API that
  fixtures reuse.
- Prefer a maintainable cleanup even if that means focused public API reshaping
  in a pre-v1 package.

## Public API Changes

- `obsidian.dev.eval<T>()` becomes a structured, JSON-enveloped API with
  deterministic serialization and remote stack reporting.
- Add `obsidian.dev.evalRaw()` as the explicit escape hatch for unstructured
  behavior.
- Add `obsidian.metadata` helpers for file-cache and frontmatter access/waits.
- Extend `sandbox` with note-model helpers:
  - `readNote(path) -> { frontmatter, body, raw }`
  - `writeNote({ path, frontmatter, body, waitForMetadata? })`
  - `frontmatter(path)`
  - `waitForFrontmatter(path, predicate, options?)`
  - `waitForMetadata(path, predicate?, options?)`
- Extend `plugin` with:
  - `updateDataAndReload(patchFn, options?)`
  - `withPatchedData(patchFn, run, options?)`
- Add public lifecycle wrappers:
  - `createTestContext(options)`
  - `withVaultSandbox(options, run)`
- Add matcher-style note assertions instead of imperative
  `sandbox.expectNote(...)`:
  - `toHaveFrontmatter(path, expected)`
  - `toHaveNote(path, { frontmatter?, body?, bodyIncludes? })`
- Extend failure-artifact options to cover note content, parsed frontmatter,
  console logs, runtime errors, notices, and workspace state.
- Extend `VaultSeedEntry` to support note descriptors so seeded notes can reuse
  the same serializer as `sandbox.writeNote`.

## Dependency Graph

- `T1` depends_on: []
- `T2` depends_on: [T1]
- `T3` depends_on: []
- `T4` depends_on: [T2, T3]
- `T5` depends_on: []
- `T6` depends_on: [T2, T4, T5]
- `T7` depends_on: [T1, T2, T4]
- `T8` depends_on: [T1, T2, T4]
- `T9` depends_on: [T4, T5, T6, T8]
- `T10` depends_on: [T7, T8, T9]

## Task Details

### T1. App Harness + Structured Eval

depends_on: []

- Introduce a versioned in-app harness under a dedicated
  `window.__obsidianE2E` namespace, separate from the existing lock marker.
- Route internal Obsidian queries through harness functions instead of
  scattering raw `dev.eval(...)` snippets across the codebase.
- Redefine `dev.eval<T>()` to return a structured envelope `{ ok, value } | {
ok, error }`, with JSON-only serialization, stable array/object behavior, and
  remote stack traces.
- Add `dev.evalRaw()` for the true escape-hatch path so the typed API can stay
  strict.

Acceptance Criteria:

- Shared in-app harness exists and is reused for internal eval-backed helpers.
- `dev.eval<T>()` preserves arrays/objects deterministically and raises useful
  remote errors.
- `dev.evalRaw()` exposes the low-level unstructured path.

Validation:

- `vp test tests/core/client.test.ts`

### T2. Metadata Cache Service

depends_on: [T1]

- Add a shared metadata service that reads `app.metadataCache` through the
  harness and exposes file-cache, frontmatter, and cache-state queries.
- Implement `waitForFileCache` and `waitForMetadata` by polling semantic app
  state, not raw file existence.
- Distinguish clearly between “file exists on disk”, “file cache exists”, and
  “frontmatter parsed”.
- Use vault-relative paths consistently and return `null` for missing cache
  rather than conflating it with parse failures.

Acceptance Criteria:

- `obsidian.metadata` provides file-cache/frontmatter reads and wait helpers.
- The implementation uses the shared harness instead of inline eval snippets.
- Missing metadata returns `null`, while wait helpers poll until a predicate
  passes.

Validation:

- `vp test tests/core/client.test.ts`

### T3. Note Model + YAML Serializer

depends_on: []

- Add a pure note-document module that parses and serializes
  `{ frontmatter, body, raw }`.
- Use a real YAML library for frontmatter serialization/parsing rather than
  hand-built string concatenation.
- Normalize newline handling and preserve empty-body / no-frontmatter cases.
- Keep this module Obsidian-independent so it can power note helpers, seed
  data, and failure artifacts uniformly.

Acceptance Criteria:

- Shared note parse/stringify utilities exist and cover frontmatter/body/raw.
- Serialization uses the YAML dependency consistently.
- No Obsidian client access exists in the note-model module.

Validation:

- `vp test tests/note/document.test.ts`

### T4. Sandbox Note/Frontmatter API

depends_on: [T2, T3]

- Extend `sandbox` with `readNote`, `writeNote`, `frontmatter`,
  `waitForFrontmatter`, and `waitForMetadata`.
- Define `readNote().frontmatter` as file-derived frontmatter from the note
  model; define `sandbox.frontmatter()` as the Obsidian metadata-cache view.
- Make `sandbox.writeNote()` wait for metadata by default; keep raw
  `sandbox.write()` unchanged and low-level.
- Do not add imperative `sandbox.expectNote(...)`; keep assertions in matchers.

Acceptance Criteria:

- Sandbox note helpers exist and are layered on top of the note model and
  metadata service.
- `writeNote()` waits for metadata by default and can opt out.
- Raw vault behavior remains generic and unchanged.

Validation:

- `vp test tests/vault/sandbox.test.ts`

### T5. Plugin Data Ergonomics

depends_on: []

- Add `plugin.updateDataAndReload()` to patch data, reload if needed, and
  optionally wait for readiness in one operation.
- Add `plugin.withPatchedData()` to patch, reload, run a callback, then restore
  and reload in `finally`.
- Preserve the existing `plugin.data()` low-level API as the primitive layer.
- Default these helpers toward safe behavior: if the plugin is enabled, reload
  and wait; if disabled, do not force-enable it.

Acceptance Criteria:

- Plugin handle exposes the new convenience methods.
- Existing data helpers remain the underlying primitive path.
- Failure-safe restore behavior exists for `withPatchedData()`.

Validation:

- `vp test tests/core/plugin.test.ts`

### T6. Public Test Context

depends_on: [T2, T4, T5]

- Add `createTestContext()` and `withVaultSandbox()` as the single owner of
  lock acquisition, sandbox creation, tracked plugin sessions, artifact capture,
  and cleanup ordering.
- Make disposal order explicit: capture failure artifacts first, then restore
  tracked files/plugin data, then disable plugins enabled by the context, then
  clear app markers, then release host locks, then delete sandbox content.
- Add per-test reset hooks for harness diagnostics so logs/errors/notices do not
  bleed across tests.
- Keep fixtures thin by moving lifecycle policy into this reusable context
  layer.

Acceptance Criteria:

- Public context API exists and fixtures reuse it.
- Cleanup ordering is centralized in one implementation.
- Diagnostics reset between runs.

Validation:

- `vp test tests/fixtures/create-obsidian-test.test.ts tests/fixtures/create-plugin-test.test.ts`

### T7. Obsidian Waits + Matchers

depends_on: [T1, T2, T4]

- Add domain-specific waits for `waitForNotice`, `waitForActiveFile`,
  `waitForFrontmatter`, `waitForConsoleMessage`, and `waitForRuntimeError`.
- Add note/frontmatter matchers using the same shared note and metadata
  services.
- Do not add a generic `waitForCommandEffect`.
- Keep the general `obsidian.waitFor()` primitive for truly custom conditions.

Acceptance Criteria:

- New waits exist on the public client surface.
- Note/frontmatter matchers are implemented without imperative assertion
  methods.
- The generic polling primitive remains available.

Validation:

- `vp test tests/matchers.test.ts tests/core/client.test.ts`

### T8. Failure Artifact Expansion

depends_on: [T1, T2, T4]

- Expand default failure artifacts to include active note raw content, parsed
  note frontmatter, console logs, runtime errors, notices, tabs, and workspace
  state.
- Capture these through the harness and note-model module instead of bespoke
  test-local logic.
- Use bounded ring buffers for console/errors/notices so artifacts stay
  relevant and deterministic.
- Preserve best-effort behavior and neighboring `*.error.txt` files for partial
  capture failures.

Acceptance Criteria:

- Artifact capture covers the expanded bundle.
- Diagnostics come from the harness rather than scattered eval snippets.
- Partial capture failures still emit neighboring error files.

Validation:

- `vp test tests/fixtures/failure-artifacts.test.ts`

### T9. Fixture Refactor + Seed Support

depends_on: [T4, T5, T6, T8]

- Rebuild `createObsidianTest()` and `createPluginTest()` on top of the new
  context API.
- Convert plugin fixtures to tracked plugin sessions instead of hand-coded
  enable/write/disable sequences.
- Extend `seedVault` to accept note descriptors and serialize them through the
  shared note model.
- Remove duplicated cleanup and polling logic from fixture internals once the
  context layer is in place.

Acceptance Criteria:

- Fixture setup delegates lifecycle ownership to the public context API.
- Note descriptors are accepted in `seedVault`.
- Duplicated fixture cleanup logic is removed.

Validation:

- `vp test tests/fixtures/create-obsidian-test.test.ts tests/fixtures/create-plugin-test.test.ts tests/vault/sandbox.test.ts`

### T10. Docs + Migration + Regression Matrix

depends_on: [T7, T8, T9]

- Rewrite README examples around the new `sandbox` note helpers, metadata
  waits, plugin ergonomics, and context API.
- Add migration notes for `dev.eval` semantics and any renamed lifecycle
  entrypoints.
- Add a regression matrix covering race conditions, teardown safety, artifact
  capture timing, and matcher behavior.
- Document the layer boundaries explicitly so future features do not drift back
  into raw `dev.eval(...)` usage.

Acceptance Criteria:

- README and public docs describe the new APIs and layer boundaries.
- Migration notes call out the main behavior/API changes.
- The regression matrix reflects the implemented feature set.

Validation:

- `vp check`

## Work Log

- Created the working implementation plan file from the approved design so
  tasks can be handed off and tracked during implementation.
- Completed T3 by adding a pure note-document utility module that parses note
  frontmatter/body/raw and serializes frontmatter with the shared `yaml`
  dependency.
- Added dedicated note-document tests for no-frontmatter notes, frontmatter
  parsing, newline normalization, empty-body behavior, deterministic
  stringification, and invalid frontmatter shape handling.

## Files Modified Or Created

- `obsidian-aware-test-api-refactor-plan.md`
- `package.json`
- `pnpm-lock.yaml`
- `src/note/document.ts`
- `tests/note/document.test.ts`

## Errors Or Gotchas

- None.
