/**
 * @file src/transcription/AudioPreprocessor.js
 * @description One funnel from "a file the user picked" to "the exact PCM a
 * backend declared it wants" (§4/§5).
 *
 * The alternative — letting each engine decode whatever the user uploaded —
 * means every engine inherits a different set of decoders, a different set of
 * bugs, and a different attack surface. Here, FFmpeg decodes everything once,
 * into a canonical WAV, and a backend only ever sees bytes GMB produced.
 *
 * Order matters: the cheap rejections (extension, size) come before the
 * expensive ones (probe, convert), so a 2 GB video is refused without being
 * read, and a 40-minute podcast is refused without being transcoded.
 */
import fs from 'fs/promises';
import path from 'path';
import { AudioProbe } from './utils/AudioProbe.js';
import { ProcessRunner, isMissingBinaryError, tail } from './utils/ProcessRunner.js';
import { normalizeAudioFormat, DEFAULT_AUDIO_FORMAT } from './TranscriptionCapabilities.js';
import { TranscriptionError, TRANSCRIPTION_REASONS } from './TranscriptionError.js';

/** Used when no logger is injected. */
const NULL_LOGGER = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

/** Audio containers accepted from the user (§4). */
export const SUPPORTED_AUDIO_EXTENSIONS = Object.freeze([
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.wma'
]);

/** Video containers we accept in order to extract their audio track (§4). */
export const SUPPORTED_VIDEO_EXTENSIONS = Object.freeze(['.mp4', '.mkv', '.webm', '.mov']);

/** Everything the picker and the API accept. */
export const SUPPORTED_EXTENSIONS = Object.freeze([
  ...SUPPORTED_AUDIO_EXTENSIONS,
  ...SUPPORTED_VIDEO_EXTENSIONS
]);

/**
 * Container signatures, checked as defence in depth before FFmpeg is handed
 * the file. ffprobe remains the authority — this only catches the obvious
 * "renamed .exe to .mp3" case early and cheaply (§40).
 * Each entry: bytes to match at `offset`.
 */
