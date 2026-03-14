# Export Vault Locking Primitives Plan

## Goals

- Export the vault locking primitives from the main `obsidian-e2e` entry point.
- Keep `obsidian-e2e/vitest` as the fixture-focused entry point, not the only
  place consumers can reach lock helpers.
- Preserve a `vite-plus`-free runtime path for consumers using manual
  `beforeAll` / `afterAll` lifecycle with the core client API.

## Task Graph

- [x] `T1` Confirm the public lock API shape and main-barrel ownership
  - depends_on: []
- [x] `T2` Make lock option/type definitions explicitly public in `src/fixtures/vault-lock.ts`
  - depends_on: [`T1`]
- [x] `T3` Re-export lock runtime functions from the main entry point
  - depends_on: [`T1`, `T2`]
- [x] `T4` Re-export lock-related types from the main entry point
  - depends_on: [`T1`, `T2`]
- [x] `T5` Keep `src/vitest.ts` aligned with the new main-entry exports
  - depends_on: [`T2`, `T3`, `T4`]
- [x] `T6` Add or update tests for the main entry point export surface
  - depends_on: [`T3`, `T4`, `T5`]
- [x] `T7` Update docs with manual lifecycle usage from `obsidian-e2e`
  - depends_on: [`T3`, `T4`]
- [x] `T8` Run validation and verify declaration output from `vp pack`
  - depends_on: [`T5`, `T6`, `T7`]

## Constraints

- The main entry point must not accidentally pull in `vite-plus/test` runtime
  dependency just to expose lock helpers.
- The exported lock surface should remain stable and consistent between
  `obsidian-e2e` and `obsidian-e2e/vitest`.
- Tests should prove the main barrel surface directly so export regressions are
  caught without relying only on declaration inspection.

## Status

- Completed: `T1`, `T2`, `T3`, `T4`, `T5`, `T6`, `T7`, `T8`
- In progress: none
- Pending: none

## Work Log

- Created the implementation plan and confirmed the current state:
  `src/fixtures/vault-lock.ts` already owns the lock logic, `src/vitest.ts`
  exports only diagnostics/types, and `src/index.ts` does not yet expose any
  lock primitives.
- Made `AcquireVaultRunLockOptions` public in `src/fixtures/vault-lock.ts` so
  the full runtime/type surface can be exported without inventing a wrapper
  type in the main barrel.
- Re-exported the lock runtime helpers from `src/index.ts` and aligned
  `src/vitest.ts` to expose the same runtime/type surface for consumers that
  already import from the fixture-focused subpath.
- Added a focused barrel-surface test that imports the vault lock runtime
  helpers and related lock types directly from `src/index.ts`.
- Updated `README.md` with a narrow manual lifecycle example that imports
  `createObsidianClient`, `acquireVaultRunLock`, and
  `clearVaultRunLockMarker` from `obsidian-e2e`, and explicitly states that
  `obsidian-e2e/vitest` is not required for that path.
- Validated the finished surface with `vp check --fix`, focused and full
  `vp test` runs, `vp pack`, and a direct inspection of `dist/index.d.mts` to
  confirm the main declaration barrel now exposes the lock helpers and types.

## Files Modified or Created

- `./src/fixtures/vault-lock.ts`
- `./src/index.ts`
- `./src/vitest.ts`
- `./README.md`
- `./tests/main-entry/vault-lock-exports.test.ts`
- `./export-vault-lock-plan.md`

## Errors or Gotchas

- `AcquireVaultRunLockOptions` is currently internal, so the main entry point
  could not re-export the full desired type surface until that became public.
- The lock helpers are safe for the main package at runtime, but care is still
  needed to avoid exporting fixture-only types from the main barrel.
- `src/vitest.ts` should stay aligned with the root lock exports so consumers
  do not see two competing public shapes for the same runtime helpers.
- The README example intentionally stays narrow: it documents only manual
  `beforeAll` / `afterAll` lock acquisition and release from the main entry
  point, not the broader fixture API.
- This task validated the main barrel directly instead of relying on `src/vitest.ts`
  or declaration-only inspection.
