-- Add a scale root (tonic) so diatonic/pentatonic `octave_mode` snapping is
-- keyed to the instrument's actual tuning instead of always assuming C (audit —
-- computePlayableNotes hardcoded root=0, so a kalimba tuned to G materialized
-- the C-major subset and played wrong notes).
--
-- `scale_root` is a pitch class 0..11 (0 = C). It is meaningful only when
-- octave_mode is 'diatonic' or 'pentatonic'; 'chromatic' ignores it. Existing
-- rows default to 0 (C), preserving prior behaviour.
--
-- Both the per-channel primary (instruments_latency) and per-GM-voice overrides
-- (instrument_voices) carry their own root, mirroring octave_mode.

ALTER TABLE instruments_latency ADD COLUMN scale_root INTEGER DEFAULT 0;
ALTER TABLE instrument_voices  ADD COLUMN scale_root INTEGER;
