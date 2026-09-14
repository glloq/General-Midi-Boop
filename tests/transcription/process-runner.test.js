/**
 * @file tests/transcription/process-runner.test.js
 * @description The subprocess guarantees of §20/§40: no shell, a filtered
 * environment, bounded capture, SIGTERM→SIGKILL, no survivors on cancel.
 * No real process is ever spawned — `spawn` is injected.
 */
import { describe, test, expect, jest } from '@jest/globals';
import {
  ProcessRunner,
  buildChildEnv,
  networkEnv,
  NETWORK_ENV_KEYS,
  isMissingBinaryError,
  tail,
  PROCESS_DEFAULTS
} from '../../src/transcription/utils/ProcessRunner.js';
import { TranscriptionError } from '../../src/transcription/TranscriptionError.js';
import { makeFakeSpawn, makeScriptedSpawn } from '../helpers/fakeChildProcess.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('spawn safety', () => {
  test('never uses a shell and passes arguments as an array', async () => {
    const { spawn, calls } = makeScriptedSpawn([{ code: 0 }]);
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    await runner.run('ffmpeg', ['-i', '/tmp/a b; rm -rf /.wav', '/tmp/out.wav']);

    expect(calls[0].command).toBe('ffmpeg');
    expect(calls[0].args).toEqual(['-i', '/tmp/a b; rm -rf /.wav', '/tmp/out.wav']);
    expect(calls[0].options.shell).toBe(false);
  });

  test('refuses a non-string argument instead of stringifying it into argv', async () => {
    const { spawn } = makeScriptedSpawn([{ code: 0 }]);
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    await expect(runner.run('ffmpeg', ['-i', { toString: () => '/etc/passwd' }])).rejects.toThrow(
      TypeError
    );
    await expect(runner.run('', [])).rejects.toThrow(TypeError);
  });

  test('spawns in its own process group so descendants can be killed', async () => {
    const { spawn, calls } = makeScriptedSpawn([{ code: 0 }]);
    await new ProcessRunner({ logger: silentLogger, spawn }).run('python3', ['x.py']);
    if (process.platform !== 'win32') {
      expect(calls[0].options.detached).toBe(true);
    }
  });
});

describe('environment filtering', () => {
  test('withholds the server environment and pins the locale', () => {
    const previous = process.env.GMBOOP_API_TOKEN;
    process.env.GMBOOP_API_TOKEN = 'super-secret';
    try {
      const env = buildChildEnv();
      expect(env.GMBOOP_API_TOKEN).toBeUndefined();
      expect(env.LC_ALL).toBe('C');
      expect(env.LANG).toBe('C');
      // PATH must survive, or nothing can be found.
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (previous === undefined) delete process.env.GMBOOP_API_TOKEN;
      else process.env.GMBOOP_API_TOKEN = previous;
    }
  });

  test('grants only the extras the caller passes explicitly', () => {
    const env = buildChildEnv({ VIRTUAL_ENV: '/opt/venv', NOTHING: null });
    expect(env.VIRTUAL_ENV).toBe('/opt/venv');
    expect(env).not.toHaveProperty('NOTHING');
  });

  // The allow-list starves a package installer behind a proxy or a private
  // CA: pip fails on TLS or DNS while the operator's own shell works, and
  // nothing in the error says why. `networkEnv()` is the narrow, opt-in
  // answer — see its doc comment.
  describe('networkEnv (installers only)', () => {
    // The whole list, not a sample: a CI box or a dev container may have
    // any of these set for its own reasons, and the test must describe
    // `networkEnv()` rather than the machine it runs on.
    let saved;

    beforeEach(() => {
      saved = NETWORK_ENV_KEYS.map((k) => [k, process.env[k]]);
      for (const k of NETWORK_ENV_KEYS) delete process.env[k];
    });
    afterEach(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test('passes through the proxy, CA and index settings that are set', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example:3128';
      process.env.REQUESTS_CA_BUNDLE = '/etc/ssl/corp.pem';
      process.env.no_proxy = 'localhost';
      expect(networkEnv()).toEqual({
        HTTPS_PROXY: 'http://proxy.example:3128',
        REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
        no_proxy: 'localhost'
      });
    });

    test('omits what is unset or empty rather than passing an empty string', () => {
      process.env.PIP_INDEX_URL = '';
      expect(networkEnv()).toEqual({});
    });

    test('carries nothing beyond network settings — a token never rides along', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example:3128';
      const previous = process.env.GMBOOP_API_TOKEN;
      process.env.GMBOOP_API_TOKEN = 'secret';
      try {
        expect(Object.keys(networkEnv())).toEqual(['HTTPS_PROXY']);
      } finally {
        if (previous === undefined) delete process.env.GMBOOP_API_TOKEN;
        else process.env.GMBOOP_API_TOKEN = previous;
      }
    });

    test('is NOT part of the default child environment', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example:3128';
      // FFmpeg and the transcription runner read local files and a local
      // model. Neither has any business reaching the network, so neither
      // learns how to.
      expect(buildChildEnv()).not.toHaveProperty('HTTPS_PROXY');
    });
  });

  test('the child receives the filtered environment, not process.env', async () => {
    const { spawn, calls } = makeScriptedSpawn([{ code: 0 }]);
    await new ProcessRunner({ logger: silentLogger, spawn }).run('ffmpeg', [], {
      env: { PYTHONPATH: '/opt/x' }
    });
    expect(calls[0].options.env.PYTHONPATH).toBe('/opt/x');
    expect(calls[0].options.env).not.toBe(process.env);
  });
});

