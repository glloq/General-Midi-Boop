// tests/midi-baker-merge.test.js
// Audit B2 (baker): _mergeEventsIntoTrack must keep endOfTrack last — an
// injected CC whose tick is after the original end-of-track would otherwise
// sort after it and be dropped by spec-compliant players.

import { describe, test, expect } from '@jest/globals';
import MidiBaker from '../src/files/MidiBaker.js';

const baker = new MidiBaker({ logger: { info() {}, warn() {}, error() {}, debug() {} } });

describe('MidiBaker._mergeEventsIntoTrack — endOfTrack ordering (audit B2)', () => {
  test('a CC injected after the original endOfTrack is kept before it', () => {
    const track = [
      { deltaTime: 0, type: 'trackName', text: 't' },
      { deltaTime: 100, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 64 },
      { deltaTime: 0, type: 'endOfTrack' } // absolute tick 100
    ];
    const newCCEvents = [{ absTick: 200, channel: 0, controllerType: 11, value: 100 }];

    const out = baker._mergeEventsIntoTrack(track, newCCEvents);

    const ccIdx = out.findIndex((e) => e.type === 'controller' && e.controllerType === 11);
    const eotIdx = out.findIndex((e) => e.type === 'endOfTrack');
    expect(ccIdx).toBeGreaterThanOrEqual(0);
    expect(eotIdx).toBe(out.length - 1); // endOfTrack strictly last
    expect(ccIdx).toBeLessThan(eotIdx); // CC survives before it
  });

  test('a CC within the track is still ordered before same-tick noteOn', () => {
    const track = [
      { deltaTime: 100, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 64 },
      { deltaTime: 0, type: 'endOfTrack' }
    ];
    const newCCEvents = [{ absTick: 100, channel: 0, controllerType: 7, value: 90 }];
    const out = baker._mergeEventsIntoTrack(track, newCCEvents);
    const ccIdx = out.findIndex((e) => e.type === 'controller');
    const noteIdx = out.findIndex((e) => e.type === 'noteOn');
    expect(ccIdx).toBeLessThan(noteIdx); // controller precedes noteOn at same tick
  });
});
