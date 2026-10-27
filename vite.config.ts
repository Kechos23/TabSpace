import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: "apps/extension",
  base: "./",
  build: {
    outDir: "../../dist/core",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        manager: resolve("apps/extension/index.html"),
        popup: resolve("apps/extension/popup.html"),
        sidepanel: resolve("apps/extension/sidepanel.html"),
        newtab: resolve("apps/extension/newtab.html"),
        parking: resolve("apps/extension/parking.html"),
      },
    },
  },
});
