import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    clean: true,
    deps: {
      neverBundle: ["vite-plus", "vite-plus/test", "@voidzero-dev/vite-plus-test"],
      onlyBundle: false,
    },
    dts: {
      resolver: "tsc",
    },
    entry: ["src/index.ts", "src/vitest.ts", "src/matchers.ts"],
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
  },
  test: {
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    maxWorkers: 1,
  },
});
