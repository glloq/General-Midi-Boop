-- Migration 031: Convert MIDI file data from base64 TEXT to binary BLOB
-- The actual data conversion is handled by the application code at startup.
-- This migration adds the new BLOB column alongside the old TEXT column.

ALTER TABLE midi_files ADD COLUMN data_blob BLOB;
