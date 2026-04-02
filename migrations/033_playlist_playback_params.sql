-- ============================================================================
-- Migration 033: Playlist Playback Parameters
-- Description: Ajoute gap_seconds et shuffle aux playlists
-- ============================================================================

-- Pre-check
CREATE TEMP TABLE IF NOT EXISTS _migration_033_check AS
    SELECT
        (SELECT COUNT(*) FROM schema_version WHERE version = 32) as has_032,
        (SELECT COUNT(*) FROM schema_version WHERE version = 33) as has_033;

SELECT CASE
    WHEN (SELECT has_032 FROM _migration_033_check) = 0
    THEN 'ERROR: Migration 032 must be applied first'
    WHEN (SELECT has_033 FROM _migration_033_check) > 0
    THEN 'Migration 033 already applied - skipping'
END;

DROP TABLE _migration_033_check;

-- ============================================================================
-- Nouveaux paramètres de lecture playlist
-- ============================================================================

-- Délai en secondes entre deux fichiers (0 = pas de délai)
ALTER TABLE playlists ADD COLUMN gap_seconds INTEGER DEFAULT 0;

-- Mode aléatoire (0 = séquentiel, 1 = aléatoire)
ALTER TABLE playlists ADD COLUMN shuffle INTEGER DEFAULT 0;

-- ============================================================================
-- ENREGISTRER LA MIGRATION
-- ============================================================================

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (33, 'Playlist playback parameters: gap_seconds and shuffle');

-- Vérification
SELECT
    'Migration 033 completed successfully' as status,
    (SELECT version FROM schema_version ORDER BY version DESC LIMIT 1) as current_version;
