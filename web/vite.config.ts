import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Explicit aliases so the shared rules and the UI primitives resolve
      // identically under dev, build and typecheck.
      '@nimturf/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Needed so a phone running Nimiq Pay can load the dev server over the LAN.
    host: true,
  },
  build: {
    target: 'es2022',
    // The map is the heavy part; keep the first paint small.
    chunkSizeWarningLimit: 900,
  },
});
