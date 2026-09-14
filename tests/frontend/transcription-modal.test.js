// tests/frontend/transcription-modal.test.js
//
// The Audio → MIDI modal (§29-§32). What is pinned here is what a user can
// actually tell apart:
//   - a server with no engine gets an explanation, not a dead form;
//   - an option the chosen engine cannot honour is disabled, not ignored;
//   - progress with no number from the engine stays INDETERMINATE — the UI
//     never invents a percentage;
//   - the finished file is handed back to the EXISTING editor/library code;
//   - the WebSocket listeners are released when the modal closes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();

/** Minimal i18n: echo the key so assertions can look for it. */
function installI18n() {
  window.i18n = {
    t: (key, params) =>
      params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key,
    tHtml: (key) => key,
    onLocaleChange: () => () => {}
  };
  global.i18n = window.i18n;
}

/** A backend descriptor with sane defaults. */
function backend(overrides = {}) {
  return {
    id: 'mock-engine',
    name: 'Mock Engine',
    status: 'available',
    available: true,
    detail: null,
    capabilities: {
      polyphonic: true,
      multiInstrument: false,
      drums: false,
      pitchBend: true,
      dynamics: true,
      instrumentRecognition: false,
      tempoDetection: false,
      progress: true
    },
    runtime: { python: true, gpu: false, raspberryPiSuitable: true },
    licensing: { codeLicense: 'MIT', modelLicense: 'MIT', commercialUse: true },
    qualityProfiles: ['fast', 'balanced'],
    ...overrides
  };
}

