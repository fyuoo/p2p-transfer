import { defineConfig } from "vite";

// Port can be overridden via the VITE_PORT env var (default 1420), so multiple `tauri dev`
// instances can run on one machine without port conflicts.
// A single instance occupies three ports: VITE_PORT (vite) / VITE_PORT+1 (HMR ws) /
// Tauri's built-in server (specified via --port).
// Second-instance example: VITE_PORT=1431 → vite 1431 / HMR ws 1432; then --port 1440 for Tauri's built-in server.
const basePort = Number(process.env.VITE_PORT ?? 1420);

export default defineConfig({
  clearScreen: false,
  // The web static-asset dir was renamed to "config" (formerly "public") to distinguish it
  // from the root-level public/ contract layer and avoid name collisions.
  publicDir: "config",
  server: {
    port: basePort,
    strictPort: true,
    host: false,
    // Do not set hmr.host: the client connects to ws using the page's own hostname,
    // so both localhost and LAN IPs work.
    // Hard-coding "0.0.0.0" earlier was an anti-pattern — the client would try ws://0.0.0.0:<port>,
    // which inevitably fails on mobile.
    hmr: { protocol: "ws", port: basePort + 1 },
    watch: { ignored: ["**/windows/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // Dual entry points: the desktop index.html and the standalone mobile page mobile.html,
    // each built separately.
    rollupOptions: {
      input: {
        main: "index.html",
        mobile: "mobile.html",
      },
      output: {
        // Pin the shared chunk (transfer engine + its deps) to the name "app-engine": Rollup
        // names chunks after the "first module" by default, so adding a new shared module would
        // rename it (it once became press-feedback-*.js) and break deployment by name mismatch.
        manualChunks: { "app-engine": ["./src/app-engine.ts"] },
      },
    },
  },
});
