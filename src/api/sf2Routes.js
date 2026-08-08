/**
 * @file src/api/sf2Routes.js
 * @description HTTP endpoints for custom SF2 soundfont management.
 *
 * GET    /api/sf2                              → list all SF2 banks
 * POST   /api/sf2  (raw body, ?filename=)      → upload SF2
 * DELETE /api/sf2/:id                          → delete SF2
 * PATCH  /api/sf2/:id  { label, reverb_mix }   → rename / adjust
 * GET    /api/sf2/:id/preset/melodic/:program  → WAF preset JSON
 * GET    /api/sf2/:id/preset/drum/:kit/:note   → WAF preset JSON
 * GET    /api/sf2/:id/kits                     → { drumKits, drumBank, melodicPrograms }
 */

import { Router, raw as expressRaw, json as expressJson } from 'express';
import { LIMITS } from '../core/constants.js';
import { encodePreset } from '../files/SF2PresetCodec.js';

// Serialize SF2 uploads. `expressRaw` buffers the ENTIRE body (up to ~160 MB)
// into memory before the handler runs, and unlike MIDI uploads these are not
// routed through a bounded queue — a handful of concurrent POSTs would spike
// the heap and OOM-kill the process on a Pi (audit A2 M1). A single in-flight
// upload at a time is plenty for an admin action and caps the worst-case RAM.
const MAX_CONCURRENT_SF2_UPLOADS = 1;
let sf2UploadsInFlight = 0;

// MIME used for the GMBP binary preset payload. The `compression` middleware
// only compresses content types its `compressible` table marks as
// compressible, and application/octet-stream is not — so binary preset
// responses bypass gzip automatically (Float32 audio entropy is high
// enough that gzip would add ~1.5 s of CPU for marginal savings).
const PRESET_MIME = 'application/octet-stream';

function sendPreset(res, preset) {
  const buf = encodePreset(preset);
  res.setHeader('Content-Type', PRESET_MIME);
  res.setHeader('Content-Length', buf.length);
  // Without explicit cache directives, browsers cache octet-stream
  // responses heuristically (often days), so a deploy that changes the
  // preset bytes (e.g. the bell-bug cascade fix) would not reach users
  // until they performed a hard reload. `no-cache` lets the browser keep
  // the response but forces revalidation on every request — cheap once
  // the server returns 304 — and is mandatory after any code change that
  // alters preset content for the same URL.
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.end(buf);
}

