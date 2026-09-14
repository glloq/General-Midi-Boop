/**
 * @file src/transcription/backends/BasicPitchBackend.js
 * @description Basic Pitch (Spotify) — the first engine, and the one that
 * proves the architecture end to end (§7).
 *
 * Positioned honestly: **solo / lightweight polyphonic transcription**. It
 * hears several notes at once and does it well on a single instrument or a
 * clean voice; it is NOT a multi-instrument separator, it does not recognise
 * instruments, and it does not detect drums. The metadata below says exactly
 * that, so the UI disables the options it cannot honour instead of pretending.
 *
 * Nothing is bundled and nothing is installed automatically. The engine lives
 * in its own Python virtual environment under
 * `data/transcription/venvs/basic-pitch/`, created by the operator (PR 11
 * automates it); until that directory exists, this backend reports
 * `installable` and GMB carries on without it.
 *
 * Node ↔ Python is a plain subprocess speaking JSON Lines on stdout (§19):
 * no bindings, no long-lived server, nothing to leak. stderr is diagnostics
 * only.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import TranscriptionBackend from '../TranscriptionBackend.js';
import { BACKEND_STATUS, QUALITY_PROFILE } from '../TranscriptionCapabilities.js';
import { ProcessRunner, networkEnv, tail } from '../utils/ProcessRunner.js';
import { resolveTranscriptionConfig, transcriptionPaths } from '../TranscriptionConfig.js';
import { TranscriptionError, TRANSCRIPTION_REASONS } from '../TranscriptionError.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Wire protocol between this file and `runner.py`. Bump on any change (§19). */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Where the runner and its pinned requirements live in the repository. */
export const RUNNER_DIR = path.resolve(__dirname, '../python/basic-pitch');
export const RUNNER_SCRIPT = path.join(RUNNER_DIR, 'runner.py');
export const REQUIREMENTS_FILE = path.join(RUNNER_DIR, 'requirements.txt');

/** Directory name of this engine's virtual environment. */
export const VENV_NAME = 'basic-pitch';

/**
 * Where the environment lives, as told to a CLIENT: relative to the install,
 * matching what `docs/AUDIO_TRANSCRIPTION.md` prints. The absolute path is an
 * accident of this host and stays server-side (§40).
 */
export const RELATIVE_VENV_HINT = `data/transcription/venvs/${VENV_NAME}`;

/**
 * CPython versions the pinned requirements have wheels for.
 *
 * TensorFlow 2.15 ships cp39/cp310/cp311 and nothing newer. Checked before
 * the environment is created, because pip only discovers it after minutes of
 * downloading and then blames "no matching distribution", which sends the
 * operator looking for a network problem they do not have.
 */
export const SUPPORTED_PYTHON = Object.freeze({ min: [3, 9], belowExclusive: [3, 12] });

/** A self-check loads TensorFlow; generous, but not unbounded. */
const SELF_CHECK_TIMEOUT_MS = 120 * 1000;
/** Transcription of a capped-length file on a Pi 4, with headroom. */
const TRANSCRIBE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Per-quality model thresholds. Basic Pitch exposes onset/frame thresholds
 * and a minimum note length; these three presets are what the UI's Fast /
 * Balanced / Maximum actually mean for this engine.
 */
const QUALITY_SETTINGS = Object.freeze({
  [QUALITY_PROFILE.FAST]: { onsetThreshold: 0.6, frameThreshold: 0.4, minNoteLengthMs: 90 },
  [QUALITY_PROFILE.BALANCED]: { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteLengthMs: 58 },
  [QUALITY_PROFILE.MAXIMUM]: { onsetThreshold: 0.4, frameThreshold: 0.25, minNoteLengthMs: 30 }
});

/** Basic Pitch, driven through an isolated Python environment. */
export class BasicPitchBackend extends TranscriptionBackend {
  /**
   * @param {Object} [deps] - Service-container facade. Reads `logger`,
   *   `config` and (for tests) `processRunner`.
   */
  constructor(deps = {}) {
    super(deps);
    this.settings = resolveTranscriptionConfig(deps.config);
    this.paths = transcriptionPaths(this.settings);
    this.runner = deps.processRunner || new ProcessRunner({ logger: this.logger });
    /** @type {?Object} Cached self-check answer. */
    this._selfCheck = null;
  }

  /** @returns {string} Absolute path of this engine's virtual environment. */
  get venvDir() {
    return path.join(this.paths.venvsDir, VENV_NAME);
  }

  /** @returns {string} The Python interpreter inside that environment. */
  get pythonPath() {
    return process.platform === 'win32'
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python');
  }