describe('result handling', () => {
  test('resolves with the captured output and the exit code', async () => {
    const { spawn } = makeScriptedSpawn([{ stdout: 'hello\n', stderr: 'warn\n', code: 0 }]);
    const result = await new ProcessRunner({ logger: silentLogger, spawn }).run('ffprobe', []);
    expect(result).toMatchObject({
      code: 0,
      stdout: 'hello\n',
      stderr: 'warn\n',
      stdoutTruncated: false,
      stderrTruncated: false
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('a non-zero exit resolves — the caller decides what it means', async () => {
    const { spawn } = makeScriptedSpawn([{ stderr: 'bad input\n', code: 1 }]);
    const result = await new ProcessRunner({ logger: silentLogger, spawn }).run('ffmpeg', []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('bad input');
  });

  test('a missing binary is a typed error a caller can remap', async () => {
    const { spawn } = makeScriptedSpawn([{ spawnError: { code: 'ENOENT' } }]);
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    const error = await runner.run('ffmpeg', []).catch((e) => e);
    expect(error).toBeInstanceOf(TranscriptionError);
    expect(isMissingBinaryError(error)).toBe(true);
    expect(error.message).toMatch(/Command not found/);
  });

  test('a synchronous spawn throw is wrapped, not leaked', async () => {
    const runner = new ProcessRunner({
      logger: silentLogger,
      spawn: () => {
        const error = new Error('EACCES');
        error.code = 'EACCES';
        throw error;
      }
    });
    await expect(runner.run('ffmpeg', [])).rejects.toBeInstanceOf(TranscriptionError);
  });
});

describe('stream handling', () => {
  test('forwards complete lines and keeps a partial line buffered', async () => {
    const lines = [];
    const { spawn, children } = makeFakeSpawn();
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    const pending = runner.run('python3', [], { onStdoutLine: (l) => lines.push(l) });

    const child = children[0];
    child.emitStdout('{"type":"progress"}\n{"type":"par');
    expect(lines).toEqual(['{"type":"progress"}']);
    child.emitStdout('tial"}\n');
    child.close(0);
    await pending;
    expect(lines).toEqual(['{"type":"progress"}', '{"type":"partial"}']);
  });

  test('strips a trailing CR so CRLF output parses', async () => {
    const lines = [];
    const { spawn, children } = makeFakeSpawn();
    const pending = new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], {
      onStdoutLine: (l) => lines.push(l)
    });
    children[0].emitStdout('a\r\nb\r\n');
    children[0].close(0);
    await pending;
    expect(lines).toEqual(['a', 'b']);
  });

  test('truncates capture past the byte budget instead of buffering it', async () => {
    const { spawn, children } = makeFakeSpawn();
    const pending = new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], {
      maxStdoutBytes: 10,
      maxStderrBytes: 5
    });
    children[0].emitStdout('0123456789ABCDEF');
    children[0].emitStderr('abcdefghij');
    children[0].close(0);
    const result = await pending;
    expect(result.stdout).toBe('0123456789');
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderr).toBe('abcde');
    expect(result.stderrTruncated).toBe(true);
  });

  test('drops a line that never ends rather than growing without bound', async () => {
    const lines = [];
    const { spawn, children } = makeFakeSpawn();
    const pending = new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], {
      maxLineLength: 8,
      onStdoutLine: (l) => lines.push(l)
    });
    children[0].emitStdout('x'.repeat(64));
    children[0].emitStdout('\nshort\n');
    children[0].close(0);
    await pending;
    expect(lines).toEqual(['short']);
  });

  test('a throwing line handler does not break the run', async () => {
    const { spawn, children } = makeFakeSpawn();
    const pending = new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], {
      onStdoutLine: () => {
        throw new Error('handler bug');
      }
    });
    children[0].emitStdout('line\n');
    children[0].close(0);
    await expect(pending).resolves.toMatchObject({ code: 0 });
  });

  test('writes the provided input to stdin and closes it', async () => {
    const { spawn, children } = makeScriptedSpawn([{ code: 0 }]);
    await new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], { input: '{"a":1}' });
    expect(children[0].stdin.written).toBe('{"a":1}');
    expect(children[0].stdin.ended).toBe(true);
  });
});

