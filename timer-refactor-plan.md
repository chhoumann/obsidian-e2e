# Timer Refactor Plan

## Goal

Replace timer-shaped subprocess smoke test assertions with state-based handshakes and lock-state inspection, while keeping lease-based stale detection as the only intentional time dependency.

## Tasks

- [x] T1 Refactor raw vault lock subprocess smoke tests in `tests/fixtures/vault-lock.test.ts` and `tests/helpers/vault-lock-child.ts`
  - depends_on: []
  - Acceptance:
    - remove arbitrary sleeps used to prove blocking
    - add explicit child lifecycle signaling as needed
    - assert protocol transitions via `inspectVaultRunLock(...)`
    - keep stale takeover coverage
  - Validation:
    - `vp test tests/fixtures/vault-lock.test.ts`

- [ ] T2 Refactor fixture-level shared vault lock smoke tests in `tests/fixtures/shared-vault-lock-fixture.test.ts` and `tests/helpers/shared-vault-lock-fixture-child.test.ts`
  - depends_on: []
  - Acceptance:
    - remove arbitrary sleeps/short timeout assertions used to prove blocking
    - add explicit child startup signaling as needed
    - assert fixture contention through lock inspection and file-based rendezvous
    - keep stale takeover coverage
  - Validation:
    - `vp test tests/fixtures/shared-vault-lock-fixture.test.ts`

- [ ] T3 Integrate, validate, and document remaining intentional timing dependencies
  - depends_on: ["T1", "T2"]
  - Acceptance:
    - ensure both refactors coexist cleanly
    - run focused and broader validation
    - record concise work log and gotchas
  - Validation:
    - `vp test tests/fixtures/vault-lock.test.ts`
    - `vp test tests/fixtures/shared-vault-lock-fixture.test.ts`
    - `pnpm run release:check`

## Work Log

- Completed T1 by replacing the raw vault-lock subprocess smoke tests'
  arbitrary blocking sleeps with explicit child `attempting` signaling plus
  `inspectVaultRunLock(...)` polling for lock-owner transitions. Stale takeover
  coverage now waits for the inspected lock state to become stale before
  asserting the next owner.

## Files

- `./tests/fixtures/vault-lock.test.ts`
- `./tests/helpers/vault-lock-child.ts`
- `./timer-refactor-plan.md`

## Errors / Gotchas

- The stale-takeover scenario still intentionally depends on elapsed lease
  time; the refactor removes arbitrary sleeps for proving blocking, not the
  stale heartbeat model itself.