  /** @override */
  getMetadata() {
    return {
      id: 'basic-pitch',
      name: 'Basic Pitch',
      version: null,
      kind: 'solo-polyphonic',
      description:
        'Lightweight polyphonic transcription. Best on a solo instrument or a clean ' +
        'voice; it does not separate instruments and does not detect drums.',
      capabilities: {
        polyphonic: true,
        multiInstrument: false,
        drums: false,
        pitchBend: true,
        dynamics: true,
        instrumentRecognition: false,
        tempoDetection: false,
        progress: true
      },
      runtime: {
        python: true,
        gpu: false,
        raspberryPiSuitable: true,
        minimumRamMb: 1024
      },
      // Basic Pitch's model expects 22.05 kHz mono; the preprocessor produces
      // exactly that, so the engine never resamples user audio itself.
      audioFormat: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sampleRate: 22050,
        channels: 1
      },
      licensing: {
        codeLicense: 'Apache-2.0',
        modelLicense: 'Apache-2.0',
        commercialUse: true,
        redistribution: true,
        // Permissive, but still not shipped inside this repository: the
        // weights come with the pip package, into the operator's venv.
        bundled: false,
        licenseUrl: 'https://github.com/spotify/basic-pitch/blob/main/LICENSE',
        notice:
          'Basic Pitch is published by Spotify under Apache-2.0, weights included. ' +
          'Installing it downloads Python packages (TensorFlow) into an isolated ' +
          'environment under data/transcription/venvs/.',
        requiresConsent: false
      },
      qualityProfiles: [QUALITY_PROFILE.FAST, QUALITY_PROFILE.BALANCED, QUALITY_PROFILE.MAXIMUM],
      priority: 10
    };
  }

  /**
   * Is the isolated environment there and does it actually import?
   *
   * Never throws — an unusable engine is an answer the Settings page shows,
   * not an exception (§6).
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<Object>}
   * @override
   */
  async checkAvailability({ force = false } = {}) {
    if (!force && this._selfCheck) return this._selfCheck;

    // 1. Is the runner shipped? (A trimmed deployment could have dropped it.)
    try {
      await fs.access(RUNNER_SCRIPT);
    } catch {
      this._selfCheck = {
        status: BACKEND_STATUS.BROKEN,
        detail: 'The Basic Pitch runner script is missing from this installation'
      };
      return this._selfCheck;
    }

    // 2. Is the virtual environment there at all?
    try {
      await fs.access(this.pythonPath);
    } catch {
      // `detail` reaches the browser, so it names the path relative to the
      // install and never the absolute one (§40): the server's directory
      // layout, and the account it runs under, are not the client's
      // business. The operator gets the absolute path in the log below.
      this.logger.debug?.(`Basic Pitch is not installed at ${this.venvDir}`);
      this._selfCheck = {
        status: BACKEND_STATUS.INSTALLABLE,
        detail: `Not installed — install it from Settings, or create the environment in ${RELATIVE_VENV_HINT} (see docs/AUDIO_TRANSCRIPTION.md)`
      };
      return this._selfCheck;
    }

    // 3. Does it import and answer with the protocol we speak?
    let result;
    try {
      result = await this.runner.run(this.pythonPath, [RUNNER_SCRIPT, '--self-check'], {
        timeoutMs: SELF_CHECK_TIMEOUT_MS,
        maxStdoutBytes: 64 * 1024,
        env: pythonEnv(this.venvDir)
      });
    } catch (error) {
      this._selfCheck = { status: BACKEND_STATUS.BROKEN, detail: error.message };
      return this._selfCheck;
    }

    if (result.code !== 0) {
      this._selfCheck = {
        status: BACKEND_STATUS.BROKEN,
        detail: tail(result.stderr, 2) || `self-check exited ${result.code}`
      };
      return this._selfCheck;
    }

    let report;
    try {
      report = JSON.parse(lastJsonLine(result.stdout));
    } catch {
      this._selfCheck = {
        status: BACKEND_STATUS.BROKEN,
        detail: 'The self-check did not answer with the expected protocol'
      };
      return this._selfCheck;
    }

    if (report.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
      this._selfCheck = {
        status: BACKEND_STATUS.BROKEN,
        detail:
          `Runner protocol ${report.protocolVersion} does not match the expected ` +
          `${RUNNER_PROTOCOL_VERSION} — reinstall the environment`
      };
      return this._selfCheck;
    }
    if (report.ok !== true) {
      this._selfCheck = {
        status: BACKEND_STATUS.BROKEN,
        detail: report.error || 'The environment is installed but Basic Pitch does not import'
      };
      return this._selfCheck;
    }

    this._selfCheck = {
      status: BACKEND_STATUS.AVAILABLE,
      detail: null,
      version: typeof report.version === 'string' ? report.version : null,
      modelVersion: typeof report.modelVersion === 'string' ? report.modelVersion : null
    };
    return this._selfCheck;
  }

  /**
   * Run the model over one normalised WAV.
   *
   * @param {string} inputPath - Absolute path to the canonical audio.
   * @param {Object} [options] - `quality` and the per-job toggles.
   * @param {Object} [context] - `{signal, onProgress, workDir, logger}`.
   * @returns {Promise<Object>} Raw result, for `createTranscriptionResult`.
   * @override
   */
  async transcribe(inputPath, options = {}, context = {}) {
    const availability = await this.checkAvailability();
    if (availability.status !== BACKEND_STATUS.AVAILABLE) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        availability.detail || 'Basic Pitch is not installed',
        {},
        { backendId: 'basic-pitch' }
      );
    }

    const workDir = context.workDir || path.dirname(inputPath);
    const optionsPath = path.join(workDir, 'basic-pitch-options.json');
    const outputPath = path.join(workDir, 'basic-pitch-result.json');
    const quality = QUALITY_SETTINGS[options.quality] || QUALITY_SETTINGS[QUALITY_PROFILE.BALANCED];

    // Options travel through a FILE, not the command line: a threshold is
    // harmless but the pattern keeps user-influenced values out of argv for
    // good (§40).
    await fs.writeFile(
      optionsPath,
      JSON.stringify({
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        onsetThreshold: quality.onsetThreshold,
        frameThreshold: quality.frameThreshold,
        minNoteLengthMs: quality.minNoteLengthMs,
        // Basic Pitch can emit per-note pitch bends; ask for them only when
        // the job wants them, since they cost events downstream.
        includePitchBends: options.preservePitchBends !== false,
        sampleRate: 22050
      }),
      'utf8'
    );

    const result = await this.runner.run(
      this.pythonPath,
      [RUNNER_SCRIPT, '--input', inputPath, '--output', outputPath, '--options', optionsPath],
      {
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        signal: context.signal,
        env: pythonEnv(this.venvDir),
        maxStdoutBytes: 256 * 1024,
        onStdoutLine: (line) => this._handleRunnerLine(line, context),
        reasonOnTimeout: TRANSCRIPTION_REASONS.BACKEND_TIMEOUT
      }
    );

    if (result.code !== 0) {
      // A Python MemoryError / OOM kill reads very differently to a user than
      // "the engine failed", and it is the failure a Pi actually hits.
      const stderr = result.stderr || '';
      const outOfMemory = /MemoryError|Killed|Cannot allocate memory|std::bad_alloc/i.test(stderr);
      throw new TranscriptionError(
        outOfMemory ? TRANSCRIPTION_REASONS.OUT_OF_MEMORY : TRANSCRIPTION_REASONS.BACKEND_FAILED,
        outOfMemory
          ? 'The engine ran out of memory — try a shorter file or a faster quality setting'
          : `Basic Pitch failed: ${tail(stderr, 3) || `exit code ${result.code}`}`,
        { exitCode: result.code },
        { backendId: 'basic-pitch' }
      );
    }

    let raw;
    try {
      raw = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    } catch (error) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        'Basic Pitch produced no readable result',
        {},
        { backendId: 'basic-pitch', cause: error }
      );
    }

    return normalizeRunnerOutput(raw, availability);
  }

  /**
   * One JSON Lines frame from the runner. Unparseable lines are ignored: a
   * stray print from a library must not break a job (§19).
   *
   * @param {string} line
   * @param {Object} context
   * @returns {void}
   * @private
   */
  _handleRunnerLine(line, context) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (frame.type === 'progress') {
      context.onProgress?.({
        stage: typeof frame.stage === 'string' ? frame.stage : 'transcribing',
        progress: Number.isFinite(frame.progress) ? frame.progress : null
      });
    } else if (frame.type === 'log' && typeof frame.message === 'string') {
      this.logger.debug?.(`basic-pitch: ${frame.message}`);
    }
  }

  /** @override */
  supportsInstall() {
    return true;
  }

  /**
   * Rough size of the installed environment — TensorFlow is the bulk of it.
   * The installer refuses to start when the disk cannot hold this plus
   * headroom (§34).
   * @returns {number}
   */
  get estimatedInstallBytes() {
    return 900 * 1024 * 1024;
  }

  /** @returns {string} What `uninstall()` removes and disk checks target. */
  get installRoot() {
    return this.venvDir;
  }

  /**
   * Create the isolated environment and install the pinned requirements.
   *
   * Every step is a subprocess with a timeout and a cancellation signal; a
   * failure at any point leaves the caller to roll back (the installer does,
   * by calling {@link uninstall}).
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [context]
   * @returns {Promise<Object>} An availability report.
   * @override
   */
  async install(context = {}) {
    const { signal, onProgress } = context;
    const report = (stage, progress = null) => onProgress?.({ stage, progress });

    // 1. Is there a Python to build the environment with?
    report('checking');
    const python = await this._findSystemPython(signal);

    // 2. The environment itself. A leftover from a failed attempt is removed
    //    first: `venv` on top of a broken tree produces a subtler mess.
    report('creating_environment');
    await fs.rm(this.venvDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(this.venvDir), { recursive: true });

    const created = await this.runner.run(python, ['-m', 'venv', this.venvDir], {
      timeoutMs: 5 * 60 * 1000,
      signal
    });
    if (created.code !== 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        `Could not create the Python environment: ${tail(created.stderr, 2) || `exit ${created.code}`}`,
        {},
        { backendId: 'basic-pitch' }
      );
    }

    // 3. The packages. pip gives no usable progress fraction, so the stage
    //    is reported and the bar stays indeterminate rather than invented.
    report('downloading');
    const pip = path.join(
      path.dirname(this.pythonPath),
      process.platform === 'win32' ? 'pip.exe' : 'pip'
    );
    const installed = await this.runner.run(
      pip,
      ['install', '--no-input', '--disable-pip-version-check', '-r', REQUIREMENTS_FILE],
      {
        // TensorFlow on a Pi is a long download and a longer install.
        timeoutMs: 60 * 60 * 1000,
        signal,
        // The one subprocess in this file that is SUPPOSED to reach the
        // network, so the one that gets the proxy and CA settings. The
        // transcription runner below deliberately does not: it reads a local
        // file and a local model.
        env: { ...pythonEnv(this.venvDir), ...networkEnv() },
        maxStdoutBytes: 512 * 1024,
        onStdoutLine: (line) => {
          const match = /^(Collecting|Downloading|Installing collected packages)\s*(.*)$/.exec(
            line.trim()
          );
          if (match) this.logger.debug?.(`basic-pitch install: ${match[0]}`);
        }
      }
    );
    if (installed.code !== 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        `Installing the Python packages failed: ${tail(installed.stderr, 3) || `exit ${installed.code}`}`,
        { exitCode: installed.code },
        { backendId: 'basic-pitch' }
      );
    }

    // 4. Prove it works before claiming it does.
    report('verifying');
    const availability = await this.checkAvailability({ force: true });
    if (availability.status !== BACKEND_STATUS.AVAILABLE) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        availability.detail || 'The environment installed but does not import Basic Pitch',
        {},
        { backendId: 'basic-pitch' }
      );
    }
    return availability;
  }

  /**
   * Remove the environment. Idempotent, and it never touches anything
   * outside `data/transcription/venvs/basic-pitch/`.
   *
   * @param {Object} [_context]
   * @returns {Promise<void>}
   * @override
   */
  async uninstall(_context = {}) {
    await fs.rm(this.venvDir, { recursive: true, force: true });
    this._selfCheck = null;
  }

  /**
   * Find a Python that can build a virtual environment.
   *
   * @param {?AbortSignal} signal
   * @returns {Promise<string>}
   * @throws {TranscriptionError} When there is none.
   * @private
   */
  async _findSystemPython(signal) {
    /** @type {string[]} Interpreters found but too new or too old, for the error. */
    const rejected = [];

    for (const candidate of ['python3', 'python']) {
      let result;
      try {
        result = await this.runner.run(candidate, ['--version'], { timeoutMs: 15000, signal });
      } catch {
        continue; // not on PATH — try the next name
      }
      if (result.code !== 0) continue;

      // `python --version` writes to stdout on 3.4+ and to stderr on 2.x;
      // read both rather than assume which Python answered.
      const version = parsePythonVersion(`${result.stdout} ${result.stderr}`);
      if (!version) continue;
      if (isSupportedPython(version)) return candidate;
      rejected.push(`${candidate} is ${version.join('.')}`);
    }

    const range = `${SUPPORTED_PYTHON.min.join('.')} – ${SUPPORTED_PYTHON.belowExclusive[0]}.${SUPPORTED_PYTHON.belowExclusive[1] - 1}`;
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
      rejected.length > 0
        ? `This engine needs Python ${range} (${rejected.join(', ')}). Install one and make it available as "python3".`
        : `Python ${range} is required to install this engine, and was not found`,
      { supported: range, found: rejected },
      { backendId: 'basic-pitch' }
    );
  }

  /** @override */
  destroy() {
    this._selfCheck = null;
  }
}