describe('timeout and cancellation', () => {
  test('a timeout SIGTERMs, then SIGKILLs, and rejects with the given reason', async () => {
    jest.useFakeTimers();
    try {
      const { spawn, children } = makeFakeSpawn();
      const runner = new ProcessRunner({ logger: silentLogger, spawn });
      const pending = runner.run('ffmpeg', [], {
        timeoutMs: 1000,
        killGraceMs: 500,
        reasonOnTimeout: 'BACKEND_TIMEOUT'
      });
      const child = children[0];

      await jest.advanceTimersByTimeAsync(1000);
      expect(child.signals).toEqual(['SIGTERM']);

      await jest.advanceTimersByTimeAsync(500);
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);

      child.close(null, 'SIGKILL');
      const error = await pending.catch((e) => e);
      expect(error).toBeInstanceOf(TranscriptionError);
      expect(error.reason).toBe('BACKEND_TIMEOUT');
      expect(error.message).toMatch(/timed out after 1000ms/);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an abort terminates the child and rejects as a cancellation', async () => {
    const { spawn, children } = makeFakeSpawn();
    const controller = new AbortController();
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    const pending = runner.run('python3', [], { signal: controller.signal });

    controller.abort();
    expect(children[0].signals).toEqual(['SIGTERM']);
    children[0].close(null, 'SIGTERM');

    const error = await pending.catch((e) => e);
    expect(error.reason).toBe('TRANSCRIPTION_CANCELLED');
  });

  test('an already-aborted signal never spawns anything', async () => {
    const { spawn, calls } = makeScriptedSpawn([{ code: 0 }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ProcessRunner({ logger: silentLogger, spawn }).run('ffmpeg', [], {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ reason: 'TRANSCRIPTION_CANCELLED' });
    expect(calls).toHaveLength(0);
  });

  test('cancellation wins over a non-zero exit code', async () => {
    const { spawn, children } = makeFakeSpawn();
    const controller = new AbortController();
    const pending = new ProcessRunner({ logger: silentLogger, spawn }).run('x', [], {
      signal: controller.signal
    });
    controller.abort();
    children[0].close(1, null);
    await expect(pending).rejects.toMatchObject({ reason: 'TRANSCRIPTION_CANCELLED' });
  });

  test('tracks live children and killAll signals them on shutdown', async () => {
    const { spawn, children } = makeFakeSpawn();
    const runner = new ProcessRunner({ logger: silentLogger, spawn });
    const pending = runner.run('x', []);
    expect(runner.runningCount).toBe(1);

    expect(runner.killAll('SIGTERM')).toBe(1);
    expect(children[0].signals).toContain('SIGTERM');

    children[0].close(0);
    await pending;
    expect(runner.runningCount).toBe(0);
  });
});

describe('helpers', () => {
  test('tail keeps the last lines of a captured stream', () => {
    expect(tail('a\nb\nc\nd\ne\nf\n', 2)).toBe('e\nf');
    expect(tail('')).toBe('');
  });

  test('the documented defaults are bounded', () => {
    expect(PROCESS_DEFAULTS.timeoutMs).toBeGreaterThan(0);
    expect(PROCESS_DEFAULTS.maxStderrBytes).toBeLessThanOrEqual(PROCESS_DEFAULTS.maxStdoutBytes);
  });
});