/** An API double that records calls and can replay WS events. */
function makeApi(overrides = {}) {
  const listeners = new Map();
  const api = {
    listeners,
    uploads: [],
    cancelled: [],
    capabilities: { status: 'ready', detail: null, ffmpeg: { available: true }, backends: [] },
    backendList: [backend()],
    getTranscriptionCapabilities: vi.fn(async () => api.capabilities),
    listTranscriptionBackends: vi.fn(async () => api.backendList),
    transcribeAudioFile: vi.fn(async (file, options) => {
      api.uploads.push({ file, options });
      return { job: { id: 'job-abcdef0123456789', status: 'queued' } };
    }),
    getTranscriptionStatus: vi.fn(async () => ({
      job: { id: 'job-abcdef0123456789', status: 'transcribing', stage: 'transcribing' }
    })),
    cancelTranscription: vi.fn(async (jobId) => {
      api.cancelled.push(jobId);
      return { cancelled: true };
    }),
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off: (event, handler) => {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    emit: (event, data) => {
      for (const handler of [...(listeners.get(event) || [])]) handler(data);
    },
    ...overrides
  };
  return api;
}

/** Open the modal and let its async capability probe settle. */
async function openModal(api, options = {}) {
  const modal = new window.TranscriptionModal(api, options);
  modal.open();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return modal;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  delete window.BaseModal;
  delete window.TranscriptionModal;
  global.requestAnimationFrame = (cb) => cb();
  window.requestAnimationFrame = global.requestAnimationFrame;
  window.escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  global.escapeHtml = window.escapeHtml;
  installI18n();
  evalFile('public/js/core/BaseModal.js');
  evalFile('public/js/features/transcription/TranscriptionModal.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('availability (§29/§44)', () => {
  it('shows the conversion form when the server is ready', async () => {
    const modal = await openModal(makeApi());
    expect(document.getElementById('tr-dropzone')).not.toBeNull();
    expect(document.getElementById('tr-backend')).not.toBeNull();
    expect(document.getElementById('tr-start')).not.toBeNull();
    modal.close();
  });

  it('explains what is missing instead of showing a dead form', async () => {
    const api = makeApi();
    api.capabilities = {
      status: 'degraded',
      detail: 'No transcription engine is installed',
      ffmpeg: { available: false },
      backends: [backend({ status: 'not_installed', available: false })]
    };
    const modal = await openModal(api);

    const body = modal.dialog.querySelector('.modal-body').textContent;
    expect(document.getElementById('tr-dropzone')).toBeNull();
    expect(body).toContain('transcription.unavailable.ffmpeg');
    expect(body).toContain('transcription.unavailable.noEngine');
    // The engine list names each engine and its status.
    expect(body).toContain('Mock Engine');
    expect(body).toContain('transcription.status.not_installed');
    modal.close();
  });

  it('survives a server that answers nothing at all', async () => {
    const api = makeApi({
      getTranscriptionCapabilities: vi.fn(async () => {
        throw new Error('connection lost');
      })
    });
    const modal = await openModal(api);
    expect(modal.dialog.querySelector('.modal-body').textContent).toContain('connection lost');
    modal.close();
  });
});

describe('engine and options (§30)', () => {
  it('offers Automatic plus every engine, disabling the unavailable ones', async () => {
    const api = makeApi();
    api.backendList = [
      backend(),
      backend({ id: 'other', name: 'Other', available: false, status: 'not_installed' })
    ];
    const modal = await openModal(api);

    const options = [...document.getElementById('tr-backend').options];
    expect(options.map((o) => o.value)).toEqual(['auto', 'mock-engine', 'other']);
    expect(options[1].disabled).toBe(false);
    expect(options[2].disabled).toBe(true);
    modal.close();
  });

  it('disables the options the selected engine cannot honour', async () => {
    const api = makeApi();
    const modal = await openModal(api);

    const select = document.getElementById('tr-backend');
    select.value = 'mock-engine';
    select.dispatchEvent(new window.Event('change'));

    // The mock engine claims dynamics + pitchBend, but not drums.
    expect(modal.dialog.querySelector('[data-flag="preserveDynamics"]').disabled).toBe(false);
    expect(modal.dialog.querySelector('[data-flag="detectDrums"]').disabled).toBe(true);
    expect(modal.dialog.querySelector('[data-flag="detectDrums"]').checked).toBe(false);
    modal.close();
  });

  // `auto` is the default, so this is what almost every user sees. Leaving
  // every option enabled there let someone tick "Detect drums" for an engine
  // that finds none and get a silently empty result — the invented precision
  // §15 forbids.
  it('gates the options in auto mode on what the installed engines can do', async () => {
    const api = makeApi();
    const modal = await openModal(api);

    expect(document.getElementById('tr-backend').value).toBe('auto');
    expect(modal.dialog.querySelector('[data-flag="preserveDynamics"]').disabled).toBe(false);
    expect(modal.dialog.querySelector('[data-flag="detectDrums"]').disabled).toBe(true);
    expect(modal.dialog.querySelector('[data-flag="detectInstruments"]').disabled).toBe(true);
    modal.close();
  });

  it('keeps an option in auto mode when any installed engine could honour it', async () => {
    const api = makeApi();
    api.backendList = [
      backend(),
      backend({
        id: 'drum-engine',
        name: 'Drum Engine',
        capabilities: { ...backend().capabilities, drums: true }
      })
    ];
    const modal = await openModal(api);

    // The auto-picker may choose the one that can, so the option stays open.
    expect(modal.dialog.querySelector('[data-flag="detectDrums"]').disabled).toBe(false);
    // Neither engine does instruments, so that one is still closed.
    expect(modal.dialog.querySelector('[data-flag="detectInstruments"]').disabled).toBe(true);
    modal.close();
  });

  it('ignores an engine that is not installed when deciding what to offer', async () => {
    const api = makeApi();
    api.backendList = [
      backend(),
      backend({
        id: 'drum-engine',
        name: 'Drum Engine',
        status: 'installable',
        available: false,
        capabilities: { ...backend().capabilities, drums: true }
      })
    ];
    const modal = await openModal(api);

    // It could do drums, but it cannot run: offering the option would
    // promise something no engine on this box can deliver.
    expect(modal.dialog.querySelector('[data-flag="detectDrums"]').disabled).toBe(true);
    modal.close();
  });

  it('disables the quality levels the engine does not offer', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const select = document.getElementById('tr-backend');
    select.value = 'mock-engine';
    select.dispatchEvent(new window.Event('change'));

    const buttons = [...modal.dialog.querySelectorAll('.tr-quality')];
    const byQuality = Object.fromEntries(buttons.map((b) => [b.dataset.quality, b]));
    expect(byQuality.fast.disabled).toBe(false);
    expect(byQuality.balanced.disabled).toBe(false);
    expect(byQuality.maximum.disabled).toBe(true);
    modal.close();
  });

  it('shows the model licence, and flags a non-commercial one (§9/§33)', async () => {
    const api = makeApi();
    api.backendList = [
      backend({
        licensing: { codeLicense: 'Apache-2.0', modelLicense: 'CC-BY-NC-4.0', commercialUse: false }
      })
    ];
    const modal = await openModal(api);
    const select = document.getElementById('tr-backend');
    select.value = 'mock-engine';
    select.dispatchEvent(new window.Event('change'));

    const text = modal.dialog.querySelector('.modal-body').textContent;
    expect(text).toContain('Apache-2.0');
    expect(text).toContain('CC-BY-NC-4.0');
    expect(text).toContain('transcription.engine.nonCommercial');
    modal.close();
  });
});

