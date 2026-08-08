import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync
} from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { ApiTokenManager } from '../src/infrastructure/auth/ApiTokenManager.js';

const POSIX_ONLY = platform() === 'win32' ? describe.skip : describe;

function makeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {}
  };
}

describe('ApiTokenManager', () => {
  let tmpDir;
  let envPath;
  let originalToken;

  beforeEach(() => {
    originalToken = process.env.GMBOOP_API_TOKEN;
    delete process.env.GMBOOP_API_TOKEN;
    tmpDir = mkdtempSync(join(tmpdir(), 'gmboop-token-'));
    envPath = join(tmpDir, '.env');
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GMBOOP_API_TOKEN;
    else process.env.GMBOOP_API_TOKEN = originalToken;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generates a token and writes it to .env when missing', () => {
    new ApiTokenManager(makeLogger(), envPath).ensure();
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^GMBOOP_API_TOKEN=[0-9a-f]{64}\n?$/m);
    expect(process.env.GMBOOP_API_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is a no-op when the env var is already set', () => {
    process.env.GMBOOP_API_TOKEN = 'preset-token';
    new ApiTokenManager(makeLogger(), envPath).ensure();
    expect(existsSync(envPath)).toBe(false);
    expect(process.env.GMBOOP_API_TOKEN).toBe('preset-token');
  });

  test('appends the token line when .env exists without it', () => {
    writeFileSync(envPath, 'OTHER=1\n', 'utf8');
    new ApiTokenManager(makeLogger(), envPath).ensure();
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^OTHER=1$/m);
    expect(content).toMatch(/^GMBOOP_API_TOKEN=[0-9a-f]{64}$/m);
  });

  test('appends a real token line when .env has only a similarly-named var (audit A2 N5)', () => {
    // `includes("GMBOOP_API_TOKEN")` is true for this line, but the anchored
    // replace matches nothing — the fix must still write a real assignment
    // rather than leave the file unchanged (which would silently rotate the
    // token on every restart).
    writeFileSync(envPath, 'GMBOOP_API_TOKEN_BACKUP=abc\n', 'utf8');
    new ApiTokenManager(makeLogger(), envPath).ensure();
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^GMBOOP_API_TOKEN_BACKUP=abc$/m);
    expect(content).toMatch(/^GMBOOP_API_TOKEN=[0-9a-f]{64}$/m);
  });

  test('replaces the token line when .env already declares it', () => {
    writeFileSync(envPath, 'GMBOOP_API_TOKEN=stale\nOTHER=1\n', 'utf8');
    new ApiTokenManager(makeLogger(), envPath).ensure();
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/^OTHER=1$/m);
    expect(content).not.toMatch(/stale/);
    expect(content).toMatch(/^GMBOOP_API_TOKEN=[0-9a-f]{64}$/m);
  });

  POSIX_ONLY('POSIX permissions', () => {
    test('newly created .env is chmodded to 0600', () => {
      new ApiTokenManager(makeLogger(), envPath).ensure();
      const mode = statSync(envPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test('existing world-readable .env is hardened to 0600 after token write', () => {
      writeFileSync(envPath, 'OTHER=1\n', 'utf8');
      chmodSync(envPath, 0o644);
      new ApiTokenManager(makeLogger(), envPath).ensure();
      const mode = statSync(envPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
