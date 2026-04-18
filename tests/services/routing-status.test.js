// tests/services/routing-status.test.js
// Unit tests for the pure `computeRoutingStatus` function (P1-4.2).

import { describe, test, expect } from '@jest/globals';
import { computeRoutingStatus } from '../../src/midi/files/FileRoutingStatusService.js';

function make(file, routings, connectedDeviceIds) {
  return computeRoutingStatus({ file, routings, connectedDeviceIds });
}

describe('computeRoutingStatus', () => {
  test('unrouted when no routing exists', () => {
    const r = make({ channel_count: 3 }, []);
    expect(r.status).toBe('unrouted');
    expect(r.routedCount).toBe(0);
    expect(r.channelCount).toBe(3);
  });

  test('partial when some but not all channels are routed', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: 95 }
    ];
    const r = make({ channel_count: 3 }, routings);
    expect(r.status).toBe('partial');
    expect(r.routedCount).toBe(1);
  });

  test('playable when all channels routed with full compatibility', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: 100 },
      { device_id: 'b', enabled: true, compatibility_score: 100 }
    ];
    const r = make({ channel_count: 2 }, routings);
    expect(r.status).toBe('playable');
  });

  test('routed_incomplete when all routed but min score < 100', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: 100 },
      { device_id: 'b', enabled: true, compatibility_score: 80 }
    ];
    const r = make({ channel_count: 2 }, routings);
    expect(r.status).toBe('routed_incomplete');
  });

  test('playable when all scores are null (manual routings)', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: null },
      { device_id: 'b', enabled: true, compatibility_score: null }
    ];
    const r = make({ channel_count: 2 }, routings);
    expect(r.status).toBe('playable');
  });

  test('excludes disabled routings from the count', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: 100 },
      { device_id: 'b', enabled: false, compatibility_score: 100 }
    ];
    const r = make({ channel_count: 2 }, routings);
    expect(r.routedCount).toBe(1);
    expect(r.status).toBe('partial');
  });

  test('excludes routings to disconnected devices when filter is provided', () => {
    const routings = [
      { device_id: 'a', enabled: true, compatibility_score: 100 },
      { device_id: 'b', enabled: true, compatibility_score: 100 }
    ];
    const r = make({ channel_count: 2 }, routings, new Set(['a']));
    expect(r.routedCount).toBe(1);
    expect(r.status).toBe('partial');
  });

  test('reports isAdapted when file.is_original is 0', () => {
    const r = make({ channel_count: 1, is_original: 0 }, []);
    expect(r.isAdapted).toBe(true);
  });

  test('reports isAdapted when file.is_original is false', () => {
    const r = make({ channel_count: 1, is_original: false }, []);
    expect(r.isAdapted).toBe(true);
  });

  test('reports hasAutoAssigned when any enabled routing is auto-assigned', () => {
    const routings = [
      { device_id: 'a', enabled: true, auto_assigned: true, compatibility_score: 100 }
    ];
    const r = make({ channel_count: 1 }, routings);
    expect(r.hasAutoAssigned).toBe(true);
  });

  test('falls back to channelCount=1 when file.channel_count is 0 or missing', () => {
    expect(make({}, []).channelCount).toBe(1);
    expect(make({ channel_count: 0 }, []).channelCount).toBe(1);
  });
});