describe('starting a conversion', () => {
  /** Put a file into the modal without a real file dialog. */
  function pickFile(modal, name = 'song.mp3') {
    modal._setFile({ name, size: 2048 });
  }

  it('keeps Convert disabled until a file is chosen', async () => {
    const modal = await openModal(makeApi());
    expect(document.getElementById('tr-start').disabled).toBe(true);
    pickFile(modal);
    expect(document.getElementById('tr-start').disabled).toBe(false);
    modal.close();
  });

  it('uploads with the chosen engine, quality and flags', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    pickFile(modal);

    const select = document.getElementById('tr-backend');
    select.value = 'mock-engine';
    select.dispatchEvent(new window.Event('change'));
    modal.dialog.querySelector('[data-quality="fast"]').click();
    const dynamics = modal.dialog.querySelector('[data-flag="preserveDynamics"]');
    dynamics.checked = false;
    dynamics.dispatchEvent(new window.Event('change'));

    document.getElementById('tr-start').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(api.transcribeAudioFile).toHaveBeenCalledTimes(1);
    const [, options] = api.transcribeAudioFile.mock.calls[0];
    expect(options.backendId).toBe('mock-engine');
    expect(options.quality).toBe('fast');
    expect(options.flags.preserveDynamics).toBe(false);
    modal.close();
  });

  it('sends no backendId in Automatic mode', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    pickFile(modal);
    document.getElementById('tr-start').click();
    await Promise.resolve();
    expect(api.transcribeAudioFile.mock.calls[0][1].backendId).toBeNull();
    modal.close();
  });

  it('reports an upload refusal instead of pretending to work', async () => {
    const api = makeApi({
      transcribeAudioFile: vi.fn(async () => {
        throw new Error('Unsupported file type ".exe"');
      })
    });
    const modal = await openModal(api);
    pickFile(modal, 'payload.exe');
    document.getElementById('tr-start').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.dialog.querySelector('.modal-body').textContent).toContain(
      'Unsupported file type'
    );
    modal.close();
  });
});

describe('progress (§31)', () => {
  async function running() {
    const api = makeApi();
    const modal = await openModal(api);
    modal._setFile({ name: 'song.mp3', size: 2048 });
    document.getElementById('tr-start').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return { api, modal };
  }

  it('lists every stage and marks the current one', async () => {
    const { api, modal } = await running();
    api.emit('transcription_progress', {
      jobId: 'job-abcdef0123456789',
      stage: 'transcribing',
      progress: null
    });

    const stages = [...modal.dialog.querySelectorAll('.tr-stage')];
    expect(stages.map((s) => s.dataset.stage)).toEqual([
      'preprocessing',
      'transcribing',
      'postprocessing',
      'generating_midi',
      'importing'
    ]);
    expect(stages[0].className).toContain('is-done');
    expect(stages[1].className).toContain('is-active');
    expect(stages[2].className).toContain('is-pending');
    modal.close();
  });

  it('stays indeterminate when the engine reports no progress', async () => {
    const { api, modal } = await running();
    api.emit('transcription_progress', {
      jobId: 'job-abcdef0123456789',
      stage: 'transcribing',
      progress: null
    });
    const bar = modal.dialog.querySelector('.tr-bar');
    expect(bar.className).toContain('is-indeterminate');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    modal.close();
  });

  it('shows a real percentage when the engine reports one', async () => {
    const { api, modal } = await running();
    api.emit('transcription_progress', {
      jobId: 'job-abcdef0123456789',
      stage: 'transcribing',
      progress: 0.42
    });
    const bar = modal.dialog.querySelector('.tr-bar');
    expect(bar.className).not.toContain('is-indeterminate');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(modal.dialog.querySelector('.tr-progress-text').textContent).toContain('42%');
    modal.close();
  });

  it('ignores events belonging to another job', async () => {
    const { api, modal } = await running();
    api.emit('transcription_progress', {
      jobId: 'job-somebody-else',
      stage: 'importing',
      progress: 1
    });
    expect(modal.job.stage).not.toBe('importing');
    modal.close();
  });

  it('cancels through the API and returns to the form', async () => {
    const { api, modal } = await running();
    document.getElementById('tr-cancel').click();
    await Promise.resolve();
    expect(api.cancelTranscription).toHaveBeenCalledWith('job-abcdef0123456789');

    api.emit('transcription_cancelled', { jobId: 'job-abcdef0123456789' });
    expect(document.getElementById('tr-dropzone')).not.toBeNull();
    modal.close();
  });
});

