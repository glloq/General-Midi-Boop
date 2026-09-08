/**
 * @file src/api/commands/schemas/playlist.schemas.js
 * @description Declarative validation schemas for the `playlist_*` WebSocket
 * commands. Consumed by `JsonValidator.validateByCommand`.
 *
 * `PlaylistCommands` had ZERO schemas (15/15 unvalidated) and provided the
 * cleanest proof of F-19: `playlist_create {name: 200 000 chars}` answered
 * `{"playlistId":4}` and persisted the whole string, because
 * `playlists.name` carries a `NOT NULL` but no length `CHECK`. The same
 * command with `{name:{}}` reached the prepared statement and came back as a
 * masked "Internal server error" from the SQLite driver
 * (docs/audit/2026-09-07/01_API_CONTRACT.md §3.4).
 *
 * Field names follow the HANDLERS, not the audit's illustrative snippet:
 * `playlist_add_file` takes `midiId` (not `fileId`), and the settings are
 * `gap_seconds` / `shuffle` (not `gapMs` / `autoAdvance`).
 */
import {
  fieldRules,
  isIdLike,
  isIntLike,
  isNumLike,
  isBoolLike,
  isStr,
  isNonEmptyStr,
  MAX_NAME_LEN,
  MAX_TEXT_LEN
} from './helpers.js';

/** Ordinal ceiling for item positions — far above any realistic playlist. */
const MAX_POSITION = 100000;

const playlistIdRule = [
  'playlistId',
  isIdLike,
  'playlistId must be a number or non-empty string',
  { required: true }
];

export const playlist_create = {
  custom: fieldRules([
    [
      'name',
      (v) => isNonEmptyStr(v, MAX_NAME_LEN),
      `name must be a non-empty string of at most ${MAX_NAME_LEN} characters`,
      { required: true }
    ],
    [
      'description',
      (v) => isStr(v, MAX_TEXT_LEN),
      `description must be a string of at most ${MAX_TEXT_LEN} characters`
    ]
  ])
};

export const playlist_delete = { custom: fieldRules([playlistIdRule]) };
export const playlist_get = { custom: fieldRules([playlistIdRule]) };
export const playlist_clear = { custom: fieldRules([playlistIdRule]) };

export const playlist_add_file = {
  custom: fieldRules([
    playlistIdRule,
    ['midiId', isIdLike, 'midiId must be a number or non-empty string', { required: true }],
    [
      'position',
      (v) => isIntLike(v, 0, MAX_POSITION),
      `position must be an integer between 0 and ${MAX_POSITION}`
    ]
  ])
};

export const playlist_remove_file = {
  custom: fieldRules([
    ['itemId', isIdLike, 'itemId must be a number or non-empty string', { required: true }]
  ])
};

export const playlist_reorder = {
  custom: fieldRules([
    playlistIdRule,
    ['itemId', isIdLike, 'itemId must be a number or non-empty string', { required: true }],
    [
      'newPosition',
      (v) => isIntLike(v, 0, MAX_POSITION),
      `newPosition must be an integer between 0 and ${MAX_POSITION}`,
      { required: true }
    ]
  ])
};

export const playlist_set_loop = {
  custom: fieldRules([playlistIdRule, ['loop', isBoolLike, 'loop must be a boolean']])
};

export const playlist_update_settings = {
  custom: fieldRules([
    playlistIdRule,
    [
      'gap_seconds',
      (v) => isNumLike(v, 0, 3600),
      'gap_seconds must be a number between 0 and 3600'
    ],
    ['shuffle', isBoolLike, 'shuffle must be a boolean']
  ])
};

export const playlist_start = {
  custom: fieldRules([
    playlistIdRule,
    [
      'startIndex',
      (v) => isIntLike(v, 0, MAX_POSITION),
      `startIndex must be an integer between 0 and ${MAX_POSITION}`
    ]
  ])
};

const schemas = {
  playlist_create,
  playlist_delete,
  playlist_get,
  playlist_clear,
  playlist_add_file,
  playlist_remove_file,
  playlist_reorder,
  playlist_set_loop,
  playlist_update_settings,
  playlist_start
};

export default schemas;
