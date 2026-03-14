# obsidian-e2e V4 Plan

## Goals

- Make shared-vault usage safer when multiple worktrees or separate test runs
  target the same `obsidian vault=dev` vault.
- Add an opt-in shared vault lock that coordinates on the host filesystem while
  also publishing a best-effort marker into the running Obsidian app.
- Be explicit that this is serialized access to one shared vault, not true
  same-vault parallelism.

## Task Graph

- [x] `V4-1` Define the shared-vault lock slice and plan the first rollout
  - depends_on: []
- [x] `V4-2` Extend fixture options with `sharedVaultLock`
  - depends_on: [`V4-1`]
- [x] `V4-3` Implement the host-side shared vault lock manager
  - depends_on: [`V4-2`]
- [x] `V4-4` Publish and clear a best-effort app marker for lock visibility
  - depends_on: [`V4-3`]
- [x] `V4-5` Integrate the lock into the shared fixture layer with worker scope
  - depends_on: [`V4-2`, `V4-3`, `V4-4`]
- [x] `V4-6` Add focused tests and user-facing docs for shared vault locking
  - depends_on: [`V4-4`, `V4-5`]
- [ ] `V4-7` Add explicit lock diagnostics and inspection APIs
  - depends_on: [`V4-6`]
- [ ] `V4-8` Add reentrancy and ownership UX hardening
  - depends_on: [`V4-5`, `V4-7`]
- [ ] `V4-9` Add a real multi-process integration smoke path
  - depends_on: [`V4-5`, `V4-6`]

## First Slice

The implemented first slice is `V4-2` through `V4-6`.

That slice adds:

- `sharedVaultLock` on fixture options
- a worker-scoped lock acquisition path in the shared fixture layer
- a file-backed lock directory keyed by vault path
- heartbeat and lease metadata with stale-lock takeover
- a best-effort app marker for visibility only
- tests and README guidance for the shared-vault mode

## Constraints

- The filesystem lock is authoritative; the app marker is informational only.
- The mode should reduce collisions between runs, not pretend to make one live
  vault safe for real concurrent mutation.
- Teardown should always attempt to clear the app marker and release the lock,
  but crash recovery must rely on stale-lock detection rather than perfect
  teardown.

## Status

- Completed: `V4-1`, `V4-2`, `V4-3`, `V4-4`, `V4-5`, `V4-6`
- In progress: none
- Pending: `V4-7`, `V4-8`, `V4-9`

## Work Log

- Added `sharedVaultLock` to the fixture options so shared-vault coordination
  can be enabled per test setup without changing the core client API.
- Implemented a host-side lock manager that writes lease metadata, refreshes a
  heartbeat, supports fail-fast or wait behavior when busy, and steals stale
  locks after the configured timeout window.
- Integrated lock acquisition into a worker-scoped fixture path so one worker
  owns the shared-vault lease at a time and publishes a best-effort marker into
  the Obsidian app for visibility.
- Added focused tests for acquire/release, busy handling, stale takeover, and
  app-marker publishing, then documented the mode in the README.

## Files Modified or Created

- `./README.md`
- `./src/fixtures/base-fixtures.ts`
- `./src/fixtures/create-obsidian-test.ts`
- `./src/fixtures/create-plugin-test.ts`
- `./src/fixtures/types.ts`
- `./src/fixtures/vault-lock.ts`
- `./tests/fixtures/create-obsidian-test.test.ts`
- `./tests/helpers/stub-obsidian-client.ts`
- `./tests/fixtures/vault-lock.test.ts`
- `./v4-plan.md`

## Errors or Gotchas

- `sharedVaultLock` serializes access to a shared vault. It does not enable
  true parallel work inside the same live vault.
- The app marker is best-effort and should not be treated as the lock source of
  truth.
- Crash recovery depends on heartbeat and stale-lock takeover. If the holder
  disappears without cleanup, the next run must wait for or take over the stale
  lease.
