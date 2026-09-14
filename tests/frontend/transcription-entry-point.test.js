// tests/frontend/transcription-entry-point.test.js
//
// Audio → MIDI has no button. Dropping an audio file anywhere on the
// interface — or picking one from the file browser — opens the conversion
// modal with that file already chosen.
//
// What that buys, and what these tests defend: there is exactly ONE idea of
// which files are audio (TranscriptionModal.AUDIO_EXTENSIONS). A second list
// on the page would drift, and the failure would be silent — a format the
// modal accepts, refused by the page with "no MIDI or audio file detected".

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const INDEX = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.SettingsModal;
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

describe('the page has no transcription button', () => {
  it('carries no header button and no handler for one', () => {
    expect(INDEX).not.toContain('transcriptionBtn');
    expect(INDEX).not.toContain('showTranscriptionButton');
  });

  it('still loads the modal and its stylesheet', () => {
    expect(INDEX).toContain('js/features/transcription/TranscriptionModal.js');
    expect(INDEX).toContain('styles/transcription-modal.css');
  });
});

describe('incoming files are routed by one function', () => {
  /** The body of `acceptIncomingFiles`, as shipped. */
  const router = INDEX.slice(
    INDEX.indexOf('function acceptIncomingFiles'),
    INDEX.indexOf('function acceptIncomingFiles') + 1600
  );

  it('is what the file picker, the drop zone and the page drop all call', () => {
    // Three call sites plus the definition: any path that brings a file in
    // goes through the same partition.
    const calls = INDEX.match(/acceptIncomingFiles\(/g) || [];
    expect(calls.length).toBe(4);
    expect(INDEX).toContain('acceptIncomingFiles(this.files)');
    expect(INDEX).toContain('acceptIncomingFiles(e.dataTransfer.files)');
  });

  it('asks the modal what counts as audio instead of keeping its own list', () => {
    const partition = INDEX.slice(
      INDEX.indexOf('function partitionIncomingFiles'),
      INDEX.indexOf('function partitionIncomingFiles') + 700
    );
    expect(partition).toContain('TranscriptionModal?.isAudioFile');
    // The only extensions spelled out here are MIDI's own.
    expect(partition).not.toMatch(/\.mp3|\.flac|\.wav/);
  });

  it('sends MIDI to the library and audio to the modal, never the reverse', () => {
    expect(router).toContain('uploadFile()');
    expect(router).toContain('openTranscriptionWith(audio[0])');
    // A mixed drop must not hand audio to the MIDI uploader: the input is
    // narrowed to the MIDI files first.
    expect(router).toContain('midi.forEach(f => dataTransfer.items.add(f))');
  });

  it('says something when a dropped file is neither', () => {
    expect(router).toMatch(/rejected > 0/);
    expect(router).toContain('No MIDI or audio file detected');
  });

  it('opens the modal reusing the existing editor and library code', () => {
    const opener = INDEX.slice(
      INDEX.indexOf('function openTranscriptionWith'),
      INDEX.indexOf('function openTranscriptionWith') + 1200
    );
    expect(opener).toContain('new TranscriptionModal(api');
    expect(opener).toContain('openWith(file)');
    // §32/§48: no second editor, no second library.
    expect(opener).toContain('editFile(');
    expect(opener).toContain('selectFile(');
    expect(opener).toContain('loadFiles()');
  });

  it('offers audio in the file picker too, from the modal list', () => {
    // Drag and drop alone would be painful on a tablet, which is a stated
    // target for this interface.
    expect(INDEX).toContain('window.TranscriptionModal.acceptAttribute()');
  });
});

// The modal explains what is missing once you get there. The drop zone's
// label is a promise made BEFORE you try, so on a server with no engine — or
// no FFmpeg — it must only mention MIDI.
describe('the label follows what the server can actually do', () => {
  /** A page just enough like index.html for the affordance code to run. */
  function makePage() {
    document.body.innerHTML = `
      <input type="file" id="fileInput" accept=".mid,.midi">
      <div class="upload-drop-zone">
        <div class="upload-drop-zone-text">
          <span data-i18n="ui.dropFilesHere">drop</span>
          <strong id="dropZoneBrowseLink" data-i18n="ui.clickToBrowse">midi only</strong>
        </div>
        <span id="dropZoneDesc" data-i18n="ui.dropZoneFormats">formats</span>
      </div>`;
  }

  /** The shipped functions, lifted out of the page and given a scope. */
  function loadAffordance(capabilitiesResult) {
    const source = INDEX.slice(
      INDEX.indexOf('let transcriptionAvailable = false;'),
      INDEX.indexOf('async function refreshTranscriptionAffordance') +
        INDEX.slice(INDEX.indexOf('async function refreshTranscriptionAffordance')).indexOf(
          '\n        }'
        ) +
        10
    );
    const api = { getTranscriptionCapabilities: async () => capabilitiesResult() };
    return new Function(
      'api',
      'i18n',
      'window',
      'document',
      `${source}
       return { applyTranscriptionAffordance, refreshTranscriptionAffordance,
                isAvailable: () => transcriptionAvailable };`
    )(api, window.i18n, window, document);
  }

  beforeEach(() => {
    makePage();
    window.TranscriptionModal = { acceptAttribute: () => '.wav,.mp3' };
  });

  it('promises MIDI only until the server says it can convert', () => {
    const a = loadAffordance(() => ({ status: 'ready' }));
    a.applyTranscriptionAffordance();

    expect(document.getElementById('dropZoneBrowseLink').dataset.i18n).toBe('ui.clickToBrowse');
    expect(document.getElementById('dropZoneDesc').dataset.i18n).toBe('ui.dropZoneFormats');
    expect(document.getElementById('fileInput').accept).toBe('.mid,.midi');
  });

  it('adds audio once the server reports it is ready', async () => {
    const a = loadAffordance(() => ({ status: 'ready' }));
    await a.refreshTranscriptionAffordance();

    expect(a.isAvailable()).toBe(true);
    expect(document.getElementById('dropZoneBrowseLink').dataset.i18n).toBe(
      'ui.clickToBrowseAudio'
    );
    expect(document.getElementById('dropZoneDesc').dataset.i18n).toBe('ui.dropZoneFormatsAudio');
    expect(document.getElementById('fileInput').accept).toBe('.mid,.midi,.wav,.mp3');
  });

  it('stays quiet when the engine is missing, not merely when it errors', async () => {
    for (const status of ['degraded', 'disabled', 'failed', undefined]) {
      makePage();
      const a = loadAffordance(() => ({ status }));
      await a.refreshTranscriptionAffordance();
      expect(a.isAvailable()).toBe(false);
      expect(document.getElementById('fileInput').accept).toBe('.mid,.midi');
    }
  });

  it('promises nothing when the command does not exist at all', async () => {
    const a = loadAffordance(() => {
      throw new Error('Unknown command: transcription_capabilities');
    });
    await a.refreshTranscriptionAffordance();

    expect(a.isAvailable()).toBe(false);
    expect(document.getElementById('dropZoneBrowseLink').dataset.i18n).toBe('ui.clickToBrowse');
  });

  it('swaps the key so a locale change re-renders the right variant', async () => {
    // Setting only textContent would be undone by the next data-i18n pass.
    const a = loadAffordance(() => ({ status: 'ready' }));
    await a.refreshTranscriptionAffordance();
    const strong = document.getElementById('dropZoneBrowseLink');
    expect(strong.getAttribute('data-i18n')).toBe('ui.clickToBrowseAudio');
    expect(strong.textContent).toBe('ui.clickToBrowseAudio'); // the i18n double echoes keys
  });

  it('is re-asked on every reconnection and on an engine change', () => {
    expect(INDEX).toContain('refreshTranscriptionAffordance();');
    expect(INDEX).toMatch(/api\.on\('transcription_backend_changed'/);
    expect(INDEX).toMatch(/api\.on\('transcription_install_complete'/);
  });

  it('keeps the promise while dragging instead of resetting it', () => {
    // setDropZoneDragText restores the label after a drag; it must read the
    // current key, not hardcode the MIDI-only one.
    const drag = INDEX.slice(
      INDEX.indexOf('function setDropZoneDragText'),
      INDEX.indexOf('function setDropZoneDragText') + 900
    );
    expect(drag).toContain("getAttribute('data-i18n')");
  });
});

describe('settings no longer mention a button', () => {
  function loadSettingsModal() {
    const files = [
      'public/js/features/settings/SettingsTemplates.js',
      'public/js/features/settings/SettingsTheme.js',
      'public/js/features/settings/SettingsUpdate.js',
      'public/js/features/settings/SettingsSerial.js',
      'public/js/features/settings/SettingsBankEffects.js',
      'public/js/features/settings/SettingsHotspot.js',
      'public/js/features/settings/SettingsSF2.js',
      'public/js/features/settings/SettingsTranscription.js',
      'public/js/features/SettingsModal.js'
    ];
    const sources = files.map((f) => readFileSync(resolve(ROOT, f), 'utf8')).join('\n;\n');
    return new Function(`${sources}\nreturn SettingsModal;`)();
  }

  it('has no toggle, no default and no row for it', () => {
    const Settings = loadSettingsModal();
    const defaults = Settings.prototype.loadSettings.call({ logger: null });
    expect(defaults).not.toHaveProperty('showTranscriptionButton');
    expect(
      Settings.TOGGLE_BUTTONS.find((b) => b.settingKey === 'showTranscriptionButton')
    ).toBeUndefined();

    const self = Object.create(Settings.prototype);
    self.logger = null;
    self.settings = Settings.prototype.loadSettings.call(self);
    expect(self.renderContent()).not.toContain('showTranscriptionButtonToggle');
  });

  it('still offers the engine section — installing is a settings job', () => {
    const Settings = loadSettingsModal();
    const self = Object.create(Settings.prototype);
    self.logger = null;
    self.settings = Settings.prototype.loadSettings.call(self);
    expect(self.renderContent()).toContain('transcriptionRefreshBtn');
  });
});
