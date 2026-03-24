// src/types/index.ts
// Shared type definitions for Ma-est-tro backend

/** Logger interface used across all services */
export interface ILogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Configuration sections */
export interface ServerConfig {
  port: number;
  wsPort: number;
  host?: string;
  staticPath: string;
}

export interface MidiConfig {
  bufferSize: number;
  sampleRate: number;
  defaultLatency: number;
}

export interface DatabaseConfig {
  path: string;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
  console: boolean;
  jsonFormat?: boolean;
  maxLogSize?: number;
  maxLogFiles?: number;
}

export interface BleConfig {
  enabled: boolean;
  scanDuration: number;
}

export interface SerialConfig {
  enabled: boolean;
  autoDetect: boolean;
  baudRate: number;
  ports: string[];
}

export interface AppConfig {
  server: ServerConfig;
  midi: MidiConfig;
  database: DatabaseConfig;
  logging: LoggingConfig;
  ble: BleConfig;
  serial: SerialConfig;
}

/** WebSocket command message */
export interface CommandMessage {
  id: string;
  command: string;
  version?: number;
  data?: Record<string, unknown>;
}

/** WebSocket response message */
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

/** Service container interface */
export interface IServiceContainer {
  register(name: string, instance: unknown): IServiceContainer;
  factory(name: string, factory: (container: IServiceContainer) => unknown): IServiceContainer;
  resolve<T = unknown>(name: string): T | undefined;
  has(name: string): boolean;
  inject(...names: string[]): Record<string, unknown>;
}

/** Application error with code and status */
export interface IApplicationError extends Error {
  code: string;
  statusCode: number;
  toJSON(): Record<string, unknown>;
}
