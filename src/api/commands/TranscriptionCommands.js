/**
 * @file src/api/commands/TranscriptionCommands.js
 * @description WebSocket commands for the audio → MIDI feature (§24).
 *
 * Registered commands:
 *   - `transcription_capabilities` — is the feature usable at all?
 *   - `transcription_backends`     — engines, their status and their licence
 *   - `transcription_create`       — queue a job from an inline audio payload
 *   - `transcription_status`       — one job, or the whole list
 *   - `transcription_cancel`       — stop a queued or running job
 *   - `transcription_result`       — the rich result of a finished job
 *   - `transcription_delete`       — forget a finished job
 *
 * **Large files do not come through here.** A WebSocket frame is capped at
 * 16 MB and base64 inflates by a third, so `transcription_create` accepts
 * only small inline payloads and tells the client to use
 * `POST /api/transcription` otherwise — the same split the MIDI library
 * already uses (`POST /api/files`). Both paths converge on one service
 * method, so there is a single implementation of "queue a transcription".
 *
 * No handler ever exposes a filesystem path (§24): jobs are addressed by id,
 * and the audio a client sends never becomes a path on our side.
 */
import { NotFoundError, ValidationError } from '../../core/errors/index.js';
import {
  TranscriptionError,
  TRANSCRIPTION_REASONS
} from '../../transcription/TranscriptionError.js';

/**
 * Largest inline (base64) audio payload accepted over WebSocket. Kept well
 * under the 16 MB frame cap: 8 MB of audio is ~10.7 MB of base64, plus the
 * envelope.
 */
export const MAX_INLINE_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * Resolve the transcription service, or fail with the same message the UI
 * shows when the feature is off — never a masked internal error.
 *
 * @param {Object} app
 * @returns {Object}
 * @throws {TranscriptionError}
 */
function requireService(app) {
  const service = app.audioTranscriptionService;
  if (!service) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
      'Audio transcription is not available on this server'
    );
  }
  return service;
}

/**
 * @param {Object} app
 * @returns {Object}
 * @throws {TranscriptionError}
 */
function requireJobManager(app) {
  const jobManager = app.transcriptionJobManager;
  if (!jobManager) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.BACKEND_NOT_INSTALLED,
      'Audio transcription is not available on this server'
    );
  }
  return jobManager;
}

/**
 * Feature-level availability for the UI (§23/§29): whether to show the
 * Convert Audio entry point at all, and what to say when it is unusable.
 *
 * Answers `disabled` rather than failing when the feature is absent — the
 * UI must be able to ask this question on a server that has no engine at
 * all (§44).
 *
 * @param {Object} app
 * @param {{refresh?: boolean}} data - `refresh` re-probes FFmpeg and every
 *   engine instead of trusting the availability cache.
 * @returns {Promise<Object>}
 */
async function transcriptionCapabilities(app, data) {
  const service = app.audioTranscriptionService;
  if (!service) {
    return {
      status: 'disabled',
      detail: 'Audio transcription is not available on this server',
      ffmpeg: { available: false, version: null, detail: null },
      backends: []
    };
  }
  return service.getAvailability({ force: data?.refresh === true });
}

/**
 * Engines with their capabilities and licensing, so the modal can disable
 * the options an engine does not support (§30) and Settings can show the
 * licence before anything is installed (§33).
 *
 * @param {Object} app
 * @param {{refresh?: boolean}} data
 * @returns {Promise<{backends: Object[]}>}
 */
async function transcriptionBackends(app, data) {
  const registry = app.transcriptionBackendRegistry;
  if (!registry) return { backends: [] };
  if (data?.refresh) await registry.refresh();
  else await registry.detectAvailable();
  return { backends: registry.list() };
}

