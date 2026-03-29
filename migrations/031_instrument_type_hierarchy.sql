-- ============================================================================
-- File: migrations/031_instrument_type_hierarchy.sql
-- Version: 5.0.0
-- Project: Ma-est-tro - MIDI Orchestration System
-- ============================================================================
--
-- Description:
--   Ajoute le support de la hiérarchie de types d'instruments :
--   - Sous-type d'instrument (instrument_subtype) dans instruments_latency
--   - Index pour recherche par type/sous-type
--   - Support du channel splitting dans midi_instrument_routings
--
-- ============================================================================

-- ============================================================================
-- PRE-CHECK
-- ============================================================================

CREATE TEMP TABLE IF NOT EXISTS _migration_031_check AS
    SELECT
        (SELECT COUNT(*) FROM schema_version WHERE version = 5) as has_005,
        (SELECT COUNT(*) FROM schema_version WHERE version = 31) as has_031;

SELECT CASE
    WHEN (SELECT has_005 FROM _migration_031_check) = 0
    THEN 'ERROR: Migration 005 must be applied first'
    WHEN (SELECT has_031 FROM _migration_031_check) > 0
    THEN 'Migration 031 already applied - skipping'
END;

DROP TABLE _migration_031_check;

-- ============================================================================
-- INSTRUMENTS_LATENCY : ajout instrument_subtype
-- ============================================================================

-- Sous-type d'instrument (ex: 'violin', 'nylon', 'trumpet')
ALTER TABLE instruments_latency ADD COLUMN instrument_subtype TEXT DEFAULT NULL;

-- Index pour recherche par type
CREATE INDEX IF NOT EXISTS idx_instruments_type
ON instruments_latency(instrument_type);

-- Index composite type + sous-type
CREATE INDEX IF NOT EXISTS idx_instruments_type_subtype
ON instruments_latency(instrument_type, instrument_subtype);

-- ============================================================================
-- MIDI_INSTRUMENT_ROUTINGS : support du channel splitting
-- ============================================================================

-- Mode de split : 'range', 'polyphony', 'mixed', ou NULL (pas de split)
ALTER TABLE midi_instrument_routings ADD COLUMN split_mode TEXT DEFAULT NULL
    CHECK(split_mode IS NULL OR split_mode IN ('range', 'polyphony', 'mixed'));

-- Plage de notes pour le split par range
ALTER TABLE midi_instrument_routings ADD COLUMN split_note_min INTEGER DEFAULT NULL
    CHECK(split_note_min IS NULL OR (split_note_min BETWEEN 0 AND 127));

ALTER TABLE midi_instrument_routings ADD COLUMN split_note_max INTEGER DEFAULT NULL
    CHECK(split_note_max IS NULL OR (split_note_max BETWEEN 0 AND 127));

-- Part de polyphonie pour le split par polyphonie
ALTER TABLE midi_instrument_routings ADD COLUMN split_polyphony_share INTEGER DEFAULT NULL
    CHECK(split_polyphony_share IS NULL OR split_polyphony_share > 0);

-- Index pour trouver tous les segments d'un canal splitté
CREATE INDEX IF NOT EXISTS idx_routings_split
ON midi_instrument_routings(midi_file_id, channel, split_mode)
WHERE split_mode IS NOT NULL;

-- ============================================================================
-- ENREGISTRER LA MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (31, 'Add instrument type hierarchy and channel splitting support');

-- ============================================================================
-- VÉRIFICATION POST-MIGRATION
-- ============================================================================

SELECT
    CASE
        WHEN (SELECT COUNT(*) FROM pragma_table_info('instruments_latency')
              WHERE name = 'instrument_subtype') = 0
        THEN 'WARNING: instrument_subtype column not added'
        ELSE 'instrument_subtype column added successfully'
    END as subtype_check;

SELECT
    CASE
        WHEN (SELECT COUNT(*) FROM pragma_table_info('midi_instrument_routings')
              WHERE name = 'split_mode') = 0
        THEN 'WARNING: split_mode column not added'
        ELSE 'Channel splitting columns added successfully'
    END as split_check;

SELECT
    'Migration 031 completed successfully' as status,
    (SELECT version FROM schema_version ORDER BY version DESC LIMIT 1) as current_version;
