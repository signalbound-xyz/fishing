import { defineConfig } from 'vite';

// The daily reward verifier (DAILY_REWARDS.md) is a serverless function in production. In development it is
// `pnpm api:dev` on its own port, reached through this proxy when DAILY_REWARD_PROXY names it.
const verifier = process.env.DAILY_REWARD_PROXY;

export default defineConfig({
  // Relative asset paths: the same build works at a domain root and under a sub-path (GitHub Pages).
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // Native file events are not delivered for this folder on macOS (Desktop is a protected location),
    // so without polling the dev server keeps serving stale modules after edits.
    watch: { usePolling: true, interval: 300 },
    proxy: verifier ? { '/api': { target: verifier, changeOrigin: true } } : undefined,
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1000 },
});
