import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The web client is served from the hosted origin. Its files live under
// /app/ so they never mix with the hosted site's own static files; the
// deployment serves /app/index.html for /inbox and /settings. Every address
// is a path on that origin, so the build carries no host names.
export default defineConfig({
  base: '/app/',
  plugins: [preact()],
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
  },
});
