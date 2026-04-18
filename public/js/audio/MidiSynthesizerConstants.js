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
   */
  const SOUND_BANKS = [
    { id: 'FluidR3_GM',     label: 'FluidR3 GM',        suffix: 'FluidR3_GM_sf2_file',   quality: 'high',   sizeMB: 141, descKey: 'settings.soundBank.banks.FluidR3_GM',     reverbMix: 0.08 },
    { id: 'GeneralUserGS',  label: 'GeneralUser GS',    suffix: 'GeneralUserGS_sf2_file', quality: 'high',   sizeMB: 30,  descKey: 'settings.soundBank.banks.GeneralUserGS',  reverbMix: 0.12 },
    { id: 'JCLive',         label: 'JCLive',            suffix: 'JCLive_sf2_file',        quality: 'medium', sizeMB: 26,  descKey: 'settings.soundBank.banks.JCLive',         reverbMix: 0.10 },
    { id: 'Aspirin',        label: 'Aspirin',           suffix: 'Aspirin_sf2_file',       quality: 'medium', sizeMB: 17,  descKey: 'settings.soundBank.banks.Aspirin',        reverbMix: 0.14 },
    { id: 'SBLive',         label: 'Sound Blaster Live',suffix: 'SBLive_sf2',             quality: 'medium', sizeMB: 12,  descKey: 'settings.soundBank.banks.SBLive',         reverbMix: 0.14 },
    { id: 'Chaos',          label: 'Chaos',             suffix: 'Chaos_sf2_file',         quality: 'low',    sizeMB: 8,   descKey: 'settings.soundBank.banks.Chaos',          reverbMix: 0.16 },
    { id: 'SoundBlasterOld',label: 'Sound Blaster Old', suffix: 'SoundBlasterOld_sf2',    quality: 'low',    sizeMB: 5,   descKey: 'settings.soundBank.banks.SoundBlasterOld',reverbMix: 0.18 }
  ];

  const DEFAULT_BANK_ID = 'FluidR3_GM';
  const DEFAULT_BANK_SUFFIX = 'FluidR3_GM_sf2_file';

  window.MidiSynthesizerConstants = Object.freeze({
    SOUND_BANKS: Object.freeze(SOUND_BANKS.map((b) => Object.freeze(b))),
    DEFAULT_BANK_ID,
    DEFAULT_BANK_SUFFIX
  });
})();
