/**
 * @file src/types/index.ts
 * @description Shared TypeScript type definitions for the MidiMind
 * backend. Pure declarations — no runtime code. Imported by JS files via
 * JSDoc `@type {import('../types/index.js').XYZ}` so the IDE can offer
 * completion without enabling `checkJs`.
 *
 * These interfaces describe the public contracts only; internal helpers
 * keep their structural typing in JSDoc on the implementation file.
 */

/**
 * Structural contract implemented by `core/Logger.js`. Any service that
 * receives a logger should accept this minimal surface so it can be
 * substituted with a no-op or test double.
 */
export interface ILogger {
  /** Verbose tracing — usually filtered out in production. */
  debug(message: string, data?: unknown): void;
  /** Operational events that an operator wants to see. */
  info(message: string, data?: unknown): void;
  /** Recoverable issue (degraded mode, missing optional dependency). */
  warn(message: string, data?: unknown): void;
  /** Fault that prevents normal operation; usually paired with throw. */
  error(message: string, data?: unknown): void;
}

/**
 * `server` section of {@link AppConfig}. Drives the HTTP and WebSocket
 * listeners.
 *
 * @property port - HTTP listening port (1-65535).
 * @property wsPort - WebSocket port; usually equal to `port` since the WS
 *   server attaches to the same http.Server in the current implementation.
 * @property host - Optional bind address (defaults to all interfaces).
 * @property staticPath - Filesystem path served by Express as static files.
 */
export interface ServerConfig {
  port: number;
  wsPort: number;
  host?: string;
  staticPath: string;
}

/**
 * `midi` section of {@link AppConfig}. Currently only `defaultLatency` is
 * consumed at runtime; `bufferSize` and `sampleRate` are reserved for the
 * (planned) audio engine integration.
 *
 * @property bufferSize - Audio engine frame size in samples.
 * @property sampleRate - Audio engine sample rate in Hz.
 * @property defaultLatency - Default per-device latency compensation (ms).
 */
export interface MidiConfig {
  bufferSize: number;
  sampleRate: number;
  defaultLatency: number;
}

/**
 * `database` section of {@link AppConfig}.
 *
 * @property path - Repo-relative SQLite file path.
 */
export interface DatabaseConfig {
  path: string;
}

/**
 * `logging` section of {@link AppConfig}. Mirrors the constructor
 * options of `core/Logger.js`.
 *
 * @property level - Minimum severity to write.
 * @property file - Repo-relative log file path.
 * @property console - When true, also write to stdout/stderr.
 * @property jsonFormat - File output uses one JSON object per line.
 * @property maxLogSize - Rotation threshold in bytes.
 * @property maxLogFiles - Number of rotated files retained.
 */
export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
  console: boolean;
  jsonFormat?: boolean;
  maxLogSize?: number;
  maxLogFiles?: number;
}

/**
 * `ble` section — Bluetooth Low Energy MIDI configuration.
 *
 * @property enabled - Master switch (skips noble/node-ble init when false).
 * @property scanDuration - Active scan window in ms used by `ble_scan`.
 */
export interface BleConfig {
  enabled: boolean;
  scanDuration: number;
}

/**
 * `serial` section — Serial-port MIDI configuration.
 *
 * @property enabled - Master switch (skips serialport init when false).
 * @property autoDetect - When true, probe attached devices and open MIDI
 *   ones automatically.
 * @property baudRate - UART baud rate (31250 is the MIDI standard).
 * @property ports - Explicit device paths to open in addition to/instead
 *   of auto-detection.
 */
export interface SerialConfig {
  enabled: boolean;
  autoDetect: boolean;
  baudRate: number;
  ports: string[];
}

/**
 * `playback` section — defaults applied when a file or playlist does
 * not specify its own values.
 *
 * @property defaultTempo - BPM used when none stored in the MIDI file.
 * @property defaultVolume - 0-127 master volume applied at start.
 */
export interface PlaybackConfig {
  defaultTempo: number;
  defaultVolume: number;
}

/**
 * `latency` section — calibration parameters.
 *
 * @property defaultIterations - Sample count for `latency_measure`.
 * @property recalibrationDays - Auto-recalibration interval; older
 *   calibrations are flagged stale by the UI.
 */
export interface LatencyConfig {
  defaultIterations: number;
  recalibrationDays: number;
}

/**
 * Composite of every configuration section consumed by the backend.
 * Matches the JSON shape produced by `Config#getDefaultConfig`.
 */
export interface AppConfig {
  server: ServerConfig;
  midi: MidiConfig;
  database: DatabaseConfig;
  logging: LoggingConfig;
  playback: PlaybackConfig;
  latency: LatencyConfig;
  ble: BleConfig;
  serial: SerialConfig;
}

/**
 * Wire format of an inbound WebSocket command frame.
 *
 * @property id - Caller-chosen correlation id; echoed back in the response.
 * @property command - Command name routed by `CommandRegistry`.
 * @property version - Optional API version when invoking versioned handlers.
 * @property data - Per-command payload (validated by JsonValidator).
 */
export interface CommandMessage {
  id: string;
  command: string;
  version?: number;
  data?: Record<string, unknown>;
}

/**
 * Wire format of an outbound WebSocket frame. Sent both as command
 * responses (`type: 'response' | 'error'`) and as server-pushed events
 * (`type: 'event'`).
 *
 * @property id - For `response`/`error`, mirrors the request id; absent for
 *   broadcast events.
 * @property type - Frame discriminator.
 * @property command - Command name when the frame is a response.
 * @property version - API version used by the handler.
 * @property data - Successful payload or event body.
 * @property error - Human-readable error message when `type === 'error'`.
 * @property timestamp - Server epoch-ms at send time.
 * @property duration - Server-measured handler duration in ms.
 */
export interface ResponseMessage {
  id: string;
  type: 'response' | 'error' | 'event';
  command?: string;
  version?: number;
  data?: unknown;
  error?: string;
  timestamp: number;
  duration?: number;
}

/**
 * Structural contract implemented by `core/ServiceContainer.js`. Used
 * by services that want to be testable with a stub container.
 */
export interface IServiceContainer {
  register(name: string, instance: unknown): IServiceContainer;
  factory(name: string, factory: (container: IServiceContainer) => unknown): IServiceContainer;
  resolve<T = unknown>(name: string): T | undefined;
  has(name: string): boolean;
  inject(...names: string[]): Record<string, unknown>;
}

/**
 * Structural contract for `ApplicationError` and its subclasses, used by
 * the API error middleware to produce a consistent JSON response shape.
 *
 * @property code - Machine-readable error code (`ERR_*`).
 * @property statusCode - HTTP-style status the API layer should surface.
 */
export interface IApplicationError extends Error {
  code: string;
  statusCode: number;
  toJSON(): Record<string, unknown>;
}
