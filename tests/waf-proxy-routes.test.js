// tests/waf-proxy-routes.test.js
//
// Smoke tests for the WAF same-origin proxy. We don't hit the real CDN —
// only the input-validation regex and the in-memory cache plumbing are
// exercised here. The user-visible bug they prevent: a malicious URL
// like `..%2F..%2Fetc%2Fpasswd.js` falling through to the upstream fetch.

import { _internal } from '../src/api/wafProxyRoutes.js';

const { SAFE_FILENAME } = _internal;

describe('WAF proxy — filename allowlist', () => {
  test('accepts the canonical WAF naming convention', () => {
    expect(SAFE_FILENAME.test('0000_FluidR3_GM_sf2_file.js')).toBe(true);
    expect(SAFE_FILENAME.test('12836_0_FluidR3_GM_sf2_file.js')).toBe(true);
    expect(SAFE_FILENAME.test('12836_12_JCLive_sf2_file.js')).toBe(true);
  });

  test('rejects path traversal attempts', () => {
    expect(SAFE_FILENAME.test('../etc/passwd.js')).toBe(false);
    expect(SAFE_FILENAME.test('..%2Fetc%2Fpasswd.js')).toBe(false);
    expect(SAFE_FILENAME.test('subdir/file.js')).toBe(false);
  });

  test('rejects non-.js extensions and empty filenames', () => {
    expect(SAFE_FILENAME.test('file.sf2')).toBe(false);
    expect(SAFE_FILENAME.test('file')).toBe(false);
    expect(SAFE_FILENAME.test('.js')).toBe(false);
    expect(SAFE_FILENAME.test('')).toBe(false);
  });

  test('rejects shell metacharacters and spaces', () => {
    expect(SAFE_FILENAME.test('foo;ls.js')).toBe(false);
    expect(SAFE_FILENAME.test('foo bar.js')).toBe(false);
    expect(SAFE_FILENAME.test('foo|cat.js')).toBe(false);
  });

  test('rejects unreasonably long filenames', () => {
    const long = 'a'.repeat(300) + '.js';
    expect(SAFE_FILENAME.test(long)).toBe(false);
  });
});
