// tests/helpers/createTestFile.js
// Build a valid `midi_files` row payload conforming to the v6 baseline
// schema (content_hash UNIQUE NOT NULL + blob_path NOT NULL). Tests that
// only exercise DB queries / routing logic do not need real bytes on
// disk — they just need the row to insert cleanly.
//
// Use `withRandomHash: true` (default) when each test must create a
// fresh row; pass `bytes` explicitly to make `content_hash` deterministic
// (useful for dedup tests).

import { createHash, randomBytes } from 'crypto';

/**
 * Build a `midi_files` row payload + matching blob_path.
 *
 * @param {Object} [opts]
 * @param {Buffer} [opts.bytes] - Bytes that determine the SHA-256 hash.
 *   Defaults to 16 random bytes (one row per call).
 * @param {string} [opts.filename] - Defaults to `test-<hash[0..6]>.mid`.
 * @param {string} [opts.folder='/']
 * @param {Object} [opts.overrides] - Extra fields merged on top.
 * @returns {Object} Row payload accepted by `MidiDatabase.insertFile`.
 */
export function createTestFilePayload(opts = {}) {
  const bytes = opts.bytes || randomBytes(16);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const blobPath = `midi/${hash.slice(0, 2)}/${hash}.mid`;
  const filename = opts.filename || `test-${hash.slice(0, 6)}.mid`;

  return {
    content_hash: hash,
    blob_path: blobPath,
    filename,
    folder: opts.folder || '/',
    size: bytes.length,
    tracks: 1,
    duration: 1,
    tempo: 120,
    ppq: 480,
    uploaded_at: new Date().toISOString(),
    is_original: 1,
    channel_count: 0,
    instrument_types: '[]',
    has_drums: 0,
    has_melody: 0,
    has_bass: 0,
    ...(opts.overrides || {})
  };
}
