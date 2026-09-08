/**
 * @file tests/audit/l06-live-vs-playback-cc-parity.test.js
 * @description Lot L06 — parité de filtrage des Control Change entre le
 * chemin *fichier* ({@link PlaybackScheduler}) et le chemin *live*
 * ({@link MidiRouter}).
 *
 * Les deux chemins consomment les mêmes capacités (`supported_ccs`,
 * `cc_enabled` du `string_instruments`). Ils doivent donc décider
 * IDENTIQUEMENT du sort d'un même CC vers une même destination — c'est la
 * classe de défaut de F-08 (« les mêmes octets se comportent différemment
 * selon le chemin »).
 *
 * Deux CC sont réservés par le protocole du projet :
 *   CC20 = STRING_SELECT, CC21 = FRET_SELECT (actionneurs de tablature).
 * Le scheduler les soumet à leur PROPRE porte (`isStringCCAllowed` :
 * instrument à cordes avec `cc_enabled`) et les exempte de `supported_ccs`.
 * Le routeur live doit faire pareil.
 */
import { describe, test, expect, jest } from '@jest/globals';
import MidiRouter from '../../src/midi/routing/MidiRouter.js';
import PlaybackScheduler from '../../src/midi/playback/PlaybackScheduler.js';
import { DEVICE_MSG_TYPES, MIDI_CC } from '../../src/core/constants.js';

const NULL_CONSTRAINTS = {
  minNoteInterval: null,
  minNoteDuration: null,
  polyphony: null,
  noteRangeMin: null,
  noteRangeMax: null,
  selectedNotes: null,
  octaveMode: null,
  scaleRoot: 0,
  supportedCcs: null,
  handCcs: null
};

/** Resolver stub shared by both runtimes so they see identical capabilities. */
function makeResolver({ supportedCcs = null, stringCcAllowed = false } = {}) {
  return {
    getTimingConstraints: () => ({ ...NULL_CONSTRAINTS, supportedCcs }),
    isStringCCAllowed: () => stringCcAllowed
  };
}

/** Send one CC through the LIVE router; returns true when it reached the device. */
function liveSendsCC(resolver, controller) {
  const deviceManager = { sendMessage: jest.fn(() => true) };
  const router = new MidiRouter({
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    eventBus: { on: () => {}, emit: () => {} },
    deviceRouteRepository: { findAll: () => [] },
    deviceManager,
    compensationService: null,
    capabilityResolver: resolver
  });
  router.routes.set('r1', {
    id: 'r1',
    enabled: true,
    destination: 'robot',
    filter: null,
    channelMap: null
  });
  router.routesBySource.set('kbd', new Set(['r1']));
  router.routeMessage('kbd', DEVICE_MSG_TYPES.CC, { channel: 0, controller, value: 64 });
  return deviceManager.sendMessage.mock.calls.some((c) => c[1] === DEVICE_MSG_TYPES.CC);
}

/** Send one CC through the FILE scheduler; returns true when it reached the device. */
function playbackSendsCC(resolver, controller) {
  const app = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    database: null,
    eventBus: { on: () => {} },
    wsServer: { broadcast: jest.fn() },
    deviceManager: { sendMessage: jest.fn(() => true) }
  };
  const scheduler = new PlaybackScheduler(app);
  scheduler._snapshot = resolver;
  scheduler.sendEvent(
    { type: 'controller', channel: 0, controller, value: 64 },
    {
      playing: true,
      channelRouting: new Map(),
      channelTransposition: new Map(),
      channelNoteRemapping: new Map(),
      mutedChannels: new Set(),
      disconnectedPolicy: 'skip'
    },
    () => ({ device: 'robot', targetChannel: 0 }),
    {}
  );
  return app.deviceManager.sendMessage.mock.calls.some((c) => c[1] === DEVICE_MSG_TYPES.CC);
}

describe('L06 · parité CC live ↔ playback', () => {
  test('CC ordinaire non déclaré : les deux chemins le rejettent', () => {
    const r = makeResolver({ supportedCcs: [7, 10] });
    expect(playbackSendsCC(r, 11)).toBe(false);
    expect(liveSendsCC(r, 11)).toBe(false);
  });

  test('CC ordinaire déclaré : les deux chemins le laissent passer', () => {
    const r = makeResolver({ supportedCcs: [7, 10] });
    expect(playbackSendsCC(r, 7)).toBe(true);
    expect(liveSendsCC(r, 7)).toBe(true);
  });

  test('aucun supported_ccs déclaré : tout passe des deux côtés', () => {
    const r = makeResolver({ supportedCcs: null });
    expect(playbackSendsCC(r, 11)).toBe(true);
    expect(liveSendsCC(r, 11)).toBe(true);
  });

  test('CC de sécurité (120-127) et Bank Select : exemptés des deux côtés', () => {
    const r = makeResolver({ supportedCcs: [7] });
    for (const cc of [
      MIDI_CC.ALL_SOUND_OFF,
      123,
      127,
      MIDI_CC.BANK_SELECT,
      MIDI_CC.BANK_SELECT_LSB
    ]) {
      expect(playbackSendsCC(r, cc)).toBe(true);
      expect(liveSendsCC(r, cc)).toBe(true);
    }
  });

  // --- Les deux cas qui divergeaient (audit L06) --------------------------

  test.each([MIDI_CC.STRING_SELECT, MIDI_CC.FRET_SELECT])(
    'CC%i (tablature) sur un instrument À CORDES : exempté de supported_ccs des deux côtés',
    (cc) => {
      // Instrument à cordes, cc_enabled → la porte cordes autorise ; la liste
      // supported_ccs ne mentionne pas 20/21 et ne doit PAS les faire tomber,
      // sinon les doigts mécaniques ne bougent jamais en jeu live.
      const r = makeResolver({ supportedCcs: [1, 7, 11], stringCcAllowed: true });
      expect(playbackSendsCC(r, cc)).toBe(true);
      expect(liveSendsCC(r, cc)).toBe(true);
    }
  );

  test.each([MIDI_CC.STRING_SELECT, MIDI_CC.FRET_SELECT])(
    'CC%i (tablature) sur un instrument NON à cordes : rejeté des deux côtés',
    (cc) => {
      // Pas d'instrument à cordes (ou cc_enabled=0) → la porte cordes refuse.
      // Le scheduler le fait déjà ; le routeur live doit s'aligner.
      const r = makeResolver({ supportedCcs: null, stringCcAllowed: false });
      expect(playbackSendsCC(r, cc)).toBe(false);
      expect(liveSendsCC(r, cc)).toBe(false);
    }
  );

  test('sans CapabilityResolver câblé, le routeur live reste passant (rétro-compat)', () => {
    const deviceManager = { sendMessage: jest.fn(() => true) };
    const router = new MidiRouter({
      logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
      eventBus: { on: () => {}, emit: () => {} },
      deviceRouteRepository: { findAll: () => [] },
      deviceManager,
      compensationService: null,
      capabilityResolver: undefined
    });
    router.routes.set('r1', {
      id: 'r1',
      enabled: true,
      destination: 'robot',
      filter: null,
      channelMap: null
    });
    router.routesBySource.set('kbd', new Set(['r1']));
    router.routeMessage('kbd', DEVICE_MSG_TYPES.CC, {
      channel: 0,
      controller: MIDI_CC.STRING_SELECT,
      value: 3
    });
    expect(deviceManager.sendMessage).toHaveBeenCalled();
  });
});