const MAGIC_SIGNATURES = Object.freeze([
  { name: 'riff', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF (wav)
  { name: 'flac', offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { name: 'ogg', offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { name: 'id3', offset: 0, bytes: [0x49, 0x44, 0x33] }, // ID3 (mp3)
  { name: 'aiff', offset: 0, bytes: [0x46, 0x4f, 0x52, 0x4d] }, // FORM
  { name: 'mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ....ftyp
  { name: 'matroska', offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }, // EBML
  { name: 'asf', offset: 0, bytes: [0x30, 0x26, 0xb2, 0x75] }, // ASF/WMA
  { name: 'adts', offset: 0, bytes: [0xff, 0xf1] }, // AAC ADTS
  { name: 'adts', offset: 0, bytes: [0xff, 0xf9] }
]);

/** Conversion is the slowest stage; still, it must not run forever. */
const CONVERT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * @typedef {Object} PreparedAudio
 * @property {string} path - Absolute path of the canonical WAV.
 * @property {number} duration - Seconds, from the probe of the SOURCE.
 * @property {Object} format - The format actually produced.
 * @property {AudioProbeResult} source - What the original file contained.
 * @property {number} conversionMs
 */

/** Validates and converts user audio into a backend's declared format. */
export class AudioPreprocessor {
  /**
   * @param {Object} [deps]
   * @param {Object} [deps.logger]
   * @param {ProcessRunner} [deps.processRunner]
   * @param {AudioProbe} [deps.audioProbe]
   * @param {Object} [deps.settings] - Resolved transcription settings
   *   (`maxAudioFileBytes`, `maxAudioDurationSeconds`).
   * @param {string} [deps.ffmpegPath='ffmpeg']
   */
  constructor(deps = {}) {
    this.logger = deps.logger || NULL_LOGGER;
    this.runner = deps.processRunner || new ProcessRunner({ logger: this.logger });
    this.probe =
      deps.audioProbe || new AudioProbe({ logger: this.logger, processRunner: this.runner });
    this.settings = deps.settings || {};
    this.ffmpegPath = deps.ffmpegPath || 'ffmpeg';
  }

  /**
   * Cheap, synchronous checks on what we know before touching the file:
   * the name and the announced size.
   *
   * @param {{filename: string, sizeBytes?: number}} descriptor
   * @returns {{extension: string, isVideo: boolean}}
   * @throws {TranscriptionError} `UNSUPPORTED_FORMAT` / `FILE_TOO_LARGE`.
   */
  validateDescriptor({ filename, sizeBytes = 0 }) {
    const extension = path.extname(String(filename || '')).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        `Unsupported file type "${extension || path.basename(String(filename || ''))}". Accepted: ${SUPPORTED_EXTENSIONS.join(', ')}`,
        { extension, supported: SUPPORTED_EXTENSIONS }
      );
    }
    const limit = this.settings.maxAudioFileBytes;
    if (Number.isFinite(limit) && limit > 0 && sizeBytes > limit) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.FILE_TOO_LARGE,
        `File is ${formatMb(sizeBytes)}; the limit is ${formatMb(limit)}`,
        { sizeBytes, limitBytes: limit }
      );
    }
    return { extension, isVideo: SUPPORTED_VIDEO_EXTENSIONS.includes(extension) };
  }

  /**
   * Read the first bytes and check them against known container signatures.
   * A mismatch is refused here rather than handed to FFmpeg.
   *
   * @param {string} filePath
   * @returns {Promise<string>} The matched signature name.
   * @throws {TranscriptionError} `UNSUPPORTED_FORMAT`.
   */
  async assertKnownContainer(filePath) {
    let head;
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    for (const signature of MAGIC_SIGNATURES) {
      const end = signature.offset + signature.bytes.length;
      if (head.length < end) continue;
      let matches = true;
      for (let i = 0; i < signature.bytes.length; i++) {
        if (head[signature.offset + i] !== signature.bytes[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return signature.name;
    }
    // A bare MPEG frame sync (0xFFEx) covers MP3s with no ID3 tag.
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mpeg';

    throw new TranscriptionError(
      TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
      'This file does not look like an audio or video file',
      {}
    );
  }

  /**
   * Validate, probe and convert a source file into the canonical WAV a
   * backend expects.
   *
   * @param {Object} options
   * @param {string} options.inputPath - Absolute path of the user's file.
   * @param {string} options.outputPath - Absolute path to write (inside the
   *   job workspace).
   * @param {string} [options.filename] - Original name, for the extension
   *   check and error messages. Defaults to the basename of `inputPath`.
   * @param {Object} [options.targetFormat] - Backend-declared audio format.
   * @param {AbortSignal} [options.signal]
   * @param {(p: {stage: string, progress: ?number}) => void} [options.onProgress]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<PreparedAudio>}
   */
  async prepare({
    inputPath,
    outputPath,
    filename = null,
    targetFormat = DEFAULT_AUDIO_FORMAT,
    signal,
    onProgress,
    timeoutMs = CONVERT_TIMEOUT_MS
  }) {
    const name = filename || path.basename(inputPath);
    const stat = await fs.stat(inputPath);
    this.validateDescriptor({ filename: name, sizeBytes: stat.size });
    await this.assertKnownContainer(inputPath);

    onProgress?.({ stage: 'probing', progress: null });
    const source = await this.probe.probe(inputPath, { signal });

    if (!source.hasAudio) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'This file contains no audio track',
        { formatName: source.formatName }
      );
    }

    const maxDuration = this.settings.maxAudioDurationSeconds;
    if (Number.isFinite(maxDuration) && maxDuration > 0 && source.duration > maxDuration) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.AUDIO_TOO_LONG,
        `Audio is ${formatDuration(source.duration)}; the limit is ${formatDuration(maxDuration)}`,
        { duration: source.duration, limitSeconds: maxDuration }
      );
    }

    const format = normalizeAudioFormat(targetFormat);
    onProgress?.({ stage: 'converting', progress: null });

    const startedAt = Date.now();
    const args = buildFfmpegArgs({ inputPath, outputPath, format, duration: source.duration });

    let result;
    try {
      result = await this.runner.run(this.ffmpegPath, args, {
        timeoutMs,
        signal,
        // FFmpeg writes progress to stderr; keep only a tail for diagnostics.
        maxStderrBytes: 128 * 1024,
        onStderrLine: onProgress ? makeFfmpegProgressParser(source.duration, onProgress) : undefined
      });
    } catch (error) {
      if (isMissingBinaryError(error)) {
        throw new TranscriptionError(
          TRANSCRIPTION_REASONS.FFMPEG_MISSING,
          'FFmpeg is not installed — it is required to convert audio files',
          { command: this.ffmpegPath }
        );
      }
      throw error;
    }

    if (result.code !== 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'FFmpeg could not convert this file',
        { exitCode: result.code, detail: tail(result.stderr, 4) }
      );
    }

    // Trust but verify: a zero exit with no output means something went wrong
    // that FFmpeg did not consider fatal.
    let outputStat;
    try {
      outputStat = await fs.stat(outputPath);
    } catch (error) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'Audio conversion produced no output',
        {},
        { cause: error }
      );
    }
    if (outputStat.size === 0) {
      throw new TranscriptionError(
        TRANSCRIPTION_REASONS.UNSUPPORTED_FORMAT,
        'Audio conversion produced an empty file',
        {}
      );
    }

    const conversionMs = Date.now() - startedAt;
    this.logger.info(
      `Audio normalized: ${name} (${source.codec ?? '?'} ${formatDuration(source.duration)}) → ` +
        `${format.encoding} ${format.sampleRate}Hz ${format.channels}ch in ${conversionMs}ms`
    );

    return {
      path: outputPath,
      duration: source.duration,
      format,
      source,
      conversionMs
    };
  }
}

