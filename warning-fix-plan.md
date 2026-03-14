# Warning Fix Plan

## Goals

- Eliminate `vp pack` warnings that are caused by this repository's configuration or source.
- Distinguish unavoidable upstream warnings from locally fixable issues.
- Keep the public API stable unless a packaging change is required to remove warnings cleanly.

## Constraints

- Prefer fixing warnings in repo code/config rather than suppressing them blindly.
- Preserve the existing `obsidian-e2e`, `obsidian-e2e/vitest`, and `obsidian-e2e/matchers` entrypoints if feasible.
- Avoid changes that break `vp test`, `vp check`, or type generation.

## Tasks

- [x] W1 Reproduce and classify warnings
  - depends_on: []
- [x] W2 Find a packaging/config fix for warnings caused by `vite-plus/test`
  - depends_on: [W1]
- [x] W3 Implement the fix and verify `vp pack` is warning-free
  - depends_on: [W2]

## Work Log

- Created plan for warning cleanup.
- Reproduced `vp pack` warnings and confirmed the main local cause was declaration bundling for `src/vitest.ts`.
- Replaced the inferred `createObsidianTest()` return type with an explicit exported `ObsidianTest` alias based on `TestAPI<ObsidianFixtures>`.
- Switched the package to ESM-only output, pointed package metadata at `.d.mts` files, and moved tsdown DTS generation from experimental `tsgo` to the TypeScript resolver.
- Added explicit `neverBundle` entries for `vite-plus` test imports and disabled bundled-dependency hint output.
- Re-ran `vp pack`, `vp test`, and `vp check`; packaging is now warning-free and all checks pass.

## Files Modified

- package.json
- src/fixtures/create-obsidian-test.ts
- src/fixtures/types.ts
- src/vitest.ts
- tsdown.config.ts
- vite.config.ts
- warning-fix-plan.md

## Errors / Gotchas

- The largest warning came from our own inferred `createObsidianTest()` return type, which forced tsdown to inline the full `vite-plus/test` declaration graph.
- The CommonJS and `tsgo` warnings were self-inflicted by config choices, so removing them was cleaner than trying to suppress them.
