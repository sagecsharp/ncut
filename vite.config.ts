import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false, watch: { ignored: ['**/.claude/**', '**/notes/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1200 },
  test: { include: ['src/**/*.test.ts', 'electron/**/*.test.mjs'], environment: 'node' },
});
