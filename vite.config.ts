import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative paths let the build be hosted from any sub-directory.
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
