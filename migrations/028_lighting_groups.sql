-- Migration 028: Persistent lighting device groups
-- Groups were previously stored only in memory and lost on restart

CREATE TABLE IF NOT EXISTS lighting_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  device_ids TEXT NOT NULL DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
