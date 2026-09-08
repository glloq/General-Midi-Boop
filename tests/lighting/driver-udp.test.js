/**
 * @file tests/lighting/driver-udp.test.js
 * @description L02 / AB03–AB05 — the three UDP drivers (Art-Net, sACN/E1.31,
 * OSC) driven against a local `dgram` sink on 127.0.0.1. No lighting hardware,
 * no LAN traffic: the stub server IS the fixture.
 *
 * Covered per driver: connect, wire format, brightness scaling, range writes,
 * render batching, send rate, allOff, clean shutdown, write-after-close,
 * out-of-band failures.
 */

import { describe, test, expect, afterEach } from '@jest/globals';
import ArtNetDriver from '../../src/lighting/ArtNetDriver.js';
import SacnDriver from '../../src/lighting/SacnDriver.js';
import OscLightDriver from '../../src/lighting/OscLightDriver.js';
import { makeLogger, startUdpServer, tick } from './l02-fakes.js';

let open = [];
afterEach(async () => {
  for (const o of open) {
    try {
      await o.close?.();
    } catch {
      /* already closed */
    }
  }
  open = [];
});

function track(x) {
  open.push(x);
  return x;
}

const device = (over = {}) => ({
  id: 1,
  name: 'dmx',
  type: 'artnet',
  led_count: 4,
  enabled: true,
  connection_config: {},
  ...over
});

// ==================== Art-Net ====================

