import { defineConfig } from 'vite';

// Relative asset paths, so the built game works from any URL prefix (e.g. mcscope.com/pressure-lab/).
export default defineConfig({
  base: './',
});