// Strip HTML-significant chars from user-supplied label (server-side XSS guard).
function sanitizeLabel(raw) {
  return String(raw)
    .replace(/[<>"'&]/g, '')
    .trim()
    .slice(0, 128);
}

// Accept either the literal 'default' (built-in soundfont) or a positive
// integer DB id. Numeric ids are returned as Number; 'default' is returned
// as the string for SF2PresetService to dispatch on. The numeric id 0 is
// the sentinel row inserted by migration 020 for the built-in SF2 — some
// UI paths surface the bank as `sf2:0` instead of `sf2:default`, and both
// must resolve to the bundled soundfont (otherwise the route returns 400
// and the synth silently fails to load any drum / melodic preset).
function parseSF2Id(raw) {
  if (raw === 'default') return 'default';
  const n = Number(raw);
  if (n === 0) return 'default';
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Safely project only public fields from a DB row.
function publicRow(r) {
  return {
    id: r.id,
    label: r.label,
    filename: r.filename,
    size: r.size,
    reverbMix: r.reverb_mix,
    uploadedAt: r.uploaded_at
  };
}

/**
 * @param {Object} app - Application facade exposing `sf2PresetService`, `logger`
 * @returns {import('express').Router}
 */
export function createSF2Router(app) {
  const router = Router();
  const uploadLimit = LIMITS.MAX_SF2_FILE_SIZE + 64 * 1024;

  // ── List ─────────────────────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    try {
      const rows = app.sf2PresetService.listAll();
      res.json({
        defaultPresent: app.sf2PresetService.hasDefaultSF2(),
        banks: rows.map(publicRow)
      });
    } catch (err) {
      app.logger.error(`GET /api/sf2 failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Upload ───────────────────────────────────────────────────────────────
  // Concurrency gate runs BEFORE `expressRaw` so a second upload is refused
  // without buffering its body (audit A2 M1). The counter is released on `close`
  // so it drops whether the response finishes, errors, or the client aborts.
  const sf2UploadGate = (req, res, next) => {
    if (sf2UploadsInFlight >= MAX_CONCURRENT_SF2_UPLOADS) {
      return res
        .status(429)
        .json({ error: 'Another SF2 upload is in progress. Please retry shortly.' });
    }
    sf2UploadsInFlight++;
    res.on('close', () => {
      sf2UploadsInFlight = Math.max(0, sf2UploadsInFlight - 1);
    });
    next();
  };

  router.post(
    '/',
    sf2UploadGate,
    expressRaw({ type: '*/*', limit: uploadLimit }),
    async (req, res) => {
      try {
        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Empty body. Send raw SF2 bytes.' });
        }
        if (req.body.length > LIMITS.MAX_SF2_FILE_SIZE) {
          return res
            .status(413)
            .json({ error: `File too large. Max ${LIMITS.MAX_SF2_FILE_SIZE / (1024 * 1024)} MB.` });
        }
        // H-1: validate both RIFF container header and sfbk type field
        if (
          req.body.slice(0, 4).toString('ascii') !== 'RIFF' ||
          req.body.slice(8, 12).toString('ascii') !== 'sfbk'
        ) {
          return res.status(415).json({ error: 'Not a valid SF2 file.' });
        }
        // L-2: enforce per-server total storage quota (1 GB default)
        const totalStored = app.sf2PresetService.getTotalStoredSize();
        if (totalStored + req.body.length > LIMITS.MAX_SF2_TOTAL_SIZE) {
          return res.status(413).json({ error: 'Server SF2 storage quota reached.' });
        }
        const filename = String(req.query.filename || 'upload.sf2').trim();
        const result = await app.sf2PresetService.storeUpload(filename, req.body);
        const status = result.status === 'duplicate' ? 200 : 201;
        res.status(status).json(result);
      } catch (err) {
        app.logger.error(`POST /api/sf2 failed: ${err.message}`);
        res.status(500).json({ error: 'Internal server error.' });
      }
    }
  );

  // ── Delete ───────────────────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    try {
      if (req.params.id === 'default') {
        return res.status(403).json({ error: 'Cannot delete the built-in default soundfont.' });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const row = app.database.customSF2DB.getById(id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      app.sf2PresetService.deleteSF2(id);
      res.status(204).end();
    } catch (err) {
      app.logger.error(`DELETE /api/sf2/${req.params.id} failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Update label / reverb ─────────────────────────────────────────────────
  // L-3: explicit JSON body parser on this route
  router.patch('/:id', expressJson({ limit: '4kb' }), (req, res) => {
    try {
      if (req.params.id === 'default') {
        return res.status(403).json({ error: 'Cannot modify the built-in default soundfont.' });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const row = app.database.customSF2DB.getById(id);
      if (!row) return res.status(404).json({ error: 'Not found' });

      const updates = {};
      // C-1: sanitize label to prevent stored XSS via innerHTML injection
      if (req.body?.label != null) updates.label = sanitizeLabel(req.body.label);
      if (req.body?.reverb_mix != null) {
        const v = Number(req.body.reverb_mix);
        if (Number.isFinite(v) && v >= 0 && v <= 1) updates.reverb_mix = v;
      }
      if (Object.keys(updates).length) {
        app.database.customSF2DB.update(id, updates);
      }
      // M-3: return only public fields, not blob_path / content_hash
      res.json(publicRow(app.database.customSF2DB.getById(id)));
    } catch (err) {
      app.logger.error(`PATCH /api/sf2/${req.params.id} failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Melodic preset ────────────────────────────────────────────────────────
  router.get('/:id/preset/melodic/:program', async (req, res) => {
    try {
      const id = parseSF2Id(req.params.id);
      const program = Number(req.params.program);
      if (id === null || !Number.isFinite(program) || program < 0 || program > 127) {
        return res.status(400).json({ error: 'Invalid id or program' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'melodic', program, 0, 0);
      if (!preset) return res.status(404).json({ error: 'Preset not found in this SF2' });
      sendPreset(res, preset);
    } catch (err) {
      app.logger.error(
        `GET /api/sf2/${req.params.id}/preset/melodic/${req.params.program} failed: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Inventory: which drum kits and melodic programs the SF2 actually has ─
  // Lets the frontend grey out unavailable kits instead of letting users
  // pick a kit that silently falls back to Standard. Cheap: SF2InstanceCache
  // amortises the RIFF parse.
  router.get('/:id/kits', (req, res) => {
    try {
      const id = parseSF2Id(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Invalid id' });
      const drum = app.sf2PresetService.inspectDrumKits(id);
      const melodicPrograms = app.sf2PresetService.inspectMelodicPrograms(id);
      res.json({
        drumKits: drum.kits,
        drumBank: drum.bankNum,
        melodicPrograms
      });
    } catch (err) {
      app.logger.error(`GET /api/sf2/${req.params.id}/kits failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Drum preset ───────────────────────────────────────────────────────────
  router.get('/:id/preset/drum/:kit/:note', async (req, res) => {
    try {
      const id = parseSF2Id(req.params.id);
      const kit = Number(req.params.kit);
      const note = Number(req.params.note);
      if (
        id === null ||
        !Number.isFinite(kit) ||
        kit < 0 ||
        kit > 127 ||
        !Number.isFinite(note) ||
        note < 0 ||
        note > 127
      ) {
        return res.status(400).json({ error: 'Invalid id, kit, or note' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'drum', 0, kit, note);
      if (!preset) return res.status(404).json({ error: 'Drum preset not found in this SF2' });
      sendPreset(res, preset);
    } catch (err) {
      app.logger.error(
        `GET /api/sf2/${req.params.id}/preset/drum/${req.params.kit}/${req.params.note} failed: ${err.message}`
      );
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
