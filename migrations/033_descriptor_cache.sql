-- ============================================================================
-- Migration 033: v2 descriptor cache (Instrument Recognition & Capability
-- Protocol — docs/SYSEX_IDENTITY.md)
-- ============================================================================
--
-- The v2 handshake (block 1) carries a per-exemplar `instance_id` and a
-- monotonic `revision`. Level-1 instruments additionally serve a JSON
-- capability descriptor (block 0x10 / HTTP). GMB caches the descriptor per
-- instrument so it can:
--
--   * skip re-downloading when `revision` is unchanged (ETag semantics), and
--   * diff the previous descriptor against the next one to expire user
--     overrides field-by-field (docs/SYSEX_IDENTITY.md §6).
--
-- `instance_id` itself reuses the existing `sysex_device_id` column (the v2
-- parser writes the instance id there through saveSysExIdentity), so only the
-- two cache columns are new here.
--
-- Additive only, on purpose: SQLite cannot widen a CHECK constraint in place,
-- and rebuilding the ~50-column `instruments_latency` table is not something we
-- can validate in an environment without the native `better-sqlite3` binding.
-- Allowing the new `capabilities_source = 'descriptor'` value (the current
-- constraint is IN ('manual','sysex','auto')) is therefore deferred to the
-- slice that actually applies descriptors — see docs/SYSEX_IDENTITY.md §12.
-- ============================================================================

ALTER TABLE instruments_latency ADD COLUMN descriptor_revision INTEGER;
ALTER TABLE instruments_latency ADD COLUMN descriptor_json TEXT;
