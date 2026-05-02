import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Widget loader — builds a single self-contained IIFE bundle.
 * Output goes to apps/web/static/widget.js so SvelteKit serves it
 * at /widget.js. URL-stable for existing customers' embed snippets.
 */
export default defineConfig({
  build: {
    target: 'es2018',
    minify: 'esbuild',
    cssCodeSplit: false,
    outDir: resolve(__dirname, '../web/static'),
    emptyOutDir: false, // keep favicon.svg etc.
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['iife'],
      name: 'CardPricerWidget',
      fileName: () => 'widget.js',
    },
    rollupOptions: {
      output: {
        // No externals — single self-contained file.
        extend: false,
      },
    },
  },
});
