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

import { Router, raw as expressRaw } from 'express';
import { LIMITS } from '../core/constants.js';

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
      const banks = rows.map(r => ({
        id:         r.id,
        label:      r.label,
        filename:   r.filename,
        size:       r.size,
        reverbMix:  r.reverb_mix,
        uploadedAt: r.uploaded_at,
      }));
      res.json({ banks });
    } catch (err) {
      app.logger.error(`GET /api/sf2 failed: ${err.message}`);
      res.status(500).json({ error: err.message });
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
      // Quick magic-byte validation: SF2 files start with 'RIFF'
      if (req.body.slice(0, 4).toString('ascii') !== 'RIFF') {
        return res.status(415).json({ error: 'Not a valid SF2 file (missing RIFF header).' });
      }
      const filename = String(req.query.filename || 'upload.sf2').trim();
      const result = await app.sf2PresetService.storeUpload(filename, req.body);
      const status = result.status === 'duplicate' ? 200 : 201;
      res.status(status).json(result);
    } catch (err) {
      app.logger.error(`POST /api/sf2 failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    try {
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update label / reverb ─────────────────────────────────────────────────
  router.patch('/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
      }
      const row = app.database.customSF2DB.getById(id);
      if (!row) return res.status(404).json({ error: 'Not found' });

      const updates = {};
      if (req.body?.label != null) updates.label = String(req.body.label).trim().slice(0, 128);
      if (req.body?.reverb_mix != null) {
        const v = Number(req.body.reverb_mix);
        if (Number.isFinite(v) && v >= 0 && v <= 1) updates.reverb_mix = v;
      }
      if (Object.keys(updates).length) {
        app.database.customSF2DB.update(id, updates);
      }
      res.json(app.database.customSF2DB.getById(id));
    } catch (err) {
      app.logger.error(`PATCH /api/sf2/${req.params.id} failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Melodic preset ────────────────────────────────────────────────────────
  router.get('/:id/preset/melodic/:program', async (req, res) => {
    try {
      const id      = Number(req.params.id);
      const program = Number(req.params.program);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(program) || program < 0 || program > 127) {
        return res.status(400).json({ error: 'Invalid id or program' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'melodic', program, 0, 0);
      if (!preset) return res.status(404).json({ error: 'Preset not found in this SF2' });
      res.json(preset);
    } catch (err) {
      app.logger.error(`GET /api/sf2/${req.params.id}/preset/melodic/${req.params.program} failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Drum preset ───────────────────────────────────────────────────────────
  router.get('/:id/preset/drum/:kit/:note', async (req, res) => {
    try {
      const id   = Number(req.params.id);
      const kit  = Number(req.params.kit);
      const note = Number(req.params.note);
      if (!Number.isFinite(id) || id <= 0
          || !Number.isFinite(kit)  || kit  < 0 || kit  > 127
          || !Number.isFinite(note) || note < 0 || note > 127) {
        return res.status(400).json({ error: 'Invalid id, kit, or note' });
      }
      const preset = await app.sf2PresetService.getPreset(id, 'drum', 0, kit, note);
      if (!preset) return res.status(404).json({ error: 'Drum preset not found in this SF2' });
      res.json(preset);
    } catch (err) {
      app.logger.error(`GET /api/sf2/${req.params.id}/preset/drum/${req.params.kit}/${req.params.note} failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
