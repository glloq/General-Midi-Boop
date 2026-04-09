-- ============================================================================
-- File: migrations/038_behavior_mode.sql
-- Project: Ma-est-tro - MIDI Orchestration System
-- ============================================================================
--
-- Description:
--   Ajoute la colonne behavior_mode a midi_instrument_routings pour
--   persister le mode de comportement multi-instrument choisi par
--   l'utilisateur lors de l'ajout d'un second instrument sur un canal.
--
--   Valeurs possibles:
--     - 'overflow'           : notes en excès (polyphonie) vers instrument B
--     - 'combineNoOverlap'   : division de plage sans chevauchement
--     - 'combineWithOverlap' : superposition avec zone partagée
--     - 'alternate'          : alternance round-robin globale par canal
--     - NULL                 : comportement legacy / pas de mode explicite
--
-- ============================================================================

-- Pre-check
CREATE TEMP TABLE IF NOT EXISTS _migration_038_check AS
    SELECT
        (SELECT COUNT(*) FROM schema_version WHERE version = 37) as has_037,
        (SELECT COUNT(*) FROM schema_version WHERE version = 38) as has_038;

SELECT CASE
    WHEN (SELECT has_037 FROM _migration_038_check) = 0
    THEN 'ERROR: Migration 037 must be applied first'
    WHEN (SELECT has_038 FROM _migration_038_check) > 0
    THEN 'Migration 038 already applied - skipping'
END;

DROP TABLE _migration_038_check;

-- ============================================================================
-- Ajouter la colonne behavior_mode
-- ============================================================================

ALTER TABLE midi_instrument_routings
    ADD COLUMN behavior_mode TEXT DEFAULT NULL;

-- ============================================================================
-- ENREGISTRER LA MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (38, 'Add behavior_mode column to midi_instrument_routings for multi-instrument behavior selection');

-- Verification
SELECT
    'Migration 038 completed successfully' as status,
    (SELECT version FROM schema_version ORDER BY version DESC LIMIT 1) as current_version;
