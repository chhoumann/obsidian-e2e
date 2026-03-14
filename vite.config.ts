import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: {
    clean: true,
    deps: {
      neverBundle: ["vite-plus/test"],
    },
    dts: {
      tsgo: true,
    },
    entry: ["src/index.ts", "src/vitest.ts", "src/matchers.ts"],
    exports: false,
    fixedExtension: true,
    format: ["esm", "cjs"],
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
