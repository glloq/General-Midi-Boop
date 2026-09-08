// tests/frontend/l10-dialogs-html-escaping.test.js
//
// Audit L10 (sécurité) — échappement HTML dans `MidiEditorDialogs`.
//
// Contexte : `showConfirmModal()` construit son markup par `innerHTML`. Le champ
// `details` est **volontairement** un fragment HTML brut (rangées `_detailRow`,
// blocs `confirm-choice-info`), donc tout ce qui y est injecté doit être échappé
// par l'appelant — soit via `tHtml()`, soit explicitement.
//
// Trois propriétés figées ici :
//   1. F-05 (audit 2026-08-22, ré-instruit en L10) : `message` est échappé.
//      C'est déjà vrai à HEAD ; ce test empêche la régression.
//   2. `title`, `confirmText`, `cancelText` et les `extraButtons` sont échappés.
//   3. F-111 (L10) : `showChangeInstrumentModal()` échappe les noms
//      d'instruments avant de les poser dans `details` — rangé raw.
//
// Le module est un IIFE navigateur : on l'évalue dans le jsdom de Vitest, avec
// le vrai `public/js/utils/escapeHtml.js`, pour tester le code réellement livré.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PAYLOAD = '"><img src=x onerror="window.__L10_DIALOG_XSS=1">';

let MidiEditorDialogs;

/** Fausse modale : uniquement ce que MidiEditorDialogs consomme. */
function makeModal(overrides = {}) {
  return {
    t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
    tHtml: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
    channels: [],
    selectedInstrument: 0,
    getInstrumentName: (i) => `GM ${i}`,
    ...overrides
  };
}

/** Rend une modale et renvoie l'overlay fraîchement ajouté au DOM. */
function renderNew(fn) {
  const before = new Set(document.querySelectorAll('.confirm-modal-overlay'));
  fn();
  return [...document.querySelectorAll('.confirm-modal-overlay')].find((el) => !before.has(el));
}

beforeAll(() => {
  // Le vrai utilitaire d'échappement du projet, pas une réimplémentation.
  const escSrc = readFileSync(resolve(__dirname, '../../public/js/utils/escapeHtml.js'), 'utf8');
  const modSrc = readFileSync(
    resolve(__dirname, '../../public/js/features/midi-editor/MidiEditorDialogs.js'),
    'utf8'
  );
  // eslint-disable-next-line no-eval
  (0, eval)(escSrc);
  // eslint-disable-next-line no-eval
  (0, eval)(modSrc);
  MidiEditorDialogs = window.MidiEditorDialogs;
});

describe('L10 — MidiEditorDialogs.showConfirmModal escaping', () => {
  it('expose la classe une fois le fichier évalué', () => {
    expect(typeof MidiEditorDialogs).toBe('function');
  });

  it('F-05 (ré-instruit) : `message` est échappé, pas interprété comme du HTML', () => {
    const dialogs = new MidiEditorDialogs(makeModal());
    const host = renderNew(() => dialogs.showConfirmModal({ title: 'T', message: PAYLOAD }));
    expect(host).toBeTruthy();
    expect(host.querySelectorAll('img').length).toBe(0);
    expect(host.querySelector('.confirm-modal-message').textContent).toContain('<img src=x');
  });

  it('`title`, `confirmText`, `cancelText` et `extraButtons` sont échappés', () => {
    const dialogs = new MidiEditorDialogs(makeModal());
    const host = renderNew(() =>
      dialogs.showConfirmModal({
        title: PAYLOAD,
        message: 'ok',
        confirmText: PAYLOAD,
        cancelText: PAYLOAD,
        extraButtons: [{ text: PAYLOAD, value: PAYLOAD, class: 'primary' }]
      })
    );
    expect(host.querySelectorAll('img').length).toBe(0);
    expect(host.querySelector('.confirm-modal-title').textContent).toContain('<img src=x');
    // L'attribut data-value survit intact une fois décodé — pas d'évasion.
    expect(host.querySelector('[data-action="extra"]').getAttribute('data-value')).toBe(PAYLOAD);
  });
});

describe('L10 — MidiEditorDialogs.showChangeInstrumentModal escaping (F-111)', () => {
  it("les noms d'instruments n'injectent pas de HTML dans `details`", () => {
    const dialogs = new MidiEditorDialogs(makeModal());
    const host = renderNew(() =>
      dialogs.showChangeInstrumentModal({
        noteCount: 0,
        channelNoteCount: 3,
        channel: 0,
        currentInstrument: PAYLOAD,
        newInstrument: PAYLOAD,
        hasSelection: false
      })
    );
    expect(host).toBeTruthy();
    const details = host.querySelector('.confirm-modal-details');
    expect(details).toBeTruthy();
    // La charge doit rester du texte : aucun élément injecté.
    expect(details.querySelectorAll('img').length).toBe(0);
    expect(details.textContent).toContain('<img src=x');
  });

  it("le chemin 'sélection' échappe lui aussi les noms d'instruments", () => {
    const dialogs = new MidiEditorDialogs(makeModal());
    const host = renderNew(() =>
      dialogs.showChangeInstrumentModal({
        noteCount: 4,
        channelNoteCount: 9,
        channel: 2,
        currentInstrument: PAYLOAD,
        newInstrument: PAYLOAD,
        hasSelection: true
      })
    );
    const details = host.querySelector('.confirm-modal-details');
    expect(details.querySelectorAll('img').length).toBe(0);
  });
});
