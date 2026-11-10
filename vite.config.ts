import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, watch: { ignored: ['**/.claude/**', '**/notes/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1200 },
  // the export workers are module workers: their lazy imports (font stylesheets the engine never asks for in a
  // worker) stay separate chunks instead of being inlined into a script that would touch the document on load
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts', 'electron/**/*.test.mjs'], environment: 'node' },
});
