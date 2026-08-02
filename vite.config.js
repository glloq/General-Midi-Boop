// vite.config.js
import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The SPA is served as ~190 classic (non-module) `<script>` tags. Vite cannot
 * bundle or rewrite those, but it DOES minify and hash the CSS referenced from
 * index.html. To make the built `dist/` genuinely self-contained — so
 * production (which serves dist/ when present) does not 404 on every script or
 * runtime-fetched asset — copy the classic JS and static trees verbatim after
 * the bundle is written. Migrating the ~190 scripts to ES modules for true
 * bundling is a separate, larger effort and intentionally out of scope here.
 */
function copyStaticTree() {
  const dirs = ['js', 'locales', 'assets', 'styles'];
  return {
    name: 'gmboop-copy-static-tree',
    // Run after the bundle (and Vite's emptyOutDir) so the copies survive.
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      for (const d of dirs) {
        const src = resolve(__dirname, 'public', d);
        if (existsSync(src)) {
          cpSync(src, resolve(outDir, d), { recursive: true });
        }
      }
    }
  };
}

export default defineConfig({
  root: 'public',
  plugins: [copyStaticTree()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'public/index.html')
    },
    minify: 'oxc',
    sourcemap: false
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      }
    }
  }
});
