// public/js/audio/MidiSynthesizerConstants.js
// Module-level constants extracted from MidiSynthesizer.js (P2-F.8, plan §11 step 1).
// Exposed on `window.MidiSynthesizerConstants` because the codebase uses
// IIFE+globals (no ES modules in /public/js).

(function() {
  'use strict';

  /**
   * Available sound banks from the WebAudioFont CDN (surikov.github.io).
   * Each bank offers a different sonic rendering and variable memory footprint.
   *
   * Quality tiers:
   *   high   — Professional-grade, large samples, rich harmonics
   *   medium — Good quality, balanced size, suitable for most use cases
   *   low    — Lightweight, fast loading, basic sound quality
   *
   * sizeMB is the approximate total download size when all 128 GM instruments
   * are loaded (individual instruments are loaded on demand).
   *
   * drumKits — drum kits available in this bank on the WAF CDN.
   *   midiProgram : GM standard kit program (0=Standard, 8=Room, 16=Power…)
   *   bankIndex   : index used in the WAF filename  128{note}_{bankIndex}_{suffix}.js
   *                 (equals midiProgram for FluidR3_GM; differs for other fonts)
   *   verified    : true when CDN presence has been confirmed manually
   *
   * Only FluidR3_GM ships all 9 GM drum kits.  Other banks expose at most the
   * Standard Kit; _loadDrumPreset falls back to FluidR3_GM for kits they lack.
   *
   * TODO — verify bankIndex values for GeneralUserGS, Aspirin, SBLive, Chaos,
   * SoundBlasterOld by fetching 128036_0_{suffix}.js from the CDN and confirming
   * the file exists and defines the expected variable.  See TODO.md § Drum banks.
   */
  const SOUND_BANKS = [
    {
      id: 'FluidR3_GM', label: 'FluidR3 GM', suffix: 'FluidR3_GM_sf2_file',
      quality: 'high', sizeMB: 141, descKey: 'settings.soundBank.banks.FluidR3_GM', reverbMix: 0.08,
      // Only bank with all 9 GM drum kits; bankIndex === midiProgram for every kit.
      drumKits: [
        { midiProgram:  0, bankIndex:  0, verified: true  },  // Standard Kit
        { midiProgram:  8, bankIndex:  8, verified: true  },  // Room Kit
        { midiProgram: 16, bankIndex: 16, verified: true  },  // Power Kit
        { midiProgram: 24, bankIndex: 24, verified: true  },  // Electronic Kit
        { midiProgram: 25, bankIndex: 25, verified: true  },  // TR-808 Kit
        { midiProgram: 32, bankIndex: 32, verified: true  },  // Jazz Kit
        { midiProgram: 40, bankIndex: 40, verified: true  },  // Brush Kit
        { midiProgram: 48, bankIndex: 48, verified: true  },  // Orchestra Kit
        { midiProgram: 56, bankIndex: 56, verified: true  }   // SFX Kit
      ]
    },
    {
      id: 'GeneralUserGS', label: 'GeneralUser GS', suffix: 'GeneralUserGS_sf2_file',
      quality: 'high', sizeMB: 30, descKey: 'settings.soundBank.banks.GeneralUserGS', reverbMix: 0.12,
      drumKits: [
        { midiProgram: 0, bankIndex: 0, verified: false }  // Standard Kit — bankIndex to confirm
      ]
    },
    {
      id: 'JCLive', label: 'JCLive', suffix: 'JCLive_sf2_file',
      quality: 'medium', sizeMB: 26, descKey: 'settings.soundBank.banks.JCLive', reverbMix: 0.10,
      // WAF packages JCLive drums at bankIndex 12 (not 0) — confirmed by legacy fallback code.
      drumKits: [
        { midiProgram: 0, bankIndex: 12, verified: true }  // Standard Kit at WAF index 12
      ]
    },
    {
      id: 'Aspirin', label: 'Aspirin', suffix: 'Aspirin_sf2_file',
      quality: 'medium', sizeMB: 17, descKey: 'settings.soundBank.banks.Aspirin', reverbMix: 0.14,
      drumKits: [
        { midiProgram: 0, bankIndex: 0, verified: false }  // Standard Kit — bankIndex to confirm
      ]
    },
    {
      id: 'SBLive', label: 'Sound Blaster Live', suffix: 'SBLive_sf2',
      quality: 'medium', sizeMB: 12, descKey: 'settings.soundBank.banks.SBLive', reverbMix: 0.14,
      drumKits: [
        { midiProgram: 0, bankIndex: 0, verified: false }  // Standard Kit — bankIndex to confirm
      ]
    },
    {
      id: 'Chaos', label: 'Chaos', suffix: 'Chaos_sf2_file',
      quality: 'low', sizeMB: 8, descKey: 'settings.soundBank.banks.Chaos', reverbMix: 0.16,
      drumKits: [
        { midiProgram: 0, bankIndex: 0, verified: false }  // Standard Kit — bankIndex to confirm
      ]
    },
    {
      id: 'SoundBlasterOld', label: 'Sound Blaster Old', suffix: 'SoundBlasterOld_sf2',
      quality: 'low', sizeMB: 5, descKey: 'settings.soundBank.banks.SoundBlasterOld', reverbMix: 0.18,
      drumKits: [
        { midiProgram: 0, bankIndex: 0, verified: false }  // Standard Kit — bankIndex to confirm
      ]
    }
  ];

  const DEFAULT_BANK_ID = 'FluidR3_GM';
  const DEFAULT_BANK_SUFFIX = 'FluidR3_GM_sf2_file';

  window.MidiSynthesizerConstants = Object.freeze({
    SOUND_BANKS: Object.freeze(SOUND_BANKS.map((b) => Object.freeze(b))),
    DEFAULT_BANK_ID,
    DEFAULT_BANK_SUFFIX
  });
})();
