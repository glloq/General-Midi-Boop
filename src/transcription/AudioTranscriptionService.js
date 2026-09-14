/**
 * @file src/transcription/AudioTranscriptionService.js
 * @description The orchestrator: audio in, a row in the GMB library out.
 *
 * It is deliberately thin. Every stage already exists as its own testable
 * unit, and the last one is not ours at all:
 *
 *   preprocess → backend → post-process → encode → **FileManager.handleUpload()**
 *
 * That final call is the whole boundary of the feature (§3/§26). Hashing,
 * the blob store, MIDI parsing, channel analysis, the tempo map, the
 * database transaction, the `file_uploaded` event and the library refresh
 * all stay where they have always been. Nothing here reimplements them, and
 * a transcribed file is indistinguishable from an uploaded one afterwards —
 * which is why it can be opened in the editor and routed to instruments with
 * no extra work.
 */
import fs from 'fs/promises';
import path from 'path';
import { AudioPreprocessor } from './AudioPreprocessor.js';
import { MidiPostProcessor } from './MidiPostProcessor.js';
import { MidiEncoder } from './MidiEncoder.js';
import { TempFileManager } from './utils/TempFileManager.js';
import { AudioProbe } from './utils/AudioProbe.js';
import { ProcessRunner } from './utils/ProcessRunner.js';
import { JOB_STATUS } from './TranscriptionJobManager.js';
import { createTranscriptionResult, summarizeTranscriptionResult } from './TranscriptionResult.js';
import { resolveTranscriptionConfig, transcriptionPaths } from './TranscriptionConfig.js';
import { QUALITY_PROFILE, HARDWARE_PROFILE } from './TranscriptionCapabilities.js';
import { TranscriptionError, TRANSCRIPTION_REASONS } from './TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Suffix added to the library file name so a transcription is recognisable. */
export const TRANSCRIBED_SUFFIX = ' [Transcribed]';

/**
 * File names inside a job workspace. The generated MIDI is deliberately
 * absent: it goes straight from a Buffer to `handleUpload()`, so it never
 * touches the scratch disk at all.
 */
const WORKSPACE_FILES = Object.freeze({
  source: 'source',
  audio: 'audio.wav'
});

/**
 * Matches C0 control characters, which never belong in a file name. The
 * control characters are the point of the pattern, hence the disable.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Orchestrates one audio → MIDI conversion, end to end. */
export class AudioTranscriptionService {
  /**
   * @param {Object} [deps] - Service-container facade. `fileManager`,
   *   `transcriptionBackendRegistry`, `transcriptionJobManager`, `logger`,
   *   `eventBus` and `config` are resolved lazily so registration order in
   *   `Application.initialize()` cannot freeze an `undefined`.
   */
  constructor(deps = {}) {
    this._deps = deps;
    this.logger = deps.logger || NULL_LOGGER;
    this.settings = resolveTranscriptionConfig(deps.config);
    this.paths = transcriptionPaths(this.settings);

    this.processRunner = deps.processRunner || new ProcessRunner({ logger: this.logger });
    this.audioProbe =
      deps.audioProbe || new AudioProbe({ logger: this.logger, processRunner: this.processRunner });
    this.preprocessor =
      deps.audioPreprocessor ||
      new AudioPreprocessor({
        logger: this.logger,
        processRunner: this.processRunner,
        audioProbe: this.audioProbe,
        settings: this.settings
      });
    this.postProcessor = deps.midiPostProcessor || new MidiPostProcessor({ logger: this.logger });
    this.encoder = deps.midiEncoder || new MidiEncoder({ logger: this.logger });
    this.tempFiles =
      deps.tempFileManager ||
      new TempFileManager({
        root: this.paths.tmpDir,
        logger: this.logger,
        keepFiles: this.settings.keepTempFiles,
        maxTotalBytes: this.settings.maxTempDiskBytes
      });
  }

  /** @returns {?Object} Late-bound: registered after this service. */
  get registry() {
    return this._deps.transcriptionBackendRegistry ?? null;
  }

  /** @returns {?Object} Late-bound. */
  get jobManager() {
    return this._deps.transcriptionJobManager ?? null;
  }

