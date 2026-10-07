import { defineConfig } from 'vite';

// Relative asset paths, so the built game works from any URL prefix (e.g. mcscope.com/boilerplate/).
export default defineConfig({
  base: './',
});
