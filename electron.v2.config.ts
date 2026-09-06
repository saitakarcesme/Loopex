import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out-v2/main",
      rollupOptions: { input: resolve("v2/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out-v2/preload",
      rollupOptions: {
        input: resolve("v2/main/preload.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "v2/renderer",
    plugins: [react()],
    build: {
      outDir: resolve("out-v2/renderer"),
      minify: "esbuild",
      rollupOptions: { input: resolve("v2/renderer/index.html") },
    },
  },
});
