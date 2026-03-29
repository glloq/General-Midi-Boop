-- ============================================================================
-- File: migrations/032_split_routing_constraint.sql
-- Version: 5.0.0
-- Project: Ma-est-tro - MIDI Orchestration System
-- ============================================================================
--
-- Description:
--   Modifie la contrainte unique sur midi_instrument_routings pour permettre
--   plusieurs routings par canal (channel splitting).
--   L'ancien index UNIQUE(midi_file_id, channel) est remplacé par un index
--   UNIQUE(midi_file_id, channel, split_note_min) qui autorise N segments
--   par canal tant que leurs plages de notes diffèrent.
--   Les routings sans split (split_note_min IS NULL) restent uniques par canal.
--
-- ============================================================================

-- Pre-check
CREATE TEMP TABLE IF NOT EXISTS _migration_032_check AS
    SELECT
        (SELECT COUNT(*) FROM schema_version WHERE version = 31) as has_031,
        (SELECT COUNT(*) FROM schema_version WHERE version = 32) as has_032;

SELECT CASE
    WHEN (SELECT has_031 FROM _migration_032_check) = 0
    THEN 'ERROR: Migration 031 must be applied first'
    WHEN (SELECT has_032 FROM _migration_032_check) > 0
    THEN 'Migration 032 already applied - skipping'
END;

DROP TABLE _migration_032_check;

-- ============================================================================
-- Supprimer l'ancien index unique (migration 020)
-- ============================================================================

DROP INDEX IF EXISTS idx_midi_routings_file_channel;

-- ============================================================================
-- Nouvel index unique : permet plusieurs segments par canal si split
-- Pour les routings normaux (split_note_min IS NULL), l'unicité par canal
-- est assurée via un index partiel séparé.
-- ============================================================================

-- Index unique pour les routings AVEC split (plusieurs segments par canal)
CREATE UNIQUE INDEX IF NOT EXISTS idx_midi_routings_file_channel_split
    ON midi_instrument_routings(midi_file_id, channel, split_note_min)
    WHERE split_note_min IS NOT NULL;

-- Index unique pour les routings SANS split (un seul par canal)
CREATE UNIQUE INDEX IF NOT EXISTS idx_midi_routings_file_channel_nosplit
    ON midi_instrument_routings(midi_file_id, channel)
    WHERE split_mode IS NULL;

-- ============================================================================
-- ENREGISTRER LA MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (32, 'Allow multiple routings per channel for split mode');

-- Vérification
SELECT
    'Migration 032 completed successfully' as status,
    (SELECT version FROM schema_version ORDER BY version DESC LIMIT 1) as current_version;
