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
  // 'lib' holds the WebAudioFont player vendored by
  // scripts/install-default-sf2.js at postinstall. It used to be missing from
  // this list, and that single omission broke the product's offline-first
  // promise: HttpServer.js serves dist/ as soon as NODE_ENV=production and
  // dist/index.html exists (exactly what scripts/Install.sh + the systemd unit
  // produce), so lib/WebAudioFontPlayer.js was absent from EVERY production
  // install even when the postinstall had succeeded — audio preview dead, and
  // the page reaching for a CDN an offline Pi can never hit (audit L11 F-14 /
  // L08 F-87). A regression here is invisible in dev (which serves public/).
  const dirs = ['js', 'locales', 'assets', 'styles', 'lib'];
  // Resolved from the build config rather than hard-coded to ./dist, so
  // `vite build --outDir <path>` copies the static trees where the rest of the
  // build actually went (a hard-coded dist/ silently split the output in two).
  let outDir = resolve(__dirname, 'dist');
  return {
    name: 'gmboop-copy-static-tree',
    configResolved(resolved) {
      if (resolved?.build?.outDir) {
        outDir = resolve(resolved.root || __dirname, resolved.build.outDir);
      }
    },
    // Run after the bundle (and Vite's emptyOutDir) so the copies survive.
    closeBundle() {
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
