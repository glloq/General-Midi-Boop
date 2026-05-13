-- Bowed string instruments: CC mapping to drive the bow direction
-- (e.g. servo for the wheel/bow rotation on a mechanical violin).
--
-- The keyboard modal's "bow bar" (replaces the strum bar for bowed
-- instruments) emits CC `cc_bow_direction_number` with:
--   - `cc_bow_down_value` while the player holds the left half
--     (= down-bow, "tirer l'archet")
--   - `cc_bow_up_value`   while the player holds the right half
--     (= up-bow,   "pousser l'archet")
-- Releasing the button leaves the CC at its last value (the bow doesn't
-- jump back — only its direction is reversed on the next press).
ALTER TABLE string_instruments
  ADD COLUMN cc_bow_direction_number INTEGER NOT NULL DEFAULT 22;
ALTER TABLE string_instruments
  ADD COLUMN cc_bow_down_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE string_instruments
  ADD COLUMN cc_bow_up_value INTEGER NOT NULL DEFAULT 127;
