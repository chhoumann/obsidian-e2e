import { defineConfig } from "vite-plus/pack";

export default defineConfig({
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
});
