import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri.
// Tauri expects the dev server on a fixed port and disables HMR over network.
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      // Don't watch the Rust side or workspace siblings — they have their own toolchains.
      ignored: ["**/src-tauri/**", "**/sidecar/**", "**/spike/**"],
    },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
  },
}));