/**
 * `[major, minor]` from whatever `python --version` printed.
 *
 * @param {string} output
 * @returns {?number[]} Null when the text holds no version.
 */
export function parsePythonVersion(output) {
  const match = /Python\s+(\d+)\.(\d+)/i.exec(String(output || ''));
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Is this interpreter one the pinned wheels exist for?
 *
 * @param {?number[]} version - `[major, minor]`.
 * @returns {boolean}
 */
export function isSupportedPython(version) {
  if (!Array.isArray(version) || version.length < 2) return false;
  const [major, minor] = version;
  const [minMajor, minMinor] = SUPPORTED_PYTHON.min;
  const [maxMajor, maxMinor] = SUPPORTED_PYTHON.belowExclusive;
  if (major < minMajor || (major === minMajor && minor < minMinor)) return false;
  if (major > maxMajor || (major === maxMajor && minor >= maxMinor)) return false;
  return true;
}

/**
 * Environment for the child: the venv's own bin directory first, and the
 * knobs that keep TensorFlow from grabbing every core on a 4-core Pi.
 *
 * @param {string} venvDir
 * @returns {Object<string,string>}
 */
export function pythonEnv(venvDir) {
  const binDir =
    process.platform === 'win32' ? path.join(venvDir, 'Scripts') : path.join(venvDir, 'bin');
  return {
    VIRTUAL_ENV: venvDir,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    // Unbuffered stdout, or the JSON Lines progress arrives all at once at
    // the end and the progress bar is a lie.
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    // Keep TensorFlow quiet and modest: the Pi has other work to do.
    TF_CPP_MIN_LOG_LEVEL: '3',
    OMP_NUM_THREADS: '2',
    TF_NUM_INTRAOP_THREADS: '2',
    TF_NUM_INTEROP_THREADS: '1'
  };
}

/**
 * Map the runner's output onto the raw shape
 * `createTranscriptionResult()` expects.
 *
 * Basic Pitch knows nothing about instruments, tempo or drums, so those
 * fields stay empty rather than being filled with plausible defaults
 * (§11/§15).
 *
 * @param {Object} raw - Parsed `result.json`.
 * @param {Object} availability - The self-check answer (for the version).
 * @returns {Object}
 */
export function normalizeRunnerOutput(raw, availability = {}) {
  const notes = Array.isArray(raw?.notes) ? raw.notes : [];
  return {
    source: {
      duration: Number.isFinite(raw?.duration) ? raw.duration : null,
      sampleRate: Number.isFinite(raw?.sampleRate) ? raw.sampleRate : null
    },
    backend: {
      id: 'basic-pitch',
      version: availability.version ?? null,
      protocolVersion: RUNNER_PROTOCOL_VERSION
    },
    // No tempo detection in this engine: an empty map is the honest answer.
    tempoMap: [],
    timeSignatures: [],
    tracks: notes.length
      ? [
          {
            id: 'track-1',
            name: null,
            instrument: {
              // The engine does not identify the instrument. GMB's own
              // auto-assignment is better at this than a guess would be.
              family: null,
              label: null,
              confidence: null,
              gmProgram: null,
              isDrums: false
            },
            notes: notes.map((note) => ({
              start: note.start,
              end: note.end,
              pitch: note.pitch,
              velocity: note.velocity,
              confidence: Number.isFinite(note.confidence) ? note.confidence : null,
              expression: buildExpression(note)
            }))
          }
        ]
      : [],
    warnings: Array.isArray(raw?.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : []
  };
}

/**
 * Turn the runner's `pitchBends` (semitone offsets sampled over the note)
 * into the pivot format's expression curve.
 *
 * @param {Object} note
 * @returns {?Object}
 */
function buildExpression(note) {
  const bends = Array.isArray(note?.pitchBends) ? note.pitchBends : [];
  if (bends.length === 0) return null;
  const span = note.end - note.start;
  if (!(span > 0)) return null;
  const step = span / bends.length;
  return {
    pitchCurve: bends
      .map((value, index) => ({ t: note.start + index * step, value }))
      .filter((point) => Number.isFinite(point.value)),
    amplitudeCurve: []
  };
}

/**
 * The last complete JSON object printed on stdout — the runner ends with its
 * answer, and anything a library printed before it is noise.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * Factory used by the registry's auto-discovery.
 * @param {Object} deps
 * @returns {BasicPitchBackend}
 */
export function createBackend(deps) {
  return new BasicPitchBackend(deps);
}

export default BasicPitchBackend;
