import { defineConfig } from 'vite';

// Relative base so the build works at any GitHub Pages path.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
