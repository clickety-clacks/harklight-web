import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The web client is served from the hosted origin. Every address it uses is
// relative to that origin, so the build carries no host names.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
  },
});
