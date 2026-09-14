// tests/frontend/transcription-settings-section.test.js
//
// The "Audio → MIDI engines" block of the global settings modal (§33).
//
// The property that matters legally, not just cosmetically: a model licence
// is always shown, and a non-commercial one is always MARKED. A user must be
// able to see, before installing anything, what they are allowed to do with
// the result.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const evalFile = (p) => new Function(readFileSync(resolve(ROOT, p), 'utf8'))();

/** Section host: the mixin talks to `this.modal`. */
function makeHost() {
  const modal = document.createElement('div');
  modal.innerHTML = window.SettingsTranscription.renderTranscriptionSection();
  document.body.appendChild(modal);
  return Object.assign(Object.create(window.SettingsTranscription), { modal });
}

function makeApi(overrides = {}) {
  return {
    getTranscriptionCapabilities: vi.fn(async () => ({
      status: 'ready',
      detail: null,
      ffmpeg: { available: true, version: '6.1.1' },
      backends: []
    })),
    listTranscriptionBackends: vi.fn(async () => [
      {
        id: 'basic-pitch',
        name: 'Basic Pitch',
        status: 'available',
        available: true,
        detail: null,
        capabilities: { polyphonic: true, pitchBend: true, drums: false, multiInstrument: false },
        licensing: { codeLicense: 'Apache-2.0', modelLicense: 'Apache-2.0', commercialUse: true }
      }
    ]),
    ...overrides
  };
}

