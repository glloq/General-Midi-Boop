// tests/frontend/ism-refresh-hands-on-program.test.js
// Regression guard for the audit issue where changing GM program only
// re-rendered the notes section; the hands section kept the old layout
// (e.g. keyboard form for a newly picked guitar) and the save payload
// did not match the instrument family, causing the new server-side
// hands_config validator to reject the save.
//
// Here we drive `_refreshHandsSectionForProgram` on a stubbed modal
// object and check three transitions: keyboard → strings (mode flip),
// keyboard → winds (hide), winds → strings (inject).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const familiesSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/InstrumentFamilies.js'),
  'utf8'
);
const sectionsSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/ISMSections.js'),
  'utf8'
);
const listenersSrc = readFileSync(
  resolve(__dirname, '../../public/js/features/instrument-settings/ISMListeners.js'),
  'utf8'
);

beforeAll(() => {
  new Function(familiesSrc)();
  window.InstrumentSettingsModal = { GM_CATEGORY_EMOJIS: {}, SECTIONS: [
    { id: 'identity', icon: '🎵', fallback: 'Identity' },
    { id: 'notes',    icon: '🎹', fallback: 'Notes' },
    { id: 'hands',    icon: '🫱', fallback: 'Hands', keyboardsOnly: true },
    { id: 'advanced', icon: '⚙️', fallback: 'Advanced' }
  ]};
  new Function(sectionsSrc)();
  new Function(listenersSrc)();
});

function makeStubModal(initialTab, { initialHands = true } = {}) {
  document.body.innerHTML = `
    <div class="ism-modal">
      <nav class="ism-sidebar">
        <button class="ism-nav-item" data-section="identity"></button>
        <button class="ism-nav-item" data-section="notes"></button>
        ${initialHands ? '<button class="ism-nav-item" data-section="hands"></button>' : ''}
        <button class="ism-nav-item" data-section="advanced"></button>
      </nav>
      <div class="ism-body">
        <div class="ism-section" data-section="identity"></div>
        <div class="ism-section" data-section="notes"></div>
        ${initialHands ? '<div class="ism-section" data-section="hands"><em>stale</em></div>' : ''}
        <div class="ism-section" data-section="advanced"></div>
      </div>
    </div>
  `;

  const modal = {
    activeSection: 'notes',
    _tab: initialTab,
    _switchedTo: null,
    $(sel) { return document.querySelector(sel); },
    $$(sel) { return Array.from(document.querySelectorAll(sel)); },
    _getActiveTab() { return this._tab; },
    _switchSection(id) { this._switchedTo = id; this.activeSection = id; },
    _renderSidebar() {
      const tab = this._getActiveTab();
      const show = window.ISMSections._shouldShowHandsSection(tab);
      let html = '<nav class="ism-sidebar">';
      for (const sec of window.InstrumentSettingsModal.SECTIONS) {
        if (sec.id === 'hands' && !show) continue;
        html += `<button class="ism-nav-item" data-section="${sec.id}"></button>`;
      }
      html += '</nav>';
      return html;
    }
  };
  // Bind the ISMListeners methods we need onto the stub.
  modal._refreshHandsSectionForProgram = window.ISMListeners._refreshHandsSectionForProgram;
  return modal;
}

describe('ISMListeners._refreshHandsSectionForProgram', () => {
  it('injects the hands section when switching from winds → strings', () => {
    const modal = makeStubModal(
      { settings: { gm_program: 73 }, channel: 0, stringInstrumentConfig: null }, // flute, no hands
      { initialHands: false }
    );
    // Hands section is absent at start.
    expect(document.querySelector('.ism-section[data-section="hands"]')).toBeNull();

    // User flips to acoustic guitar (gm_program 24).
    modal._tab = { settings: { gm_program: 24 }, channel: 0, stringInstrumentConfig: { num_strings: 6 } };
    modal._refreshHandsSectionForProgram();

    const hands = document.querySelector('.ism-section[data-section="hands"]');
    expect(hands).not.toBeNull();
    expect(hands.innerHTML).toMatch(/handsMode/);
    // Sidebar also acquires the hands button.
    const handsBtn = document.querySelector('.ism-nav-item[data-section="hands"]');
    expect(handsBtn).not.toBeNull();
  });

  it('swaps hands section layout when switching keyboard → strings', () => {
    // Piano → the existing section has semitones layout markers.
    const modal = makeStubModal(
      { settings: { gm_program: 0 }, channel: 0 },
      { initialHands: true }
    );
    // Populate hands section with a semitones-style placeholder so we can
    // check the refresh replaces it.
    document.querySelector('.ism-section[data-section="hands"]').innerHTML =
      '<input type="hidden" id="handsMode" value="semitones">';

    // User switches to classical guitar.
    modal._tab = { settings: { gm_program: 24 }, channel: 0, stringInstrumentConfig: { num_strings: 6 } };
    modal._refreshHandsSectionForProgram();

    const hiddenMode = document.querySelector('#handsMode');
    expect(hiddenMode).not.toBeNull();
    expect(hiddenMode.value).toBe('frets');
  });

  it('removes the hands section when switching out of a supported family', () => {
    const modal = makeStubModal(
      { settings: { gm_program: 0 }, channel: 0 }, // piano
      { initialHands: true }
    );
    // Fake that the user was on the hands section.
    modal.activeSection = 'hands';

    // Switch to flute (no hand-position).
    modal._tab = { settings: { gm_program: 73 }, channel: 0 };
    modal._refreshHandsSectionForProgram();

    expect(document.querySelector('.ism-section[data-section="hands"]')).toBeNull();
    expect(document.querySelector('.ism-nav-item[data-section="hands"]')).toBeNull();
    // Since hands was the active section, we fall back to notes.
    expect(modal._switchedTo).toBe('notes');
  });

  it('is a no-op when both before and after the change require no hands', () => {
    const modal = makeStubModal(
      { settings: { gm_program: 73 }, channel: 0 },
      { initialHands: false }
    );
    modal._tab = { settings: { gm_program: 72 }, channel: 0 }; // still winds
    modal._refreshHandsSectionForProgram();
    expect(document.querySelector('.ism-section[data-section="hands"]')).toBeNull();
  });
});
