# obsidian-e2e Scaffold Plan

## Goals

- Scaffold `obsidian-e2e` as a single-package library.
- Use Vite+ as the workflow shell and `tsdown` as the package build layer.
- Keep the library Vitest-first, plugin-agnostic, and library-only.
- Publish `obsidian-e2e`, `obsidian-e2e/vitest`, and `obsidian-e2e/matchers`.

## Task Graph

- [x] `T1` Initialize the package scaffold and workspace metadata
  - depends_on: []
- [x] `T2` Add Vite+ workflow integration and root config
  - depends_on: [`T1`]
- [x] `T3` Add tsdown build config and package export map
  - depends_on: [`T1`]
- [x] `T4` Define shared public types and low-level transport/client contracts
  - depends_on: [`T1`]
- [x] `T5` Implement core transport, command execution, and wait utilities
  - depends_on: [`T4`]
- [x] `T6` Implement vault API, JSON helpers, and sandbox API
  - depends_on: [`T5`]
- [x] `T7` Implement generic plugin handle and lazy `data.json` restore semantics
  - depends_on: [`T5`, `T6`]
- [x] `T8` Implement Vitest fixture builder in `obsidian-e2e/vitest`
  - depends_on: [`T5`, `T6`, `T7`]
- [x] `T9` Implement matcher entrypoint and matcher type augmentation
  - depends_on: [`T6`, `T8`]
- [x] `T10` Add package barrel exports and subpath entrypoints
  - depends_on: [`T3`, `T4`, `T8`, `T9`]
- [x] `T11` Add automated tests for core utilities, fixtures, plugin restore behavior, and matchers
  - depends_on: [`T5`, `T6`, `T7`, `T8`, `T9`]
- [x] `T12` Write README usage docs and Vitest serial-execution guidance
  - depends_on: [`T8`, `T9`, `T10`]
- [x] `T13` Run verification through `vp check`, `vp test`, and `vp pack` and fix issues
  - depends_on: [`T2`, `T3`, `T10`, `T11`, `T12`]

## Status

- Completed: `T1`, `T2`, `T3`, `T4`, `T5`, `T6`, `T7`, `T8`, `T9`, `T10`, `T11`, `T12`, `T13`
- In progress: none
- Pending: none

## Work Log

- Bootstrapped the repo using `vp create vite:library` in a temp directory and synced the generated scaffold into this repo because `vp create` would not scaffold directly into an existing git-initialized directory.
- Completed `T2`/`T3` by renaming the package, removing the broken Vite+ config merge, wiring explicit Vite+ scripts, and defining the dual-format tsdown build plus subpath exports.
- Completed `T4`/`T5` by adding shared core types, direct-binary transport, polling utilities, an initial Obsidian client, and focused tests for arg normalization and waiting behavior.
- Completed `T6`/`T7` by adding filesystem-backed vault and sandbox APIs, wiring plugin `data.json` snapshot/restore support through client internals, and validating focused plugin/sandbox tests with `vp test`.
- Completed `T8`/`T9`/`T10` by adding the Vitest fixture entrypoint, matcher registration, and the public subpath entry files.
- Completed `T11` with focused tests for the core client, plugin restore semantics, vault/sandbox behavior, fixtures, and matchers.
- Completed `T12`/`T13` by rewriting the README against the real public API and validating the package with `vp check`, `vp test`, `vp exec tsc --noEmit`, and `vp pack`.

## Files Modified or Created

- `./.gitignore`
- `./.vite-hooks/pre-commit`
- `./AGENTS.md`
- `./README.md`
- `./package.json`
- `./pnpm-lock.yaml`
- `./src/index.ts`
- `./src/matchers.ts`
- `./src/vitest.ts`
- `./src/core/args.ts`
- `./src/core/client.ts`
- `./src/core/errors.ts`
- `./src/core/internals.ts`
- `./src/core/plugin.ts`
- `./src/core/transport.ts`
- `./src/core/types.ts`
- `./src/core/wait.ts`
- `./src/fixtures/create-obsidian-test.ts`
- `./src/fixtures/types.ts`
- `./src/plugin/plugin.ts`
- `./src/vault/json-file.ts`
- `./src/vault/sandbox.ts`
- `./src/vault/vault.ts`
- `./tests/core/args.test.ts`
- `./tests/core/client.test.ts`
- `./tests/core/plugin.test.ts`
- `./tests/core/wait.test.ts`
- `./tests/fixtures/create-obsidian-test.test.ts`
- `./tests/matchers.test.ts`
- `./tests/vault/sandbox.test.ts`
- `./tsconfig.json`
- `./tsdown.config.ts`
- `./vite.config.ts`
- `./scaffold-plan.md`

## Errors or Gotchas

- `vp create vite:library` currently leaves a broken `vite.config.ts` migration when run against the default `create-tsdown` output, so config cleanup is part of the implementation work.
- The generated `prepare` script caused `vp install` to prompt for hook setup, so the package scripts were cleaned up to avoid interactive install-time configuration.
- `vp pack` currently succeeds but emits upstream warnings from Vite+/vite-plus-test internals when producing CommonJS output. The library still builds successfully; those warnings come from the current dependency stack rather than from this repository’s source.