/** Let the mixin's two awaits settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.SettingsTranscription;
  window.escapeHtml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  global.escapeHtml = window.escapeHtml;
  window.i18n = {
    t: (key, params) =>
      params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key
  };
  global.i18n = window.i18n;
  delete window.api;
  delete window.apiClient;
  evalFile('public/js/features/settings/SettingsTranscription.js');
});

describe('rendering', () => {
  it('renders the section with a refresh control', () => {
    const host = makeHost();
    expect(host.modal.querySelector('#transcriptionEnginesStatus')).not.toBeNull();
    expect(host.modal.querySelector('#transcriptionRefreshBtn')).not.toBeNull();
  });

  it('lists each engine with its status and what it can do', async () => {
    const host = makeHost();
    host.bindTranscriptionSection(makeApi());
    await settle();

    const text = host.modal.querySelector('#transcriptionEnginesList').textContent;
    expect(text).toContain('Basic Pitch');
    expect(text).toContain('transcription.status.available');
    expect(text).toContain('transcription.options.preservePitchBends');
    // A capability the engine does not claim is not advertised.
    expect(text).not.toContain('transcription.options.detectDrums');
  });

  it('shows FFmpeg presence and version', async () => {
    const host = makeHost();
    host.bindTranscriptionSection(makeApi());
    await settle();
    expect(host.modal.querySelector('#transcriptionEnginesStatus').textContent).toContain('6.1.1');
  });
});

describe('licensing (§9/§33)', () => {
  it('shows both licences for every engine', async () => {
    const host = makeHost();
    host.bindTranscriptionSection(makeApi());
    await settle();
    expect(host.modal.querySelector('#transcriptionEnginesList').textContent).toContain(
      'transcription.engine.licence:Apache-2.0,Apache-2.0'
    );
  });

  it('MARKS a non-commercial model instead of quietly listing it', async () => {
    const api = makeApi({
      listTranscriptionBackends: vi.fn(async () => [
        {
          id: 'restricted',
          name: 'Restricted Engine',
          status: 'license_restricted',
          available: false,
          capabilities: { multiInstrument: true },
          licensing: {
            codeLicense: 'Apache-2.0',
            modelLicense: 'CC-BY-NC-4.0',
            commercialUse: false
          }
        }
      ])
    });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    const list = host.modal.querySelector('#transcriptionEnginesList');
    expect(list.textContent).toContain('CC-BY-NC-4.0');
    expect(list.querySelector('.tr-settings-restricted')).not.toBeNull();
    expect(list.textContent).toContain('transcription.engine.nonCommercial');
  });

  it('shows a dash rather than inventing a licence it was not told', async () => {
    const api = makeApi({
      listTranscriptionBackends: vi.fn(async () => [
        { id: 'x', name: 'X', status: 'not_installed', available: false, licensing: {} }
      ])
    });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();
    expect(host.modal.querySelector('#transcriptionEnginesList').textContent).toContain(
      'transcription.engine.licence:—,—'
    );
  });
});

describe('degraded servers', () => {
  it('points at the documentation when no engine is installed', async () => {
    const api = makeApi({ listTranscriptionBackends: vi.fn(async () => []) });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    const text = host.modal.querySelector('#transcriptionEnginesList').textContent;
    expect(text).toContain('transcription.unavailable.noEngine');
    expect(text).toContain('transcription.unavailable.help');
  });

  it('shows the server error instead of an empty block', async () => {
    const api = makeApi({
      getTranscriptionCapabilities: vi.fn(async () => {
        throw new Error('connection lost');
      })
    });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();
    expect(host.modal.querySelector('#transcriptionEnginesStatus').textContent).toBe(
      'connection lost'
    );
  });

  it('stays inert when there is no API client at all', async () => {
    const host = makeHost();
    host.bindTranscriptionSection(null);
    await settle();
    expect(host.modal.querySelector('#transcriptionEnginesStatus').textContent).toBe(
      'transcription.unavailable.generic'
    );
  });
});

describe('refresh', () => {
  it('re-probes the server when asked', async () => {
    const api = makeApi();
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();
    expect(api.getTranscriptionCapabilities).toHaveBeenLastCalledWith(false);

    host.modal.querySelector('#transcriptionRefreshBtn').click();
    await settle();
    expect(api.getTranscriptionCapabilities).toHaveBeenLastCalledWith(true);
    expect(api.listTranscriptionBackends).toHaveBeenLastCalledWith(true);
  });
});

describe('escaping', () => {
  it('never renders a hostile engine name as markup', async () => {
    const api = makeApi({
      listTranscriptionBackends: vi.fn(async () => [
        {
          id: 'evil',
          name: '<img src=x onerror=alert(1)>',
          status: 'available',
          available: true,
          detail: '<script>alert(2)</script>',
          licensing: { codeLicense: 'MIT', commercialUse: true }
        }
      ])
    });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    const html = host.modal.querySelector('#transcriptionEnginesList').innerHTML;
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });
});

// ---------------------------------------------------------------------------
// Installing and removing engines (§34). The property that matters: a licence
// requiring consent is never installed until the user has SEEN it and said
// yes, and the acceptance names the licence that was actually displayed.

describe('install actions', () => {
  /** Engines with an installer, plus the client calls they trigger. */
  function installableApi(backends, overrides = {}) {
    return {
      installed: [],
      removed: [],
      getTranscriptionCapabilities: vi.fn(async () => ({
        status: 'degraded',
        detail: null,
        ffmpeg: { available: true, version: '6.1.1' },
        backends: []
      })),
      listTranscriptionBackends: vi.fn(async () => backends),
      installTranscriptionBackend: vi.fn(async function (id, options) {
        this.installed.push({ id, options });
        return { backend: null };
      }),
      uninstallTranscriptionBackend: vi.fn(async function (id) {
        this.removed.push(id);
        return { backend: null };
      }),
      ...overrides
    };
  }

  const permissive = {
    id: 'basic-pitch',
    name: 'Basic Pitch',
    status: 'installable',
    available: false,
    licensing: {
      codeLicense: 'Apache-2.0',
      modelLicense: 'Apache-2.0',
      commercialUse: true,
      requiresConsent: false
    }
  };

  const restricted = {
    id: 'restricted',
    name: 'Restricted Engine',
    status: 'license_restricted',
    available: false,
    licensing: {
      codeLicense: 'Apache-2.0',
      modelLicense: 'CC-BY-NC-4.0',
      commercialUse: false,
      requiresConsent: true,
      notice: 'Weights are non-commercial',
      licenseUrl: 'https://example.invalid/licence'
    }
  };

  it('offers Install for an installable engine', async () => {
    const api = installableApi([permissive]);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();
    expect(host.modal.querySelector('[data-install="basic-pitch"]')).not.toBeNull();
    expect(host.modal.querySelector('[data-uninstall="basic-pitch"]')).toBeNull();
  });

  it('offers Uninstall for a ready one, Repair + Uninstall for a broken one', async () => {
    const api = installableApi([
      { ...permissive, status: 'available', available: true },
      { ...permissive, id: 'broken-one', name: 'Broken', status: 'broken' }
    ]);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    expect(host.modal.querySelector('[data-uninstall="basic-pitch"]')).not.toBeNull();
    expect(host.modal.querySelector('[data-install="basic-pitch"]')).toBeNull();
    expect(host.modal.querySelector('[data-install="broken-one"]')).not.toBeNull();
    expect(host.modal.querySelector('[data-uninstall="broken-one"]')).not.toBeNull();
  });

  it('offers no button at all for an engine with no automated installer', async () => {
    const api = installableApi([{ ...permissive, status: 'not_installed' }]);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();
    expect(host.modal.querySelectorAll('[data-install], [data-uninstall]')).toHaveLength(0);
  });

  it('installs a permissive engine without prompting', async () => {
    const api = installableApi([permissive]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    host.modal.querySelector('[data-install="basic-pitch"]').click();
    await settle();

    expect(confirm).not.toHaveBeenCalled();
    expect(api.installed).toHaveLength(1);
    expect(api.installed[0].options.acceptLicense).toBe(true);
  });

  it('shows the licence and only installs on a yes', async () => {
    const api = installableApi([restricted]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    host.modal.querySelector('[data-install="restricted"]').click();
    await settle();

    expect(confirm).toHaveBeenCalledTimes(1);
    const shown = confirm.mock.calls[0][0];
    expect(shown).toContain('CC-BY-NC-4.0');
    expect(shown).toContain('Weights are non-commercial');
    expect(shown).toContain('https://example.invalid/licence');
    // Refused: nothing is installed.
    expect(api.installed).toHaveLength(0);
  });

  it('sends the licence it displayed, so a stale page cannot consent', async () => {
    const api = installableApi([restricted]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    host.modal.querySelector('[data-install="restricted"]').click();
    await settle();

    expect(api.installed[0].options).toEqual({
      acceptLicense: true,
      acceptedModelLicense: 'CC-BY-NC-4.0'
    });
  });

  it('confirms before removing an engine', async () => {
    const api = installableApi([{ ...permissive, status: 'available', available: true }]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    host.modal.querySelector('[data-uninstall="basic-pitch"]').click();
    await settle();
    expect(confirm).toHaveBeenCalled();
    expect(api.removed).toHaveLength(0);

    confirm.mockReturnValue(true);
    host.modal.querySelector('[data-uninstall="basic-pitch"]').click();
    await settle();
    expect(api.removed).toEqual(['basic-pitch']);
  });

  it('shows a refusal from the server instead of swallowing it', async () => {
    const api = installableApi([permissive], {
      installTranscriptionBackend: vi.fn(async () => {
        throw new Error('Not enough free space: 120 MB available');
      })
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    host.modal.querySelector('[data-install="basic-pitch"]').click();
    await settle();
    expect(host.modal.querySelector('[data-install-status="basic-pitch"]').textContent).toContain(
      'Not enough free space'
    );
  });

  it('follows an install started elsewhere, and releases its listeners', async () => {
    const listeners = new Map();
    const api = installableApi([permissive], {
      on: (event, handler) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
      },
      off: (event, handler) => {
        const list = listeners.get(event) || [];
        const index = list.indexOf(handler);
        if (index !== -1) list.splice(index, 1);
      }
    });
    const host = makeHost();
    host.bindTranscriptionSection(api);
    await settle();

    for (const handler of listeners.get('transcription_install_progress') || []) {
      handler({ backendId: 'basic-pitch', stage: 'downloading' });
    }
    expect(host.modal.querySelector('[data-install-status="basic-pitch"]').textContent).toContain(
      'downloading'
    );

    host.unbindTranscriptionSection();
    const remaining = [...listeners.values()].reduce((n, l) => n + l.length, 0);
    expect(remaining).toBe(0);
  });
});
