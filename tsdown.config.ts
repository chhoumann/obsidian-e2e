import { defineConfig } from "vite-plus/pack";

export default defineConfig({
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
});
