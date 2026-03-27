-- ============================================================================
-- File: migrations/030_octave_mode_comm_timeout.sql
-- Description: Add octave_mode and comm_timeout columns to instruments_latency.
--              These fields were already sent by the frontend ISMSave but never
--              persisted in the database.
-- ============================================================================

-- Octave mode: chromatic (12 notes), diatonic (7), pentatonic (5)
ALTER TABLE instruments_latency ADD COLUMN octave_mode TEXT DEFAULT 'chromatic';

-- Communication timeout in milliseconds (100-30000)
ALTER TABLE instruments_latency ADD COLUMN comm_timeout INTEGER DEFAULT 5000;
