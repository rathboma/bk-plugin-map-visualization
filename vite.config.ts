/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import bks from "@beekeeperstudio/vite-plugin";

export default defineConfig({
  // bks() links this folder into Beekeeper Studio's plugins directory; skip that when running tests
  plugins: [vue(), ...(process.env.VITEST ? [] : [bks()])],
  build: {
    sourcemap: false,
    // Beekeeper's plugin:// protocol only sets MIME types for js/css/html/svg/json,
    // so keep small images (Leaflet's control sprites) inlined as data URIs.
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
  },
});
