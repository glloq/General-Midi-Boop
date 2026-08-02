-- Persist paired BLE-MIDI instruments so they survive a reboot and can be
-- auto-reconnected on startup (audit — the paired list was in-memory only, so
-- an offline-first Raspberry Pi forgot every BLE instrument on restart).
--
-- One row per paired device. `auto_reconnect` lets the operator opt a device
-- out of automatic reconnection; `last_connected_at` records the most recent
-- successful connection for diagnostics / ordering.

CREATE TABLE IF NOT EXISTS bluetooth_paired_devices (
  address           TEXT PRIMARY KEY,
  name              TEXT,
  auto_reconnect    INTEGER NOT NULL DEFAULT 1,
  last_connected_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
