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
 */

import { Router, raw as expressRaw, json as expressJson } from 'express';
import { LIMITS } from '../core/constants.js';

// Strip HTML-significant chars from user-supplied label (server-side XSS guard).
function sanitizeLabel(raw) {
  return String(raw).replace(/[<>"'&]/g, '').trim().slice(0, 128);
}

// Accept either the literal 'default' (built-in soundfont) or a positive
// integer DB id. Numeric ids are returned as Number; 'default' is returned
// as the string for SF2PresetService to dispatch on.
function parseSF2Id(raw) {
  if (raw === 'default') return 'default';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Safely project only public fields from a DB row.
function publicRow(r) {
  return {
    id:         r.id,
    label:      r.label,
    filename:   r.filename,
    size:       r.size,
    reverbMix:  r.reverb_mix,
    uploadedAt: r.uploaded_at,
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
        banks: rows.map(publicRow),
      });
    } catch (err) {
      app.logger.error(`GET /api/sf2 failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Upload ───────────────────────────────────────────────────────────────
  router.post('/', expressRaw({ type: '*/*', limit: uploadLimit }), async (req, res) => {
    try {
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty body. Send raw SF2 bytes.' });
      }
      if (req.body.length > LIMITS.MAX_SF2_FILE_SIZE) {
        return res.status(413).json({ error: `File too large. Max ${LIMITS.MAX_SF2_FILE_SIZE / (1024 * 1024)} MB.` });
      }
      // H-1: validate both RIFF container header and sfbk type field
      if (req.body.slice(0, 4).toString('ascii') !== 'RIFF' ||
          req.body.slice(8, 12).toString('ascii') !== 'sfbk') {
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
  });

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
      const id      = parseSF2Id(req.params.id);
      const program = Number(req.params.program);
      if (id === null || !Number.isFinite(program) || program < 0 || program > 127) {
        return res.status(400).json({ error: 'Invalid id or program' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'melodic', program, 0, 0);
      if (!preset) return res.status(404).json({ error: 'Preset not found in this SF2' });
      res.json(preset);
    } catch (err) {
      app.logger.error(`GET /api/sf2/${req.params.id}/preset/melodic/${req.params.program} failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // ── Drum preset ───────────────────────────────────────────────────────────
  router.get('/:id/preset/drum/:kit/:note', async (req, res) => {
    try {
      const id   = parseSF2Id(req.params.id);
      const kit  = Number(req.params.kit);
      const note = Number(req.params.note);
      if (id === null
          || !Number.isFinite(kit)  || kit  < 0 || kit  > 127
          || !Number.isFinite(note) || note < 0 || note > 127) {
        return res.status(400).json({ error: 'Invalid id, kit, or note' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'drum', 0, kit, note);
      if (!preset) return res.status(404).json({ error: 'Drum preset not found in this SF2' });
      res.json(preset);
    } catch (err) {
      app.logger.error(`GET /api/sf2/${req.params.id}/preset/drum/${req.params.kit}/${req.params.note} failed: ${err.message}`);
      res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
