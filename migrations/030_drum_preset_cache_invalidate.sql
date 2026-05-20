-- Bell-bug cache invalidation.
--
-- SF2PresetService used to fall back from bank 128 to bank 0 with the same
-- program number when a drum kit was missing — returning a melodic preset
-- (e.g. program 8 = Celesta) which the synthesizer then played at the drum
-- note's pitch, producing a sustained bell ring. The cascade is now
-- (128, kit) → (128, 0) → (0, kit) → (0, 0) (see SF2PresetService.js).
--
-- The L2 cache row format is unchanged, but the stored *bytes* are now
-- wrong for any drum lookup that previously fell through to bank 0. Wipe
-- every drum row so the corrected cascade rebuilds them on next access.
-- Melodic rows are untouched (they were never affected by the bug).

DELETE FROM sf2_preset_cache WHERE preset_type = 'drum';