  /** @returns {?Object} Late-bound. */
  get fileManager() {
    return this._deps.fileManager ?? null;
  }

  /**
   * Sweep scratch directories left by a previous run. Called once at
   * startup (§21).
   * @returns {Promise<{removed: number, reclaimedBytes: number}>}
   */
  async cleanupStaleWorkspaces() {
    return this.tempFiles.cleanupStale();
  }

  /**
   * Feature-level availability, for `/api/capabilities` and the UI (§23).
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<Object>}
   */
  async getAvailability({ force = false } = {}) {
    if (!this.settings.enabled) {
      return {
        status: 'disabled',
        detail: 'Audio transcription is disabled in the configuration',
        ffmpeg: { available: false, version: null, detail: null },
        backends: []
      };
    }

    const tooling = await this.audioProbe.checkTooling({ force });
    const available = this.registry ? await this.registry.detectAvailable({ force }) : [];
    const all = this.registry ? this.registry.list() : [];

    let status;
    let detail = null;
    if (!tooling.available) {
      status = 'degraded';
      detail = tooling.detail;
    } else if (available.length === 0) {
      status = 'degraded';
      detail =
        all.length === 0
          ? 'No transcription engine is installed'
          : 'No installed transcription engine is ready';
    } else {
      status = 'ready';
    }

    return {
      status,
      detail,
      ffmpeg: {
        available: tooling.available,
        version: tooling.ffmpeg?.version ?? null,
        detail: tooling.detail
      },
      backends: all.map((backend) => ({
        id: backend.id,
        name: backend.name,
        status: backend.status,
        available: backend.available,
        detail: backend.detail
      }))
    };
  }