describe('L02 AB03 — ArtNetDriver against a local UDP sink', () => {
  async function connect(cfg = {}, ledCount = 4) {
    const srv = track(await startUdpServer());
    const logger = makeLogger();
    const d = new ArtNetDriver(
      device({
        led_count: ledCount,
        connection_config: { host: '127.0.0.1', port: srv.port, ...cfg }
      }),
      logger
    );
    await d.connect();
    track({ close: () => d.disconnect().catch(() => {}) });
    return { srv, d, logger };
  }

  test('connect() binds a socket and reports connected', async () => {
    const { d } = await connect();
    expect(d.isConnected()).toBe(true);
    expect(d.dmxData.length).toBe(4 * 3);
  });

  test('F-35: connect() succeeds against an address where nothing listens', async () => {
    // The driver only binds a LOCAL socket; it never proves a node exists.
    const logger = makeLogger();
    const d = new ArtNetDriver(
      device({ connection_config: { host: '192.0.2.1', port: 6454 } }), // TEST-NET-1
      logger
    );
    await d.connect();
    expect(d.isConnected()).toBe(true); // false positive, by construction
    await d.disconnect();
  });

  test('the emitted frame is a conformant Art-Net ArtDMX packet', async () => {
    const { srv, d } = await connect();
    d.setColor(0, 255, 128, 64, 255);
    await srv.waitFor(1);
    const p = srv.packets[0].msg;

    expect(p.subarray(0, 8).toString('latin1')).toBe('Art-Net\0');
    expect(p.readUInt16LE(8)).toBe(0x5000); // OpDmx
    expect(p.readUInt16BE(10)).toBe(14); // protocol version
    expect(p[13]).toBe(0); // physical
    expect(p.readUInt16BE(16)).toBe(12); // length = 4 LEDs × 3 ch
    expect(p.length).toBe(18 + 12);
    expect([...p.subarray(18, 21)]).toEqual([255, 128, 64]);
  });

  test('universe / subnet / net are encoded in the SubUni + Net bytes', async () => {
    const { srv, d } = await connect({ universe: 5, subnet: 2, net: 3 });
    d.setColor(0, 1, 2, 3, 255);
    await srv.waitFor(1);
    const p = srv.packets[0].msg;
    expect(p[14]).toBe((2 << 4) | 5);
    expect(p[15]).toBe(3);
  });

  test('the sequence byte increments and never wraps to 0', async () => {
    const { srv, d } = await connect();
    d.sequence = 254;
    for (let i = 0; i < 3; i++) {
      d.setColor(0, i, 0, 0, 255);
      await tick();
    }
    await srv.waitFor(3);
    const seqs = srv.packets.map((x) => x.msg[12]);
    expect(seqs).toEqual([255, 1, 2]);
  });

  test('brightness scales each component and is clamped at the driver', async () => {
    const { srv, d } = await connect();
    d.setColor(0, 200, 200, 200, 128);
    await srv.waitFor(1);
    expect(srv.packets[0].msg[18]).toBe(Math.round((200 * 128) / 255));

    d.setColor(1, 1000, -20, 200, 1000); // schemaless API can send this
    await tick();
    await srv.waitFor(2);
    const p = srv.packets[1].msg;
    expect(p[21]).toBe(255);
    expect(p[22]).toBe(0);
  });

  test('writes past the 512-channel universe are dropped, not wrapped', async () => {
    const { srv, d } = await connect({}, 300); // 300 × 3 = 900 → capped to 512
    expect(d.dmxData.length).toBe(512);
    d.setColor(200, 255, 255, 255, 255); // channel 600 → out of the buffer
    d.setColor(0, 10, 20, 30, 255);
    await srv.waitFor(1);
    const p = srv.packets[0].msg;
    expect(p.length).toBe(18 + 512);
    expect([...p.subarray(18, 21)]).toEqual([10, 20, 30]);
  });

  test('several writes in one tick are coalesced into ONE packet (microtask batching)', async () => {
    const { srv, d } = await connect();
    for (let i = 0; i < 4; i++) d.setColor(i, 255, 0, 0, 255);
    d.setRange(0, 3, 0, 255, 0, 255);
    await srv.waitFor(1);
    await tick();
    expect(srv.packets.length).toBe(1);
  });

  test('F-36: there is NO send-rate cap across ticks — 1 packet per MIDI event', async () => {
    const { srv, d } = await connect();
    const N = 30;
    for (let i = 0; i < N; i++) {
      d.setColor(0, i, 0, 0, 255);
      await tick(); // one macrotask = one inbound MIDI message
    }
    await srv.waitFor(N);
    // Art-Net nodes are normally refreshed at ≤44 Hz; nothing here throttles.
    expect(srv.packets.length).toBe(N);
  });

  test('setDmxChannel / setFixture / getDmxValues address raw channels safely', async () => {
    const { srv, d } = await connect();
    d.setDmxChannel(-1, 255);
    d.setDmxChannel(999, 255);
    d.setDmxChannel(5, 300); // clamped
    d.setFixture(0, [1, 2, 3, 4]);
    await srv.waitFor(1);
    expect(d.getDmxValues().slice(0, 6)).toEqual([1, 2, 3, 4, 0, 255]);
    expect(d.getDmxValues().length).toBe(12);
  });

  test('allOff() sends an all-zero universe immediately', async () => {
    const { srv, d } = await connect();
    d.setRange(0, 3, 255, 255, 255, 255);
    await srv.waitFor(1);
    d.allOff();
    await srv.waitFor(2);
    const last = srv.packets.at(-1).msg.subarray(18);
    expect([...last].every((b) => b === 0)).toBe(true);
  });

  test('F-30b: disconnect() blacks the universe out, closes the socket and emits disconnected', async () => {
    const { srv, d } = await connect();
    d.setRange(0, 3, 255, 0, 0, 255);
    await srv.waitFor(1);
    let emitted = false;
    d.on('disconnected', () => (emitted = true));
    await d.disconnect();
    await srv.waitFor(2);
    expect([...srv.packets.at(-1).msg.subarray(18)].every((b) => b === 0)).toBe(true);
    expect(emitted).toBe(true);
    expect(d.isConnected()).toBe(false);
    expect(d.socket).toBeNull();
  });

  test('a write after disconnect is a silent no-op, not a crash', async () => {
    const { d } = await connect();
    await d.disconnect();
    expect(() => {
      d.setColor(0, 255, 0, 0, 255);
      d.setRange(0, 3, 255, 0, 0, 255);
      d.allOff();
    }).not.toThrow();
  });

  test('a synchronous socket fault inside the render is absorbed by BaseLightingDriver', async () => {
    const { d, logger } = await connect();
    d.port = 99999; // out of range → dgram.send throws synchronously
    d.setColor(0, 255, 0, 0, 255);
    await tick();
    expect(logger._rec.warn.join(' ')).toMatch(/render failed/);
  });
});

// ==================== sACN / E1.31 ====================

