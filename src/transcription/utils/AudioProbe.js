/**
 * @file src/transcription/utils/AudioProbe.js
 * @description `ffprobe` wrapper: what is actually inside a file the user
 * uploaded, and whether the FFmpeg tooling is installed at all.
 *
 * The extension a user gives us is a hint, not a fact (§40 — MIME spoofing).
 * Everything the pipeline decides — duration limit, channel count, whether
 * there is any audio at all — comes from here, never from the filename.
 */
import { ProcessRunner, isMissingBinaryError, tail } from './ProcessRunner.js';
import { TranscriptionError, TRANSCRIPTION_REASONS } from '../TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Probing must be quick; a file that takes longer is pathological. */
const PROBE_TIMEOUT_MS = 30 * 1000;
/** ffprobe emits a small JSON document; cap it well below that. */
const PROBE_MAX_STDOUT = 1 * 1024 * 1024;

/**
 * @typedef {Object} AudioProbeResult
 * @property {number} duration - Seconds. 0 when the container has no usable
 *   duration (a stream, a truncated file).
 * @property {?number} sampleRate - Hz of the selected audio stream.
 * @property {?number} channels
 * @property {?string} codec - e.g. `mp3`, `flac`, `aac`.
 * @property {?string} formatName - Container, e.g. `mov,mp4,m4a,3gp,3g2,mj2`.
 * @property {?number} bitRate - bits/s, when the container reports one.
 * @property {number} sizeBytes
 * @property {boolean} hasAudio
 * @property {boolean} hasVideo - True for a video file we will extract from.
 * @property {number} audioStreams
 */

/** Runs `ffprobe` / checks for `ffmpeg`. */
export class AudioProbe {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger]
   * @param {ProcessRunner} [deps.processRunner]
   * @param {string} [deps.ffprobePath='ffprobe']
   * @param {string} [deps.ffmpegPath='ffmpeg']
   */
  constructor(deps = {}) {
    this.logger = deps.logger || NULL_LOGGER;
    this.runner = deps.processRunner || new ProcessRunner({ logger: this.logger });
    this.ffprobePath = deps.ffprobePath || 'ffprobe';
    this.ffmpegPath = deps.ffmpegPath || 'ffmpeg';
    /** @type {?{ffmpeg: Object, ffprobe: Object, checkedAt: number}} */
    this._toolingCache = null;
  }

  /**
   * Are `ffmpeg` and `ffprobe` installed and runnable? Never throws: a
   * missing binary is the answer, not an exception (it drives the health
   * report and the "install FFmpeg" hint in the UI).
   *
   * @param {{force?: boolean, cacheMs?: number}} [options]
   * @returns {Promise<{available: boolean, ffmpeg: {available: boolean, version: ?string},
   *   ffprobe: {available: boolean, version: ?string}, detail: ?string}>}
   */
  async checkTooling({ force = false, cacheMs = 60000 } = {}) {
    if (!force && this._toolingCache && Date.now() - this._toolingCache.checkedAt < cacheMs) {
      return this._toolingCache.value;
    }
    const [ffmpeg, ffprobe] = await Promise.all([
      this._checkBinary(this.ffmpegPath),
      this._checkBinary(this.ffprobePath)
    ]);
    const available = ffmpeg.available && ffprobe.available;
    const value = {
      available,
      ffmpeg,
      ffprobe,
      detail: available
        ? null
        : 'FFmpeg tooling not found on PATH — audio conversion is unavailable'
    };
    this._toolingCache = { value, checkedAt: Date.now() };
    return value;
  }

  /**
   * The last tooling answer, without probing. Used by the synchronous health
   * snapshot; `null` when nothing has been probed yet, which callers must
   * report as "unknown" rather than as "missing".
   *
   * @returns {?Object}
   */
  getCachedTooling() {
    return this._toolingCache ? this._toolingCache.value : null;
  }

  /**
   * Inspect a media file.
   *
   * @param {string} filePath - Absolute path.
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   * @returns {Promise<AudioProbeResult>}
   * @throws {TranscriptionError} `FFMPEG_MISSING` when ffprobe is absent,
   *   `UNSUPPORTED_FORMAT` when the file is not decodable media.
   */
  async probe(filePath, options = {}) {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      // `-i` keeps a filename starting with a dash from being read as a flag.
      '-i',
      filePath
    ];

    let result;
    try {
      result = await this.runner.run(this.ffprobePath, args, {
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        signal: options.signal,
        maxStdoutBytes: PROBE_MAX_STDOUT
      });
    } catch (error) {
      if (isMissingBinaryError(error)) {
        throw new TranscriptionError(
          TRANSCRIPTION_REASONS.FFMPEG_MISSING,
          'ffprobe is not installed — install FFmpeg to convert audio files',
          { command: this.ffprobePath }
        );
      }
      throw error;
    }

    if (result.code !== 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'This file could not be read as audio or video',
        { exitCode: result.code, detail: tail(result.stderr, 3) }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'Could not interpret the media information for this file',
        {},
        { cause: error }
      );
    }

    return summarizeProbe(parsed);
  }

  /**
   * @param {string} binary
   * @returns {Promise<{available: boolean, version: ?string, detail: ?string}>}
   * @private
   */
  async _checkBinary(binary) {
    try {
      const result = await this.runner.run(binary, ['-version'], {
        timeoutMs: 10000,
        maxStdoutBytes: 64 * 1024
      });
      if (result.code !== 0) {
        return { available: false, version: null, detail: `${binary} exited ${result.code}` };
      }
      return { available: true, version: parseVersion(result.stdout), detail: null };
    } catch (error) {
      return { available: false, version: null, detail: error.message };
    }
  }
}

/**
 * Turn ffprobe's JSON into the flat record the pipeline uses. Picks the
 * first audio stream: multi-language tracks are out of scope, and picking
 * "the first" is predictable.
 *
 * @param {Object} parsed - Parsed ffprobe output.
 * @returns {AudioProbeResult}
 */
export function summarizeProbe(parsed) {
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const format = parsed?.format && typeof parsed.format === 'object' ? parsed.format : {};
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audio = audioStreams[0] || null;
  const hasVideo = streams.some(
    // A cover-art JPEG inside an MP3 is a video stream on paper; it is not a
    // video file, and treating it as one would send us down the extraction
    // path for no reason.
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1
  );

  const duration = firstFinite([Number(format.duration), audio ? Number(audio.duration) : NaN, 0]);

  return {
    duration: duration > 0 ? duration : 0,
    sampleRate:
      audio && Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
    channels: audio && Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
    codec: audio?.codec_name ?? null,
    formatName: typeof format.format_name === 'string' ? format.format_name : null,
    bitRate: Number.isFinite(Number(format.bit_rate)) ? Number(format.bit_rate) : null,
    sizeBytes: Number.isFinite(Number(format.size)) ? Number(format.size) : 0,
    hasAudio: audioStreams.length > 0,
    hasVideo,
    audioStreams: audioStreams.length
  };
}

/**
 * @param {number[]} candidates
 * @returns {number} First finite, non-negative value.
 */
function firstFinite(candidates) {
  for (const value of candidates) {
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/**
 * Extract `4.4.2` from `ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright …`.
 * @param {string} stdout
 * @returns {?string}
 */
export function parseVersion(stdout) {
  const match = /version\s+(\S+)/i.exec(stdout || '');
  return match ? match[1] : null;
}

export default AudioProbe;
