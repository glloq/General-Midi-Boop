// vitest.config.js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // audit-i18n.test.js lives outside tests/frontend/ but uses the Vitest API
    // (it reads public/locales/*.json). It was previously collected by NEITHER
    // runner — Jest ignores it, Vitest didn't include it — so the locale-drift
    // guard never ran. Include it explicitly.
    include: ['tests/frontend/**/*.test.js', 'tests/audit-i18n.test.js'],
    globals: true
  }
});