describe('L02 AB04 — SacnDriver against a local UDP sink', () => {
  // E1.31 mandates UDP/5568; SacnDriver hard-codes it, so the stub binds it.
  const SACN_PORT = 5568;

  async function connect(cfg = {}, ledCount = 4) {
    let srv;
    try {
      srv = track(await startUdpServer(SACN_PORT));
    } catch (err) {
      return { skipped: err.message };
    }
    const logger = makeLogger();
    const d = new SacnDriver(
      device({
        type: 'sacn',
        led_count: ledCount,
        connection_config: { multicast: false, host: '127.0.0.1', ...cfg }
      }),
      logger
    );
    await d.connect();
    track({ close: () => d.disconnect().catch(() => {}) });
    return { srv, d, logger };
  }

  test('the emitted frame is a conformant E1.31 data packet', async () => {
    const { srv, d, skipped } = await connect({
      universe: 7,
      priority: 120,
      source_name: 'GMB-test'
    });
    if (skipped) return expect(skipped).toBeUndefined();
    d.setColor(0, 10, 20, 30, 255);
    await srv.waitFor(1);
    const p = srv.packets[0].msg;

    const slots = 4 * 3 + 1; // +1 DMX start code
    expect(p.length).toBe(125 + slots);
    expect(p.readUInt16BE(0)).toBe(0x0010); // preamble
    expect(p.readUInt16BE(2)).toBe(0x0000); // post-amble
    expect(p.subarray(4, 16).toString('latin1')).toBe('ASC-E1.17\0\0\0');
    expect(p.readUInt16BE(16)).toBe(0x7000 | (p.length - 16)); // root PDU length
    expect(p.readUInt32BE(18)).toBe(0x00000004); // VECTOR_ROOT_E131_DATA
    expect(p.readUInt16BE(38)).toBe(0x7000 | (p.length - 38)); // framing PDU
    expect(p.readUInt32BE(40)).toBe(0x00000002); // VECTOR_E131_DATA_PACKET
    expect(p.subarray(44, 52).toString('latin1')).toBe('GMB-test');
    expect(p[108]).toBe(120); // priority
    expect(p.readUInt16BE(113)).toBe(7); // universe
    expect(p.readUInt16BE(115)).toBe(0x7000 | (p.length - 115)); // DMP PDU
    expect(p[117]).toBe(0x02); // VECTOR_DMP_SET_PROPERTY
    expect(p[118]).toBe(0xa1);
    expect(p.readUInt16BE(123)).toBe(slots); // property value count
    expect(p[125]).toBe(0); // DMX start code
    expect([...p.subarray(126, 129)]).toEqual([10, 20, 30]);
  });

  test('the CID is a stable 16-byte identifier generated at connect()', async () => {
    const { d, skipped } = await connect();
    if (skipped) return expect(skipped).toBeUndefined();
    expect(d._cid.length).toBe(16);
    const first = Buffer.from(d._cid);
    d.setColor(0, 1, 1, 1, 255);
    expect(Buffer.compare(first, d._cid)).toBe(0);
  });

  test('the sequence byte wraps through 0 (E1.31 allows it, unlike Art-Net)', async () => {
    const { srv, d, skipped } = await connect();
    if (skipped) return expect(skipped).toBeUndefined();
    d.sequence = 254;
    for (let i = 0; i < 3; i++) {
      d.setColor(0, i, 0, 0, 255);
      await tick();
    }
    await srv.waitFor(3);
    expect(srv.packets.map((x) => x.msg[111])).toEqual([255, 0, 1]);
  });

  test('multicast mode targets 239.255.<hi>.<lo> derived from the universe', async () => {
    const logger = makeLogger();
    const d = new SacnDriver(
      device({ type: 'sacn', connection_config: { multicast: true, universe: 258 } }),
      logger
    );
    await d.connect();
    expect(d._getMulticastAddress()).toBe('239.255.1.2');
    await d.disconnect();
  });

  test('F-30b: disconnect() blacks out, closes and reports disconnected', async () => {
    const { srv, d, skipped } = await connect();
    if (skipped) return expect(skipped).toBeUndefined();
    d.setRange(0, 3, 255, 255, 255, 255);
    await srv.waitFor(1);
    await d.disconnect();
    await srv.waitFor(2);
    expect([...srv.packets.at(-1).msg.subarray(126)].every((b) => b === 0)).toBe(true);
    expect(d.isConnected()).toBe(false);
    expect(() => d.setColor(0, 1, 2, 3, 255)).not.toThrow();
  });
});

