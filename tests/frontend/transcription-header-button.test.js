// tests/frontend/transcription-header-button.test.js
//
// The Audio → MIDI entry point is a header button that is HIDDEN by default
// and switched on from the global settings modal — the feature needs an
// engine installed separately, so it must not advertise itself on a fresh
// install.
//
// Three things are pinned: the button exists in the shipped header markup
// with an accessible name, the default setting is off, and the settings
// toggle really drives that button's visibility.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const INDEX = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.SettingsModal;
  // Enough of the i18n surface for the templates: they translate, ask for
  // the active locale, and list the available ones.
  window.i18n = {
    t: (key) => key,
    tHtml: (key) => key,
    getLocale: () => 'en',
    getSupportedLocales: () => [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'Français' }
    ],
    onLocaleChange: () => () => {}
  };
  global.i18n = window.i18n;
});

describe('header markup', () => {
  it('declares the button, hidden, with an accessible name and a title key', () => {
    const button = /<button[^>]*id="transcriptionBtn"[^>]*>/.exec(INDEX);
    expect(button, 'transcriptionBtn missing from the header').not.toBeNull();

    const tag = button[0];
    expect(tag).toMatch(/style="display:none;"/);
    expect(tag).toMatch(/aria-label="[^"]+"/);
    expect(tag).toMatch(/data-i18n-title="transcription\.headerButton"/);
  });

  it('loads the modal script and its stylesheet', () => {
    expect(INDEX).toContain('js/features/transcription/TranscriptionModal.js');
    expect(INDEX).toContain('styles/transcription-modal.css');
  });

  it('wires the click to the modal and reuses the existing editor/library code', () => {
    // The handler must not open a second editor or a second library: it
    // delegates to editFile / selectFile / loadFiles (§32/§48).
    const handler = INDEX.slice(
      INDEX.indexOf("getElementById('transcriptionBtn')"),
      INDEX.indexOf("getElementById('transcriptionBtn')") + 1400
    );
    expect(handler).toContain('new TranscriptionModal(api');
    expect(handler).toContain('editFile(');
    expect(handler).toContain('selectFile(');
    expect(handler).toContain('loadFiles()');
  });
});

describe('settings integration', () => {
  /**
   * SettingsModal, loaded with its mixins the way index.html does — the
   * class body references every mixin at module scope, so they all have to
   * be present before it is evaluated.
   */
  function loadSettingsModal() {
    const files = [
      'public/js/features/settings/SettingsTemplates.js',
      'public/js/features/settings/SettingsTheme.js',
      'public/js/features/settings/SettingsUpdate.js',
      'public/js/features/settings/SettingsSerial.js',
      'public/js/features/settings/SettingsBankEffects.js',
      'public/js/features/settings/SettingsHotspot.js',
      'public/js/features/settings/SettingsSF2.js',
      'public/js/features/SettingsModal.js'
    ];
    // One shared scope, as the browser has with plain <script> tags.
    const sources = files.map((f) => readFileSync(resolve(ROOT, f), 'utf8')).join('\n;\n');
    return new Function(`${sources}\nreturn SettingsModal;`)();
  }

  it('is off by default — a fresh install does not advertise the feature', () => {
    const Settings = loadSettingsModal();
    const defaults = Settings.prototype.loadSettings.call({ logger: null });
    expect(defaults.showTranscriptionButton).toBe(false);
  });

  it('declares the toggle so the shared apply/emit loop drives the button', () => {
    const Settings = loadSettingsModal();
    const entry = Settings.TOGGLE_BUTTONS.find((b) => b.settingKey === 'showTranscriptionButton');
    expect(entry).toBeDefined();
    expect(entry.elementId).toBe('transcriptionBtn');
    expect(entry.event).toBe('settings:transcription_button_changed');
  });

  it('shows and hides the real header button', () => {
    const Settings = loadSettingsModal();
    document.body.innerHTML = '<button id="transcriptionBtn" style="display:none;"></button>';
    const self = { settings: { showTranscriptionButton: true } };

    Settings.prototype._applyToggleButton.call(self, 'transcriptionBtn', true);
    expect(document.getElementById('transcriptionBtn').style.display).toBe('flex');

    Settings.prototype._applyToggleButton.call(self, 'transcriptionBtn', false);
    expect(document.getElementById('transcriptionBtn').style.display).toBe('none');
  });

  it('renders a labelled toggle row in the interface-buttons group', () => {
    const Settings = loadSettingsModal();
    // Render against the real prototype (every mixin is assigned onto it),
    // without running the constructor's DOM work.
    const self = Object.create(Settings.prototype);
    self.logger = null;
    self.settings = Settings.prototype.loadSettings.call(self);
    const html = self.renderContent();

    expect(html).toContain('showTranscriptionButtonToggle');
    expect(html).toContain('settings.transcriptionButton.title');
    // Unchecked by default, like the setting itself.
    const row = html.slice(html.indexOf('showTranscriptionButtonToggle') - 200);
    expect(row.slice(0, 400)).not.toMatch(/showTranscriptionButtonToggle[^>]*checked/);
  });
});
