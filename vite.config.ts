import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    clean: true,
    deps: {
      onlyBundle: false,
    },
    dts: {
      resolver: "tsc",
    },
    entry: [
      "src/index.ts",
      "src/vitest.ts",
      "src/matchers.ts",
      "src/runner/index.ts",
      "src/runner/bin.ts",
      "src/capture/index.ts",
    ],
    exports: false,
    fixedExtension: true,
    format: ["esm"],
    platform: "node",
    sourcemap: true,
    target: ["node20.19"],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // Tests run generated code the way Obsidian's CLI `eval` would.
        files: ["tests/**"],
        rules: { "no-eval": "off" },
      },
    ],
  },
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    maxWorkers: 1,
  },
});
