/**
 * @file tests/e2e/specs/02-canonical.spec.mjs
 * @description The plan's canonical end-to-end journey, one recorded step each:
 *
 *   boot → virtual instrument → import MIDI → assign → adapt → play
 *        → edit in the MIDI editor → save → reload → verify it survived
 *
 * Every step is a `ctx.step()`, so a break at step 7 still reports steps 1-6 as
 * passed and names exactly where the journey stops. Nothing here is skipped to
 * keep the scenario green.
 */
import { suite, test, expect } from '../lib/runner.mjs';
import { newInstrumentedPage, shoot } from '../lib/browser.mjs';
import { AppPage } from '../lib/app.mjs';
import { writeFixtures } from '../fixtures/make-midi.mjs';

suite('02 · canonical scenario', () => {
  test(
    'boot → instrument → import → assign → adapt → play → edit → save → reload → verify',
    async (ctx, deps) => {
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      const fx = writeFixtures();
      const filename = 'e2e-two-channel.mid';

      try {
        // ── 1. boot ────────────────────────────────────────────────────────────
        await ctx.step('1 · boot the SPA', async () => {
          await app.open();
          // Virtual instruments are gated by a localStorage setting; enabling it
          // needs a reload for the management page to render the add button.
          await app.enableVirtualInstruments();
          await app.open();
        });

        // ── 2. virtual instrument ──────────────────────────────────────────────
        await ctx.step('2 · create a virtual instrument through the UI', async () => {
          await app.openInstruments();
          await app.createVirtualInstrumentViaUi({ preset: 'piano' });
          await page.waitForTimeout(1500);
          const devices = await app.listDevices();
          ctx.evidenceAdd(
            'devices after creation',
            devices.map((d) => `${d.id} · ${d.name} · ${d.type}`)
          );
          expect(devices.length).toBeGreaterThan(0);
          expect(devices.some((d) => d.type === 'virtual')).toBeTruthy(
            'a virtual device is registered'
          );
          ctx.state.deviceId = devices.find((d) => d.type === 'virtual').id;
        });
        await ctx.step(
          '2b · the instrument page closes and stops intercepting clicks',
          async () => {
            await app.closeInstruments();
            expect(await page.locator('.inst-mgmt-modal').count()).toBe(0);
          }
        );

        // ── 3. import ──────────────────────────────────────────────────────────
        await ctx.step('3 · import a MIDI file through the drop-zone input', async () => {
          await app.importMidiViaUi(fx.twoChannel);
          ctx.state.fileId = await app.waitForFileInList(filename);
          ctx.evidenceAdd('imported file id', ctx.state.fileId);
          const files = await app.filesInList();
          ctx.evidenceAdd('file list', files);
          expect(files.some((f) => f.name === filename)).toBeTruthy();
        });
        ctx.evidenceAdd(
          'screenshot after import',
          await shoot(page, deps.artifactsDir, '02-03-imported')
        );

        // ── 4. assign ──────────────────────────────────────────────────────────
        await ctx.step('4 · open the routing page and auto-assign every channel', async () => {
          await app.fileAction(filename, 'route');
          await page.waitForSelector('#routingSummaryModal', { timeout: 30000 });
          await page.waitForTimeout(2500);

          const before = await readAssignments(page);
          ctx.evidenceAdd('assignments before auto-routing', before);
          expect(before.length).toBeGreaterThan(0);

          await page.click('#rsAutoRoutingBtn');
          await page.waitForTimeout(4000);

          const after = await readAssignments(page);
          ctx.evidenceAdd('assignments after auto-routing', after);
          expect(after.every((a) => a.value !== 'ignore')).toBeTruthy(
            `every channel is assigned (got ${JSON.stringify(after)})`
          );
          ctx.state.score = (await page.textContent('#rsScoreBtn').catch(() => ''))
            .replace(/\s+/g, ' ')
            .trim();
          ctx.evidenceAdd('feasibility score', ctx.state.score);
        });
        ctx.evidenceAdd(
          'screenshot after assign',
          await shoot(page, deps.artifactsDir, '02-04-assigned')
        );

        // ── 5. adapt ───────────────────────────────────────────────────────────
        await ctx.step('5 · adaptation is engaged for the assignment', async () => {
          const cls = await page.getAttribute('#rsAutoAdaptToggle', 'class');
          ctx.evidenceAdd('adaptation toggle class', cls);
          // The toggle carries `active` when auto-adaptation will be baked in.
          if (!/\bactive\b/.test(cls || '')) {
            await page.click('#rsAutoAdaptToggle');
            await page.waitForTimeout(2500);
          }
          const now = await page.getAttribute('#rsAutoAdaptToggle', 'class');
          expect(/\bactive\b/.test(now || '')).toBeTruthy('adaptation is ON before applying');
        });

        await ctx.step('5b · apply the routing', async () => {
          await page.click('#rsSummaryApply');
          await page.waitForSelector('#routingSummaryModal', { state: 'detached', timeout: 30000 });
          await page.waitForTimeout(2500);
          const status = await app.command('file_routing_status', { fileId: ctx.state.fileId });
          ctx.evidenceAdd('file_routing_status after apply', status);
          expect(status.routedCount).toBeGreaterThan(0);
        });

        // ── 6. play ────────────────────────────────────────────────────────────
        await ctx.step('6 · play the file to the virtual instrument', async () => {
          await app.fileAction(filename, 'play');
          await page.waitForTimeout(2500);
          const st = await app.playbackStatus();
          ctx.evidenceAdd('playback_status while playing', st);
          expect(st.playing).toBeTruthy('backend reports playback in progress');
          expect(st.outputDevice).toBeTruthy('playback targets a device');
          expect(st.events).toBeGreaterThan(0);
          const header = await app.transportState();
          ctx.evidenceAdd('header transport while playing', header);
        });
        ctx.evidenceAdd(
          'screenshot while playing',
          await shoot(page, deps.artifactsDir, '02-06-playing')
        );

        await ctx.step('6b · Stop halts playback', async () => {
          await page.click('#headerStopBtn');
          await page.waitForTimeout(2000);
          const st = await app.playbackStatus();
          ctx.evidenceAdd('playback_status after stop', st);
          expect(st.playing).toBeFalsy('backend playback is stopped');
          // The *button state* after stopping is asserted by its own test below,
          // so a cosmetic transport bug does not hide steps 7-10 of the journey.
          ctx.evidenceAdd('header transport after stop', await app.transportState());
        });

        // ── 7. edit ────────────────────────────────────────────────────────────
        await ctx.step('7 · open the MIDI editor on the file', async () => {
          await app.fileAction(filename, 'edit');
          await page.waitForSelector('.midi-editor-modal', { timeout: 45000 });
          await page.waitForSelector('.piano-roll-canvas', { timeout: 30000 });
          await page.waitForTimeout(3500);
          const shape = await page.evaluate(() => ({
            channels: document.querySelectorAll(
              '.midi-editor-modal .channel-chip, .midi-editor-modal [class*="channel-chip"]'
            ).length,
            canvases: document.querySelectorAll('.midi-editor-modal canvas').length,
            tempo: document.querySelector('#tempo-input')?.value,
            hasSave: !!document.querySelector('#save-btn')
          }));
          ctx.evidenceAdd('editor shape', shape);
          expect(shape.hasSave).toBeTruthy('the editor exposes a Save button');
          ctx.state.tempoBefore = shape.tempo;
        });
        ctx.evidenceAdd(
          'screenshot of the editor',
          await shoot(page, deps.artifactsDir, '02-07-editor')
        );

        await ctx.step('7b · change the tempo in the editor header', async () => {
          // Capture the modal instance so the effect of the edit can be read from
          // the component's own state, not only from the input's displayed value
          // (a native <input> shows the typed value whether or not the app reacted).
          await page.evaluate(() => {
            const p = window.MidiEditorModal && window.MidiEditorModal.prototype;
            if (p && !p.__e2ePatched) {
              const orig = p.log;
              p.log = function (...a) {
                window.__midiEditorInstance = this;
                return orig.apply(this, a);
              };
              p.__e2ePatched = true;
            }
          });
          await page.fill('#tempo-input', '96');
          await page.dispatchEvent('#tempo-input', 'input');
          await page.dispatchEvent('#tempo-input', 'change');
          await page.waitForTimeout(1500);

          const shown = await page.inputValue('#tempo-input');
          ctx.evidenceAdd('tempo input shows', shown);
          const applied = await page.evaluate(() => {
            const i = window.__midiEditorInstance;
            return i ? { modalTempo: i.tempo, isDirty: i.isDirty } : null;
          });
          ctx.evidenceAdd('editor component state after the tempo edit', applied);
        });

        // Recorded, not thrown: the journey must keep going to steps 8-10 so the
        // report can say whether save / reload / verify work at all. The defect
        // itself is asserted end-to-end by step 10d and by its own test below.
        await ctx.softStep('7c · the tempo edit raises no uncaught exception', () => {
          const uncaught = rec.pageErrors.map((e) => e.message);
          ctx.evidenceAdd('uncaught page errors after the tempo edit', uncaught);
          if (uncaught.length) throw new Error(uncaught.join(' | '));
        });

        // ── 8. save ────────────────────────────────────────────────────────────
        await ctx.step('8 · save from the editor', async () => {
          ctx.state.before = await fileFingerprint(app, ctx.state.fileId);
          await page.click('#save-btn');
          await page.waitForTimeout(4000);
          ctx.state.after = await fileFingerprint(app, ctx.state.fileId);
          ctx.evidenceAdd('persisted file before save', ctx.state.before);
          ctx.evidenceAdd('persisted file after save', ctx.state.after);
          expect(ctx.state.after._keys.length).toBeGreaterThan(0);
        });
        ctx.evidenceAdd(
          'screenshot after save',
          await shoot(page, deps.artifactsDir, '02-08-saved')
        );

        // ── 9. reload ──────────────────────────────────────────────────────────
        await ctx.step('9 · reload the page', async () => {
          await app.open();
        });

        // ── 10. verify ─────────────────────────────────────────────────────────
        await ctx.step('10a · the virtual instrument survived the reload', async () => {
          const devices = await app.listDevices();
          ctx.evidenceAdd(
            'devices after reload',
            devices.map((d) => `${d.id} · ${d.name}`)
          );
          expect(devices.some((d) => d.id === ctx.state.deviceId)).toBeTruthy(
            'the virtual instrument created in step 2 is still registered'
          );
        });

        await ctx.step('10b · the imported file survived the reload', async () => {
          const files = await app.filesInList();
          ctx.evidenceAdd('file list after reload', files);
          expect(files.some((f) => f.name === filename)).toBeTruthy();
        });

        await ctx.step('10c · the routing survived the reload', async () => {
          const status = await app.command('file_routing_status', { fileId: ctx.state.fileId });
          ctx.evidenceAdd('file_routing_status after reload', status);
          expect(status.routedCount).toBeGreaterThan(0);
        });

        await ctx.step('10d · the edit survived the reload (tempo is 96 BPM)', async () => {
          const persisted = await fileFingerprint(app, ctx.state.fileId);
          ctx.evidenceAdd('persisted file after reload', persisted);
          await app.fileAction(filename, 'edit');
          await page.waitForSelector('#tempo-input', { timeout: 45000 });
          await page.waitForTimeout(3000);
          const tempo = await page.inputValue('#tempo-input');
          ctx.evidenceAdd('tempo shown by the editor after reload', tempo);
          ctx.evidenceAdd(
            'screenshot after reload',
            await shoot(page, deps.artifactsDir, '02-10-reloaded')
          );
          expect(persisted.tempo).toBe(96);
          expect(tempo).toBe('96');
        });
      } finally {
        ctx.evidenceAdd(
          'console errors over the whole journey',
          rec.errors().map((e) => `[${e.type}] ${e.text.slice(0, 250)}`)
        );
        ctx.evidenceAdd(
          'uncaught page errors over the whole journey',
          rec.pageErrors.map((e) => e.message)
        );
        await shoot(page, deps.artifactsDir, '02-final').catch(() => {});
        await page.context().close();
      }
    },
    { timeoutMs: 420000 }
  );
  test(
    "the MIDI editor's tempo control applies the tempo it displays",
    async (ctx, deps) => {
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      try {
        await ctx.step('open the editor on the imported file', async () => {
          await app.open();
          await page.evaluate(() => {
            const p = window.MidiEditorModal && window.MidiEditorModal.prototype;
            if (p && !p.__e2ePatched) {
              const orig = p.log;
              p.log = function (...a) {
                window.__midiEditorInstance = this;
                return orig.apply(this, a);
              };
              p.__e2ePatched = true;
            }
          });
          await app.fileAction('e2e-two-channel.mid', 'edit');
          await page.waitForSelector('#tempo-input', { timeout: 45000 });
          await page.waitForTimeout(3000);
        });

        await ctx.step('type a new tempo', async () => {
          await page.fill('#tempo-input', '84');
          await page.dispatchEvent('#tempo-input', 'input');
          await page.dispatchEvent('#tempo-input', 'change');
          await page.waitForTimeout(1200);
        });

        const state = await page.evaluate(() => {
          const i = window.__midiEditorInstance;
          return {
            shown: document.querySelector('#tempo-input')?.value,
            modalTempo: i ? i.tempo : null,
            isDirty: i ? i.isDirty : null
          };
        });
        ctx.evidenceAdd('input value vs component state', state);
        ctx.evidenceAdd(
          'uncaught page errors',
          rec.pageErrors.map((e) => e.message)
        );

        await ctx.step('no uncaught exception is raised by the tempo control', () => {
          expect(rec.pageErrors.map((e) => e.message).join(' | ')).toBe('');
        });
        await ctx.step('the component adopts the displayed tempo', () => {
          expect(state.modalTempo).toBe(84);
        });
      } finally {
        await page.context().close();
      }
    },
    { timeoutMs: 180000 }
  );

  test(
    'the header transport buttons reflect whether anything is playing',
    async (ctx, deps) => {
      const { page, rec } = await newInstrumentedPage(deps.browser);
      const app = new AppPage(page, rec, deps.server.baseUrl);
      const filename = 'e2e-two-channel.mid';
      try {
        await ctx.step('boot onto the state the journey left behind', () => app.open());

        const idle = await app.transportState();
        ctx.evidenceAdd('transport on a fresh page, nothing playing', idle);
        await ctx.step('on a fresh page with nothing playing, Stop is disabled', () => {
          expect(idle.stopDisabled).toBeTruthy();
        });

        await ctx.step('play, then stop', async () => {
          await app.fileAction(filename, 'play');
          await page.waitForTimeout(2000);
          expect((await app.playbackStatus()).playing).toBeTruthy();
          await page.click('#headerStopBtn');
          await page.waitForTimeout(2000);
        });

        const after = await app.transportState();
        const backend = await app.playbackStatus();
        ctx.evidenceAdd('backend after stop', backend);
        ctx.evidenceAdd('header after stop', after);
        await ctx.step('after Stop, the Stop button is disabled again', () => {
          expect(backend.playing).toBeFalsy('precondition: the backend really stopped');
          expect(after.stopDisabled).toBeTruthy('Stop stays clickable although nothing is playing');
        });
      } finally {
        await page.context().close();
      }
    },
    { timeoutMs: 180000 }
  );
});

