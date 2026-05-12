// public/js/audio/MidiSynthesizerConstants.js
// Module-level constants extracted from MidiSynthesizer.js (P2-F.8, plan §11 step 1).
// Exposed on `window.MidiSynthesizerConstants` because the codebase uses
// IIFE+globals (no ES modules in /public/js).

(function() {
  'use strict';

  /**
   * Built-in soundfont served locally by the backend (assets/sf2/default.sf2).
   * This is the only bank wired up out of the box: it makes the synth fully
   * offline-capable (no fetch to surikov.github.io). The actual samples are
   * loaded lazily through /api/sf2/default/preset/melodic/... and
   * /api/sf2/default/preset/drum/... — see MidiSynthesizer._loadSF2*.
   *
   * Drum-kit fan-out for SF2 banks is decided server-side: when a requested
   * kit is missing in the soundfont, SF2PresetService falls back to the
   * Standard Kit (program 0), so we still advertise the full GM list.
   */
  const BUILT_IN_DEFAULT_SF2_BANK = {
    id: 'sf2:default',
    label: 'GeneralUser GS (built-in)',
    suffix: null,
    quality: 'high',
    sizeMB: 30,
    descKey: 'settings.soundBank.banks.default',
    reverbMix: 0.12,
    isBuiltInSF2: true,
    sf2Id: 'default',
    drumKits: [0, 8, 16, 24, 25, 32, 40, 48, 56].map(function(p) {
      return { midiProgram: p, bankIndex: p, verified: true };
    })
  };

  /**
   * Legacy WAF banks served from surikov.github.io. Disabled by default
   * because they require an internet connection and trigger
   * OpaqueResponseBlocking in some browser/CORS configurations. Users who
   * want them back can flip `useExternalWaf = true` in localStorage
   * `gmboop_settings` (see SettingsModal).
   *
   * Quality tiers:
   *   high   — Professional-grade, large samples, rich harmonics
   *   medium — Good quality, balanced size, suitable for most use cases
   *   low    — Lightweight, fast loading, basic sound quality
   *
   * drumKits — drum kits available in this bank on the WAF CDN.
   */
  const WAF_BANKS = [
    {
      id: 'FluidR3_GM', label: 'FluidR3 GM', suffix: 'FluidR3_GM_sf2_file',
      quality: 'high', sizeMB: 141, descKey: 'settings.soundBank.banks.FluidR3_GM', reverbMix: 0.08,
      requiresExternal: true,
      drumKits: [
        { midiProgram:  0, bankIndex:  0, verified: true  },
        { midiProgram:  8, bankIndex:  8, verified: true  },
        { midiProgram: 16, bankIndex: 16, verified: true  },
        { midiProgram: 24, bankIndex: 24, verified: true  },
        { midiProgram: 25, bankIndex: 25, verified: true  },
        { midiProgram: 32, bankIndex: 32, verified: false },
        { midiProgram: 40, bankIndex: 40, verified: false },
        { midiProgram: 48, bankIndex: 48, verified: false },
        { midiProgram: 56, bankIndex: 56, verified: false }
      ]
    },
    {
      id: 'GeneralUserGS', label: 'GeneralUser GS (WAF)', suffix: 'GeneralUserGS_sf2_file',
      quality: 'high', sizeMB: 30, descKey: 'settings.soundBank.banks.GeneralUserGS', reverbMix: 0.12,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 0, verified: false }]
    },
    {
      id: 'JCLive', label: 'JCLive', suffix: 'JCLive_sf2_file',
      quality: 'medium', sizeMB: 26, descKey: 'settings.soundBank.banks.JCLive', reverbMix: 0.10,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 12, verified: true }]
    },
    {
      id: 'Aspirin', label: 'Aspirin', suffix: 'Aspirin_sf2_file',
      quality: 'medium', sizeMB: 17, descKey: 'settings.soundBank.banks.Aspirin', reverbMix: 0.14,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 0, verified: false }]
    },
    {
      id: 'SBLive', label: 'Sound Blaster Live', suffix: 'SBLive_sf2',
      quality: 'medium', sizeMB: 12, descKey: 'settings.soundBank.banks.SBLive', reverbMix: 0.14,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 0, verified: false }]
    },
    {
      id: 'Chaos', label: 'Chaos', suffix: 'Chaos_sf2_file',
      quality: 'low', sizeMB: 8, descKey: 'settings.soundBank.banks.Chaos', reverbMix: 0.16,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 0, verified: false }]
    },
    {
      id: 'SoundBlasterOld', label: 'Sound Blaster Old', suffix: 'SoundBlasterOld_sf2',
      quality: 'low', sizeMB: 5, descKey: 'settings.soundBank.banks.SoundBlasterOld', reverbMix: 0.18,
      requiresExternal: true,
      drumKits: [{ midiProgram: 0, bankIndex: 0, verified: false }]
    }
  ];

  // The new default. Replaces the previous 'FluidR3_GM' default, which was
  // served from a public CDN and broke every offline / sandboxed install.
  const DEFAULT_BANK_ID = 'sf2:default';
  const DEFAULT_BANK_SUFFIX = null;

  // Custom SF2 banks registered at runtime by SettingsSF2.loadCustomBanks()
  let _customBanks = [];

  function setCustomBanks(banks) {
    _customBanks = (banks || []).map(function(b) {
      return {
        id:         'sf2:' + b.id,
        label:      b.label + ' [SF2]',
        suffix:     null,
        quality:    'custom',
        sizeMB:     Math.round((b.size || 0) / (1024 * 1024)),
        reverbMix:  b.reverbMix != null ? b.reverbMix : 0.12,
        isCustom:   true,
        sf2Id:      b.id,
        drumKits: [0, 8, 16, 24, 25, 32, 40, 48, 56].map(function(p) {
          return { midiProgram: p, bankIndex: p, verified: false };
        }),
      };
    });
  }

  /**
   * Read the persisted opt-in for the WAF CDN. The flag lives in the same
   * localStorage blob as the rest of the user settings (gmboop_settings).
   * Defaults to false: nothing on the public WAF CDN is needed for normal
   * operation now that there is a built-in default SF2.
   * @returns {boolean}
   */
  function isExternalWafEnabled() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const raw = localStorage.getItem('gmboop_settings');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed && parsed.useExternalWaf === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Banks exposed to the rest of the UI. By default this is:
   *   [ built-in default SF2, ...custom SF2 banks ]
   * The legacy WAF banks are only included when the user has explicitly
   * opted in via `useExternalWaf = true` in their settings.
   */
  function getAvailableBanks() {
    const banks = [BUILT_IN_DEFAULT_SF2_BANK].concat(_customBanks);
    if (isExternalWafEnabled()) {
      return banks.concat(WAF_BANKS);
    }
    return banks;
  }

  window.MidiSynthesizerConstants = {
    // SOUND_BANKS used to be the canonical bank list. We keep the same name
    // for backwards compatibility (InstrumentSettingsModal still reads it),
    // but it now resolves to the gated list — never the legacy WAF banks.
    get SOUND_BANKS() {
      return Object.freeze([BUILT_IN_DEFAULT_SF2_BANK].map(function(b) { return Object.freeze(b); }));
    },
    BUILT_IN_DEFAULT_SF2_BANK: Object.freeze(BUILT_IN_DEFAULT_SF2_BANK),
    WAF_BANKS: Object.freeze(WAF_BANKS.map(function(b) { return Object.freeze(b); })),
    DEFAULT_BANK_ID,
    DEFAULT_BANK_SUFFIX,
    setCustomBanks,
    getAvailableBanks,
    isExternalWafEnabled,
  };
})();