/**
 * Queue a transcription from an inline audio payload.
 *
 * @param {Object} app
 * @param {{filename: string, audio: string, backendId?: string,
 *   quality?: string, preset?: string, folder?: string, options?: Object}} data -
 *   `audio` is base64-encoded bytes.
 * @returns {Promise<{job: Object}>}
 * @throws {ValidationError|TranscriptionError}
 */
async function transcriptionCreate(app, data) {
  const service = requireService(app);

  let buffer;
  try {
    buffer = Buffer.from(String(data.audio), 'base64');
  } catch {
    throw new ValidationError('audio must be base64-encoded bytes', 'audio');
  }
  if (buffer.length === 0) {
    throw new ValidationError('audio is empty', 'audio');
  }
  if (buffer.length > MAX_INLINE_AUDIO_BYTES) {
    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.FILE_TOO_LARGE,
      `Inline audio is limited to ${MAX_INLINE_AUDIO_BYTES / (1024 * 1024)} MB over WebSocket; upload larger files to POST /api/transcription`,
      { sizeBytes: buffer.length, limitBytes: MAX_INLINE_AUDIO_BYTES }
    );
  }

  const job = await service.createJob({
    filename: data.filename,
    buffer,
    backendId: data.backendId ?? null,
    quality: data.quality,
    preset: data.preset,
    folder: data.folder,
    options: data.options || {}
  });
  return { job };
}

/**
 * One job, or every job the manager still remembers.
 *
 * @param {Object} app
 * @param {{jobId?: string}} data
 * @returns {Promise<{job?: Object, jobs?: Object[]}>}
 * @throws {NotFoundError}
 */
async function transcriptionStatus(app, data) {
  const jobManager = requireJobManager(app);
  if (!data?.jobId) return { jobs: jobManager.list() };

  const job = jobManager.get(data.jobId);
  if (!job) throw new NotFoundError('transcription job', data.jobId);
  return { job };
}

/**
 * @param {Object} app
 * @param {{jobId: string}} data
 * @returns {Promise<{cancelled: boolean, job: ?Object}>}
 * @throws {NotFoundError}
 */
async function transcriptionCancel(app, data) {
  const jobManager = requireJobManager(app);
  if (!jobManager.get(data.jobId)) {
    throw new NotFoundError('transcription job', data.jobId);
  }
  const cancelled = jobManager.cancel(data.jobId);
  return { cancelled, job: jobManager.get(data.jobId) };
}

/**
 * The rich result of a finished job — notes, confidence, expression curves
 * (§12). Only the most recent results are retained, so a client that waits
 * too long gets a clear "no longer available" rather than silence.
 *
 * @param {Object} app
 * @param {{jobId: string}} data
 * @returns {Promise<{job: Object, result: Object}>}
 * @throws {NotFoundError}
 */
async function transcriptionResult(app, data) {
  const jobManager = requireJobManager(app);
  const job = jobManager.get(data.jobId);
  if (!job) throw new NotFoundError('transcription job', data.jobId);

  const result = jobManager.getResult(data.jobId);
  if (!result) {
    throw new NotFoundError('transcription result', data.jobId);
  }
  return { job, result };
}

/**
 * @param {Object} app
 * @param {{jobId: string}} data
 * @returns {Promise<{deleted: boolean}>}
 */
async function transcriptionDelete(app, data) {
  const jobManager = requireJobManager(app);
  return { deleted: jobManager.delete(data.jobId) };
}

/**
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app - Application facade.
 * @returns {void}
 */
export function register(registry, app) {
  registry.register('transcription_capabilities', (data) => transcriptionCapabilities(app, data));
  registry.register('transcription_backends', (data) => transcriptionBackends(app, data));
  registry.register('transcription_create', (data) => transcriptionCreate(app, data));
  registry.register('transcription_status', (data) => transcriptionStatus(app, data));
  registry.register('transcription_cancel', (data) => transcriptionCancel(app, data));
  registry.register('transcription_result', (data) => transcriptionResult(app, data));
  registry.register('transcription_delete', (data) => transcriptionDelete(app, data));
}