  /**
   * Queue a transcription. Returns as soon as the job exists — the work runs
   * behind the job manager and the client follows it through events (§17).
   *
   * @param {Object} request
   * @param {string} request.filename - Original file name.
   * @param {Buffer} [request.buffer] - Audio bytes (WS/HTTP upload).
   * @param {string} [request.sourcePath] - Already-on-disk audio; used
   *   instead of `buffer` and never taken from client input.
   * @param {?string} [request.backendId] - `null` = auto (§36).
   * @param {string} [request.quality]
   * @param {string} [request.preset] - Post-processing preset.
   * @param {Object} [request.options] - Feature toggles (drums, pitch bend…).
   * @param {string} [request.folder='/'] - Library folder for the import.
   * @returns {Promise<Object>} The queued job record.
   */
  async createJob(request) {
    if (!this.settings.enabled) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        'Audio transcription is disabled in the configuration'
      );
    }
    if (!this.jobManager) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_FAILED,
        'The transcription job manager is not available'
      );
    }

    const filename = String(request?.filename || 'audio');
    const buffer = request?.buffer ?? null;
    const sourcePath = request?.sourcePath ?? null;
    if (!Buffer.isBuffer(buffer) && !sourcePath) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'No audio was provided'
      );
    }

    // Cheap rejections happen HERE, before a job exists: telling the user
    // "wrong format" through a failed job would be a worse experience than
    // an immediate error on the command that created it.
    this.preprocessor.validateDescriptor({
      filename,
      sizeBytes: buffer ? buffer.length : 0
    });

    const selection = await this._selectBackend(request);
    const folder = typeof request?.folder === 'string' ? request.folder : '/';
    const quality = request?.quality ?? QUALITY_PROFILE.BALANCED;
    const preset = request?.preset ?? this.settings.postProcessingPreset;
    const options = request?.options || {};

    this.logger.info(
      `Transcription requested: ${filename} → backend "${selection.metadata.id}" (${selection.reason})`
    );

    return this.jobManager.create({
      sourceName: filename,
      backendId: selection.metadata.id,
      options: { quality, preset, ...options },
      run: (context) =>
        this._runJob(context, {
          filename,
          buffer,
          sourcePath,
          folder,
          backendId: selection.metadata.id,
          quality,
          preset,
          options
        })
    });
  }

  /**
   * Choose the engine for a request, or explain why none fits.
   *
   * @param {Object} request
   * @returns {Promise<{backend: Object, metadata: Object, reason: string}>}
   * @throws {TranscriptionError} `BACKEND_NOT_INSTALLED`.
   * @private
   */
  async _selectBackend(request) {
    if (!this.registry) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        'No transcription engine is available'
      );
    }
    await this.registry.detectAvailable();

    const selection = this.registry.getRecommendedBackend({
      backendId: request?.backendId ?? null,
      quality: request?.quality ?? QUALITY_PROFILE.BALANCED,
      requireDrums: request?.options?.detectDrums === true,
      requireMultiInstrument: request?.options?.detectInstruments === true,
      hardwareProfile: request?.hardwareProfile ?? HARDWARE_PROFILE.STANDARD
    });

    if (!selection) {
      const known = this.registry.list();
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
        request?.backendId
          ? `The "${request.backendId}" engine is not available`
          : known.length === 0
            ? 'No transcription engine is installed'
            : 'No installed engine can handle this request',
        { requested: request?.backendId ?? null, known: known.map((b) => b.id) }
      );
    }
    return selection;
  }

  /**
   * The pipeline itself. Each stage reports through the job context, and the
   * workspace is removed whatever happens.
   *
   * @param {Object} context - Job context from the job manager.
   * @param {Object} job
   * @returns {Promise<{result: Object, summary: Object, fileId: ?number, warnings: string[]}>}
   * @private
   */
  async _runJob(context, job) {
    const workspace = await this.tempFiles.createJobDir(context.jobId);
    const warnings = [];

    try {
      const backend = this.registry?.get(job.backendId);
      if (!backend) {
        throw new TranscriptionError(
          TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
          `The "${job.backendId}" engine is no longer available`,
          { backendId: job.backendId }
        );
      }
      const metadata = backend.getMetadata();

      // 1. Materialise the source, then normalise it.
      const sourcePath = await this._materializeSource(workspace, job);
      context.setStage(JOB_STATUS.PREPROCESSING, null);
      const prepared = await this.preprocessor.prepare({
        inputPath: sourcePath,
        outputPath: workspace.file(WORKSPACE_FILES.audio),
        filename: job.filename,
        targetFormat: metadata.audioFormat,
        signal: context.signal,
        onProgress: ({ progress }) => context.setProgress(progress)
      });

      // 2. The engine.
      context.setStage(JOB_STATUS.TRANSCRIBING, null);
      const raw = await backend.transcribe(
        prepared.path,
        { quality: job.quality, duration: prepared.duration, ...job.options },
        {
          signal: context.signal,
          workDir: workspace.dir,
          logger: this.logger,
          onProgress: ({ progress }) => context.setProgress(progress)
        }
      );
      throwIfAborted(context.signal);

      const result = createTranscriptionResult(
        {
          ...raw,
          source: {
            filename: job.filename,
            duration: prepared.duration,
            sampleRate: prepared.format.sampleRate,
            channels: prepared.format.channels,
            ...(raw?.source || {})
          },
          backend: { id: job.backendId, version: metadata.version, ...(raw?.backend || {}) }
        },
        { backendId: job.backendId }
      );

      // 3. Clean up musically.
      context.setStage(JOB_STATUS.POSTPROCESSING, null);
      const processed = this.postProcessor.process(result, {
        preset: job.preset,
        options: job.options.postProcessing || {}
      });
      throwIfAborted(context.signal);

      // 4. Encode.
      context.setStage(JOB_STATUS.GENERATING_MIDI, null);
      const encoded = this.encoder.encode(processed.result, {
        emitPitchBend: job.options.preservePitchBends !== false,
        emitExpression: job.options.preserveDynamics !== false
      });
      if (encoded.stats.unmappedDrumNotes > 0) {
        warnings.push(`${encoded.stats.unmappedDrumNotes} percussion hits could not be mapped`);
      }
      if (encoded.stats.reusedChannels > 0) {
        warnings.push(
          `${encoded.stats.reusedChannels} tracks share a MIDI channel (more instruments than channels)`
        );
      }
      throwIfAborted(context.signal);

      // 5. Hand over to the existing library pipeline. Everything past this
      //    line is FileManager's job, exactly as for a manual upload.
      context.setStage(JOB_STATUS.IMPORTING, null);
      const imported = await this._importToLibrary(encoded.buffer, job, workspace);

      const summary = {
        ...summarizeTranscriptionResult(processed.result),
        backendId: job.backendId,
        preset: processed.preset,
        midiBytes: encoded.buffer.length,
        channels: encoded.channelMap,
        fileId: imported?.fileId ?? null,
        filename: imported?.filename ?? null,
        duplicate: imported?.status === 'duplicate'
      };

      return {
        result: processed.result,
        summary,
        fileId: imported?.fileId ?? null,
        warnings: [...warnings, ...processed.result.warnings]
      };
    } finally {
      await workspace.cleanup();
    }
  }

  /**
   * Write the uploaded bytes into the workspace, or point at an existing
   * file. The name is fixed (`source`) — a user-supplied name never becomes
   * a path (§40).
   *
   * @param {Object} workspace
   * @param {Object} job
   * @returns {Promise<string>}
   * @private
   */
  async _materializeSource(workspace, job) {
    if (job.sourcePath) return job.sourcePath;
    const extension = path
      .extname(job.filename)
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, '');
    const target = workspace.file(`${WORKSPACE_FILES.source}${extension}`);
    await fs.writeFile(target, job.buffer);
    return target;
  }

  /**
   * Import the generated MIDI through `FileManager.handleUpload()` (§26),
   * then optionally keep the source audio (§28).
   *
   * @param {Buffer} buffer
   * @param {Object} job
   * @param {Object} workspace
   * @returns {Promise<?Object>} FileManager's own result.
   * @private
   */
  async _importToLibrary(buffer, job, workspace) {
    if (!this.settings.autoImportToLibrary) return null;
    const fileManager = this.fileManager;
    if (!fileManager) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.MIDI_IMPORT_FAILED,
        'The file library is not available'
      );
    }

    const desiredName = buildLibraryFilename(job.filename);
    let imported;
    try {
      imported = await fileManager.handleUpload(desiredName, buffer, { folder: job.folder });
    } catch (error) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.MIDI_IMPORT_FAILED,
        `Could not add the transcription to the library: ${error.message}`,
        {},
        { cause: error instanceof Error ? error : undefined }
      );
    }

    if (this.settings.keepOriginalAudio) {
      await this._keepSourceAudio(job, workspace, imported);
    }
    return imported;
  }

  /**
   * Move the source audio out of the workspace when the operator asked to
   * keep it — to a plain directory, never into SQLite (§28).
   *
   * @param {Object} job
   * @param {Object} workspace
   * @param {Object} imported
   * @returns {Promise<void>}
   * @private
   */
  async _keepSourceAudio(job, workspace, imported) {
    try {
      const extension = path.extname(job.filename).toLowerCase() || '.audio';
      const sourcePath = job.sourcePath || workspace.file(`${WORKSPACE_FILES.source}${extension}`);
      await fs.mkdir(this.paths.audioDir, { recursive: true });
      const target = path.join(
        this.paths.audioDir,
        `${imported?.fileId ?? Date.now()}${extension}`
      );
      await fs.copyFile(sourcePath, target);
      this.logger.info(`Transcription: kept source audio at ${target}`);
    } catch (error) {
      // Keeping the audio is a convenience; failing it must not fail a job
      // whose MIDI is already in the library.
      this.logger.warn(`Transcription: could not keep the source audio: ${error.message}`);
    }
  }
}

/**
 * Library file name for a transcription (§26): the original stem, the
 * `[Transcribed]` marker, and a `.mid` extension. Collisions are left to
 * FileManager, which already de-duplicates on content hash.
 *
 * @param {string} filename - Original audio file name.
 * @returns {string}
 */
export function buildLibraryFilename(filename) {
  const stem = path
    .basename(String(filename || 'audio'))
    .replace(/\.[^.]+$/, '')
    // Keep it a plain file name: no separators, no control characters.
    .replace(/[/\\]+/g, '-')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
  const safeStem = stem.length > 0 ? stem.slice(0, 120) : 'audio';
  return `${safeStem}${TRANSCRIBED_SUFFIX}.mid`;
}

/**
 * @param {AbortSignal} signal
 * @returns {void}
 * @throws {TranscriptionError} When the job was cancelled.
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw TranscriptionError.cancelled();
}

export default AudioTranscriptionService;