/**
 * Build the FFmpeg argument vector. Deliberately explicit: no shell, no
 * string interpolation, and `-i` before the input so a filename starting
 * with `-` cannot be read as an option.
 *
 * @param {{inputPath: string, outputPath: string, format: Object, duration: number}} options
 * @returns {string[]}
 */
export function buildFfmpegArgs({ inputPath, outputPath, format }) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:2',
    '-y',
    '-i',
    inputPath,
    // Drop everything that is not audio (cover art, video, subtitles).
    '-vn',
    '-sn',
    '-dn',
    '-map',
    '0:a:0',
    '-ac',
    String(format.channels),
    '-ar',
    String(format.sampleRate),
    '-acodec',
    format.encoding,
    '-f',
    format.container,
    outputPath
  ];
}

/**
 * Parse `-progress pipe:2` output into a 0..1 fraction of the known
 * duration. Returns a line handler.
 *
 * @param {number} duration - Source duration in seconds; 0 means unknown, in
 *   which case progress stays null (an indeterminate bar, never a fake one).
 * @param {(p: {stage: string, progress: ?number}) => void} onProgress
 * @returns {(line: string) => void}
 */
export function makeFfmpegProgressParser(duration, onProgress) {
  return (line) => {
    const match = /^out_time_ms=(\d+)/.exec(line.trim());
    if (!match) return;
    if (!(duration > 0)) {
      onProgress({ stage: 'converting', progress: null });
      return;
    }
    // Despite the name, out_time_ms is microseconds.
    const seconds = Number(match[1]) / 1_000_000;
    const progress = Math.max(0, Math.min(1, seconds / duration));
    onProgress({ stage: 'converting', progress });
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {number} seconds
 * @returns {string} `mm:ss`, or `h:mm:ss` past an hour.
 */
function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export default AudioPreprocessor;