/** @param {any} page @returns {Promise<Array<{value:string,text:string}>>} */
function readAssignments(page) {
  return page.$$eval('#routingSummaryModal select.rs-instrument-select', (sels) =>
    sels.map((s) => ({ value: s.value, text: (s.selectedOptions[0] || {}).textContent?.trim() }))
  );
}

/**
 * Summarise the persisted file so "did the save change anything" is answerable.
 *
 * `file_read` returns neither the raw bytes nor the parsed MIDI: its `midiData`
 * is a summary the backend computes by re-parsing the blob on disk. Observed
 * keys: `id · filename · midi · size · tracks · duration · tempo`. That is
 * exactly what is wanted here — the persisted file as the backend reads it back.
 * `_keys` is carried into the evidence so a shape change is visible in the
 * report instead of silently degrading an assertion.
 *
 * @param {AppPage} app @param {string} fileId
 * @returns {Promise<{tracks:number, events:number, tempo:number, duration:number, channels:number}>}
 */
async function fileFingerprint(app, fileId) {
  const res = await app.command('file_read', { fileId });
  const m = res?.midiData || {};
  return {
    _keys: Object.keys(m),
    tracks: m.tracks ?? -1,
    events: m.events ?? -1,
    tempo: m.tempo ?? -1,
    duration: m.duration != null ? +Number(m.duration).toFixed(3) : -1,
    channels: Array.isArray(m.channels) ? m.channels.length : (m.channels ?? -1)
  };
}
