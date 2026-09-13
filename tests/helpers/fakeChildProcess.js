// tests/helpers/fakeChildProcess.js
// In-memory stand-in for `child_process.spawn`, used by the transcription
// tests so FFmpeg / ffprobe / Python are never actually executed.
//
// `ProcessRunner` takes its `spawn` through DI precisely so these tests can
// drive the whole lifecycle — stdout chunks, stderr chunks, exit codes,
// signals, spawn errors — deterministically and without touching the OS.

import { EventEmitter } from 'events';

/** A writable-ish stdin that records what was written. */
class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.written = '';
    this.ended = false;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.written += String(chunk);
    this.ended = true;
  }

  write(chunk) {
    this.written += String(chunk);
    return true;
  }
}

/** A readable-ish stream that only needs `on('data')` and `setEncoding`. */
class FakeReadable extends EventEmitter {
  setEncoding() {}
}

/**
 * One fake child process. Tests call `emitStdout` / `emitStderr` / `close`
 * to script its behaviour.
 */
export class FakeChildProcess extends EventEmitter {
  constructor({ pid = 4242 } = {}) {
    super();
    this.pid = pid;
    this.stdin = new FakeStdin();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.killed = false;
    this.exitCode = null;
    /** @type {string[]} Signals received, in order. */
    this.signals = [];
  }

  emitStdout(text) {
    this.stdout.emit('data', text);
  }

  emitStderr(text) {
    this.stderr.emit('data', text);
  }

  /** Simulate the process exiting. */
  close(code = 0, signal = null) {
    this.exitCode = code;
    this.emit('close', code, signal);
  }

  /** Simulate a spawn-level failure (ENOENT, EACCES…). */
  failSpawn(code = 'ENOENT', message = 'spawn ffmpeg ENOENT') {
    const error = new Error(message);
    error.code = code;
    this.emit('error', error);
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
}

/**
 * Build a fake `spawn` plus the call log and a handle on the children it
 * created.
 *
 * @param {(child: FakeChildProcess, call: Object) => void} [onSpawn] - Called
 *   synchronously with each new child, so a test can script it immediately.
 * @returns {{spawn: Function, calls: Object[], children: FakeChildProcess[]}}
 */
export function makeFakeSpawn(onSpawn) {
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new FakeChildProcess();
    children.push(child);
    if (onSpawn) onSpawn(child, call);
    return child;
  };
  return { spawn, calls, children };
}

/**
 * Fake spawn that plays a scripted response per invocation: each entry is
 * `{ stdout?, stderr?, code?, signal?, spawnError?, delayMs? }`. Entries are
 * consumed in order; the last one repeats.
 *
 * @param {Object[]} script
 * @returns {{spawn: Function, calls: Object[], children: FakeChildProcess[]}}
 */
export function makeScriptedSpawn(script) {
  let index = 0;
  return makeFakeSpawn((child) => {
    const step = script[Math.min(index, script.length - 1)] || {};
    index++;
    // Defer so the runner has attached its listeners first.
    setImmediate(() => {
      if (step.spawnError) {
        child.failSpawn(step.spawnError.code, step.spawnError.message);
        return;
      }
      if (step.stdout) child.emitStdout(step.stdout);
      if (step.stderr) child.emitStderr(step.stderr);
      if (step.hang) return;
      child.close(step.code ?? 0, step.signal ?? null);
    });
  });
}