describe('result (§32)', () => {
  async function completed(extra = {}) {
    const api = makeApi();
    const opened = { openEditor: [], useFile: [], imported: [] };
    const modal = await openModal(api, {
      onOpenEditor: (id, name) => opened.openEditor.push([id, name]),
      onUseFile: (id) => opened.useFile.push(id),
      onImported: (id) => opened.imported.push(id)
    });
    modal._setFile({ name: 'song.mp3', size: 2048 });
    document.getElementById('tr-start').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    api.emit('transcription_complete', {
      jobId: 'job-abcdef0123456789',
      fileId: 42,
      summary: {
        trackCount: 2,
        noteCount: 310,
        duplicate: false,
        filename: 'song [Transcribed].mid',
        instruments: [
          { trackId: 't1', label: 'Piano', confidence: 0.96, noteCount: 250 },
          { trackId: 't2', label: null, confidence: null, noteCount: 60 }
        ]
      },
      warnings: ['12 low-confidence notes removed'],
      ...extra
    });
    return { api, modal, opened };
  }

  it('shows the detected instruments with their confidence', async () => {
    const { modal } = await completed();
    const text = modal.dialog.querySelector('.modal-body').textContent;
    expect(text).toContain('transcription.result.complete');
    expect(text).toContain('Piano');
    expect(text).toContain('96 %');
    // An instrument the engine could not name is labelled as unknown, not
    // guessed.
    expect(text).toContain('transcription.result.unknownInstrument');
    expect(text).toContain('12 low-confidence notes removed');
    modal.close();
  });

  it('refreshes the library as soon as the file lands', async () => {
    const { opened, modal } = await completed();
    expect(opened.imported).toEqual([42]);
    modal.close();
  });

  it('hands the file to the existing editor, then closes', async () => {
    const { opened } = await completed();
    document.getElementById('tr-open-editor').click();
    expect(opened.openEditor).toEqual([[42, 'song [Transcribed].mid']]);
    expect(document.getElementById('transcription-modal-overlay')).toBeNull();
  });

  it('hands the file to the library selection', async () => {
    const { opened } = await completed();
    document.getElementById('tr-use-file').click();
    expect(opened.useFile).toEqual([42]);
  });

  it('shows a failure with its message, and no file actions', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal._setFile({ name: 'song.mp3', size: 2048 });
    document.getElementById('tr-start').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    api.emit('transcription_failed', {
      jobId: 'job-abcdef0123456789',
      reason: 'BACKEND_TIMEOUT',
      message: 'Transcription took longer than 900s and was stopped',
      retryable: true
    });

    const text = modal.dialog.querySelector('.modal-body').textContent;
    expect(text).toContain('transcription.result.failed');
    expect(text).toContain('took longer than 900s');
    expect(document.getElementById('tr-open-editor')).toBeNull();
    modal.close();
  });

  it('starts over cleanly', async () => {
    const { modal } = await completed();
    document.getElementById('tr-again').click();
    expect(document.getElementById('tr-dropzone')).not.toBeNull();
    expect(document.getElementById('tr-start').disabled).toBe(true);
    expect(modal.job).toBeNull();
    modal.close();
  });
});

describe('hygiene', () => {
  it('releases every WebSocket listener on close', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    const attached = [...api.listeners.values()].reduce((n, l) => n + l.length, 0);
    expect(attached).toBeGreaterThan(0);

    modal.close();
    const remaining = [...api.listeners.values()].reduce((n, l) => n + l.length, 0);
    expect(remaining).toBe(0);
  });

  it('leaves no DOM behind after repeated open/close cycles', async () => {
    const api = makeApi();
    for (let i = 0; i < 3; i++) {
      const modal = await openModal(api);
      modal.close();
    }
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(0);
    expect(document.body.style.overflow).toBe('');
  });

  it('escapes a hostile file name instead of rendering it', async () => {
    const modal = await openModal(makeApi());
    modal._setFile({ name: '<img src=x onerror=alert(1)>.mp3', size: 10 });
    const html = modal.dialog.querySelector('.modal-body').innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    modal.close();
  });
});

