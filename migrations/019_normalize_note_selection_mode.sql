-- Migration 019: Normalize note_selection_mode values
-- Standardize on 'range' and 'discrete' only (some rows may have 'continuous' which behaves like 'range')

UPDATE instruments_latency
SET note_selection_mode = 'range'
WHERE note_selection_mode = 'continuous';