// ==================== OSC ====================

describe('L02 AB05 — OscLightDriver against a local UDP sink', () => {
  async function connect(cfg = {}, ledCount = 2) {
    const srv = track(await startUdpServer());
    const logger = makeLogger();
    const d = new OscLightDriver(
      device({
        type: 'osc',
        led_count: ledCount,
        connection_config: { host: '127.0.0.1', port: srv.port, ...cfg }
      }),
      logger
    );
    await d.connect();
    track({ close: () => d.disconnect().catch(() => {}) });
    return { srv, d, logger };
  }

  /** Decode a minimal OSC message (address, type tag, args). */
  function decode(buf) {
    const readStr = (off) => {
      let end = off;
      while (buf[end] !== 0) end++;
      const s = buf.subarray(off, end).toString('utf8');
      return [s, off + Math.ceil((end - off + 1) / 4) * 4];
    };
    const [address, o1] = readStr(0);
    const [tags, o2] = readStr(o1);
    const args = [];
    let off = o2;
    for (const t of tags.slice(1)) {
      args.push(t === 'f' ? buf.readFloatBE(off) : buf.readInt32BE(off));
      off += 4;
    }
    return { address, tags, args };
  }

  test('setColor emits one OSC message per LED with a float RGB payload', async () => {
    const { srv, d } = await connect({ address_pattern: '/gmb/led/{led}' });
    d.setColor(1, 255, 0, 128, 255);
    await srv.waitFor(1);
    const m = decode(srv.packets[0].msg);
    expect(m.address).toBe('/gmb/led/1');
    expect(m.tags).toBe(',fff');
    expect(m.args[0]).toBeCloseTo(1, 5);
    expect(m.args[1]).toBeCloseTo(0, 5);
    expect(m.args[2]).toBeCloseTo(128 / 255, 5);
  });

  test('OSC strings are null-terminated and 4-byte aligned', async () => {
    const { srv, d } = await connect({ address_pattern: '/abc/{led}' }); // 6 chars → 8 bytes
    d.setColor(0, 0, 0, 0, 0);
    await srv.waitFor(1);
    const buf = srv.packets[0].msg;
    expect(buf.length % 4).toBe(0);
    expect(buf[6]).toBe(0);
    expect(buf[7]).toBe(0);
  });

  test('rgb_int / rgbw_* formats change the type tag and argument count', async () => {
    const { srv, d } = await connect({ color_format: 'rgbw_int' });
    d.setColor(0, 10, 20, 30, 255);
    await srv.waitFor(1);
    const m = decode(srv.packets[0].msg);
    expect(m.tags).toBe(',iiii');
    expect(m.args).toEqual([10, 20, 30, 0]);
  });

  test('setRange is batched through _scheduleRender: one flush, one message per LED', async () => {
    const { srv, d } = await connect({}, 3);
    d.setRange(0, 2, 255, 255, 255, 255);
    d.setRange(0, 2, 0, 0, 0, 0);
    await srv.waitFor(6);
    await tick();
    expect(srv.packets.length).toBe(6); // 2 ranges × 3 LEDs, no coalescing per LED
  });

  test('allOff sends a master-off plus one black message per LED', async () => {
    const { srv, d } = await connect({}, 2);
    d.allOff();
    await srv.waitFor(3);
    const addrs = srv.packets.map((p) => decode(p.msg).address);
    expect(addrs[0]).toBe('/light/master');
    expect(addrs.slice(1)).toEqual(['/light/0', '/light/1']);
  });

  test('F-30b: disconnect() turns everything off, closes the socket, and later writes are inert', async () => {
    const { srv, d } = await connect({}, 2);
    await d.disconnect();
    await srv.waitFor(3);
    expect(d.socket).toBeNull();
    expect(() => d.setColor(0, 255, 0, 0, 255)).not.toThrow();
    expect(() => d.allOff()).not.toThrow();
  });
});