// The page decides what a dropped file IS by asking this class, and hands
// audio over with `openWith`. Both are part of its contract now, not
// internals.
describe('entry point from the page', () => {
  const Modal = () => window.TranscriptionModal;
  const file = (name) => new window.File(['x'], name, { type: '' });

  it('recognises the formats it offers, and nothing else', () => {
    for (const name of ['song.mp3', 'SONG.MP3', 'take.flac', 'clip.mp4', 'voice.m4a']) {
      expect(Modal().isAudioFile(file(name))).toBe(true);
    }
    for (const name of ['song.mid', 'song.midi', 'notes.txt', 'mp3', 'song.mp3.txt', '']) {
      expect(Modal().isAudioFile(file(name))).toBe(false);
    }
  });

  it('survives a malformed file object rather than throwing on a drop', () => {
    expect(Modal().isAudioFile(null)).toBe(false);
    expect(Modal().isAudioFile({})).toBe(false);
  });

  it('builds its accept attribute from the same list', () => {
    const accept = Modal().acceptAttribute();
    for (const ext of Modal().AUDIO_EXTENSIONS) expect(accept).toContain(`.${ext}`);
    expect(accept.startsWith('.')).toBe(true);
    expect(accept).not.toContain('.mid,');
  });

  it('opens with the dropped file already chosen', async () => {
    const api = makeApi();
    const modal = new window.TranscriptionModal(api, {});
    modal.openWith(file('dropped.wav'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.isOpen).toBe(true);
    expect(modal.file?.name).toBe('dropped.wav');
    expect(modal.dialog.textContent).toContain('dropped.wav');
    modal.close();
  });

  it('takes a second file while already open on the picker', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.openWith(file('first.wav'));
    expect(modal.file?.name).toBe('first.wav');

    modal.openWith(file('second.mp3'));
    expect(modal.file?.name).toBe('second.mp3');
    modal.close();
  });

  it('does not interrupt a conversion that is already running', async () => {
    const api = makeApi();
    const modal = await openModal(api);
    modal.view = 'running';
    modal.job = { id: 'job-abcdef0123456789', status: 'transcribing' };

    modal.openWith(file('late.wav'));

    expect(modal.view).toBe('running');
    expect(modal.file).toBeNull();
    modal.close();
  });

  it('drops the file rather than pretend, when the server has no engine', async () => {
    const api = makeApi();
    api.capabilities = {
      status: 'disabled',
      detail: 'none',
      ffmpeg: { available: false },
      backends: []
    };
    const modal = new window.TranscriptionModal(api, {});
    modal.openWith(file('hopeful.wav'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(modal.view).toBe('unavailable');
    expect(modal.file).toBeNull();
    expect(modal._pendingFile).toBeNull();
    modal.close();
  });

  it('forgets a pending file when the modal is closed again', async () => {
    const api = makeApi();
    const modal = new window.TranscriptionModal(api, {});
    modal.openWith(file('abandoned.wav'));
    modal.close();
    expect(modal._pendingFile).toBeNull();
  });
});

// jsdom applies no stylesheets, so this reads the shipped CSS. The rule it
// checks is not obvious on sight, and was wrong once already: the raw
// "Choose File" button sat visible under the styled dropzone.
describe('the raw file input stays hidden', () => {
  const ROOT = resolve(__dirname, '..', '..');
  const CSS = readFileSync(resolve(ROOT, 'public', 'styles', 'transcription-modal.css'), 'utf8');
  const INDEX = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');

  it('outranks the global rule in index.html instead of tying with it', () => {
    // The rule it has to beat: specificity (0,1,1), against a bare class's
    // (0,1,0). Naming the type selector in our own rule settles it.
    expect(INDEX).toMatch(/input\[type="file"\]\s*\{[^}]*display:\s*block/);
    expect(CSS).toMatch(/input\[type='file'\]\.tr-hidden-input\s*\{\s*display:\s*none/);
  });

  it('does not reach for !important to win', () => {
    const at = CSS.indexOf('.tr-hidden-input');
    expect(CSS.slice(at, at + 120)).not.toContain('!important');
  });
});
