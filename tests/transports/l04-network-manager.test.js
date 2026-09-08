// tests/transports/l04-network-manager.test.js
//
// Lot L04 — §N01 / §N02 : NetworkManager (0 % de couverture avant ce lot)
// exercé contre un PAIR APPLEMIDI LOCAL en `dgram` sur 127.0.0.1.
// Aucun matériel, aucun pair macOS/iOS : le protocole AppleMIDI est du pur
// UDP, donc un faux pair de 80 lignes suffit à valider tout le chemin
// invitation → session → flux RTP-MIDI → fin de session.
//
// Couvre : liaison des sockets partagées, repli éphémère sur port occupé,
// poignée de main IN/OK sur les deux ports, refus (NO), flux de données,
// running status sur le fil, paquets PERDUS / DUPLIQUÉS / RÉORDONNÉS /
// TRONQUÉS, session entrante (rôle répondeur), déconnexion, arrêt propre.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import dgram from 'dgram';
import NetworkManager from '../../src/transports/NetworkManager.js';
import {
  CMD,
  commandOf,
  decodeInvitation,
  encodeInvitation
} from '../../src/transports/AppleMidi.js';

const LOOPBACK = '127.0.0.1';
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// Blocs de 4 ports (2 pour le manager, 2 pour le pair). La base dépend du PID
// pour ne pas entrer en collision avec les autres agents du même arbre.
let portCursor = 21000 + (process.pid % 900) * 8;
function nextPortBlock() {
  portCursor += 8;
  return portCursor;
}

/** Faux pair AppleMIDI : deux sockets UDP (contrôle + données). */
class FakeApplePeer {
  constructor(controlPort, { mode = 'accept' } = {}) {
    this.controlPort = controlPort;
    this.dataPort = controlPort + 1;
    this.mode = mode; // 'accept' | 'reject' | 'silent'
    this.control = dgram.createSocket('udp4');
    this.data = dgram.createSocket('udp4');
    this.controlRx = [];
    this.dataRx = [];
    this.ssrc = 0xfeed0001;
  }

  async start() {
    this.control.on('message', (msg, rinfo) => {
      this.controlRx.push(msg);
      if (this.mode === 'silent') return;
      if (commandOf(msg) === CMD.INVITATION) {
        const inv = decodeInvitation(msg);
        const reply = this.mode === 'reject' ? CMD.INVITATION_REJECTED : CMD.INVITATION_ACCEPTED;
        this.control.send(
          encodeInvitation(reply, {
            initiatorToken: inv.initiatorToken,
            ssrc: this.ssrc,
            name: 'FakePeer'
          }),
          rinfo.port,
          rinfo.address
        );
      }
    });
    this.data.on('message', (msg, rinfo) => {
      this.dataRx.push(msg);
      this.managerDataPort = rinfo.port;
      if (this.mode === 'silent') return;
      if (commandOf(msg) === CMD.INVITATION) {
        const inv = decodeInvitation(msg);
        this.data.send(
          encodeInvitation(CMD.INVITATION_ACCEPTED, {
            initiatorToken: inv.initiatorToken,
            ssrc: this.ssrc,
            name: 'FakePeer'
          }),
          rinfo.port,
          rinfo.address
        );
      }
    });
    await Promise.all([
      new Promise((r) => this.control.bind(this.controlPort, LOOPBACK, r)),
      new Promise((r) => this.data.bind(this.dataPort, LOOPBACK, r))
    ]);
  }

  /** Envoie un datagramme brut vers le port DONNÉES du manager. */
  sendData(buf, managerDataPort) {
    this.data.send(buf, managerDataPort, LOOPBACK);
  }

  async close() {
    await Promise.all([
      new Promise((r) => this.control.close(r)),
      new Promise((r) => this.data.close(r))
    ]);
  }
}

/** Encodeur RTP-MIDI minimal, écrit indépendamment du code de production. */
function rtpMidiPacket({ seq = 1, ts = 0, ssrc = 0xfeed0001, midi = [], z = false, p = false }) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 97;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const flags = (z ? 0x20 : 0) | (p ? 0x10 : 0);
  const midiHeader =
    midi.length <= 0x0f
      ? Buffer.from([flags | midi.length])
      : Buffer.from([0x80 | flags | ((midi.length >> 8) & 0x0f), midi.length & 0xff]);
  return Buffer.concat([header, midiHeader, Buffer.from(midi)]);
}

function waitFor(predicate, { timeout = 2000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = predicate();
      if (v) return resolve(v);
      if (Date.now() - started > timeout) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makeManager(controlPort, logger = silentLogger) {
  return new NetworkManager({ logger, config: { network: { rtpMidiPort: controlPort } } });
}

describe('L04/§N01 — sockets AppleMIDI partagées', () => {
  test('_ensureSockets lie le port de contrôle et le port de données (P et P+1)', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await nm._ensureSockets();
    expect(nm._controlSocket.address().port).toBe(base);
    expect(nm._dataSocket.address().port).toBe(base + 1);
    await nm.shutdown();
  });

  test('port occupé → repli sur une socket éphémère au lieu d’échouer', async () => {
    const base = nextPortBlock();
    const squatter = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise((r) => squatter.bind(base, r));
    const warns = [];
    const nm = makeManager(base, { ...silentLogger, warn: (m) => warns.push(String(m)) });

    await nm._ensureSockets();
    expect(nm._controlSocket.address().port).not.toBe(base); // port éphémère
    expect(nm._dataSocket.address().port).toBe(base + 1);
    expect(warns.join('\n')).toMatch(/Cannot bind RTP-MIDI control port/);

    await nm.shutdown();
    await new Promise((r) => squatter.close(r));
  });

  test('deux _ensureSockets concurrents ne lient qu’une seule paire de sockets', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await Promise.all([nm._ensureSockets(), nm._ensureSockets(), nm._ensureSockets()]);
    expect(nm._controlSocket.address().port).toBe(base);
    await nm.shutdown();
  });

  test('shutdown ferme les sockets : le port redevient liable', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await nm._ensureSockets();
    await nm.shutdown();
    expect(nm._controlSocket).toBeNull();
    const probe = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    await expect(
      new Promise((r, j) => {
        probe.once('error', j);
        probe.bind(base, r);
      })
    ).resolves.toBeUndefined();
    await new Promise((r) => probe.close(r));
  });
});

describe('L04/§N02 — poignée de main d’invitation AppleMIDI (rôle initiateur)', () => {
  let nm, peer, base;

  beforeEach(async () => {
    base = nextPortBlock();
    nm = makeManager(base);
    peer = new FakeApplePeer(base + 2);
    await peer.start();
  });

  afterEach(async () => {
    await nm.shutdown();
    await peer.close();
  });

  test('IN sur le contrôle, IN sur les données, puis session établie', async () => {
    const connected = [];
    nm.on('network:connected', (e) => connected.push(e));

    const info = await nm.connect(LOOPBACK, String(peer.controlPort));

    expect(info.connected).toBe(true);
    expect(peer.controlRx).toHaveLength(1);
    const inv = decodeInvitation(peer.controlRx[0]);
    expect(commandOf(peer.controlRx[0])).toBe(CMD.INVITATION);
    expect(inv.protocolVersion).toBe(2); // conformité AppleMIDI
    expect(inv.name).toBe('GeneralMidiBoop');
    // La seconde invitation part bien sur le PORT DE DONNÉES du pair.
    expect(commandOf(peer.dataRx[0])).toBe(CMD.INVITATION);
    expect(nm.rtpSessions.get(LOOPBACK).isConnected()).toBe(true);
    expect(connected).toHaveLength(1);
    expect(nm.getStatus().connectedDevices).toBe(1);
  });

  test('getConnectedDevices n’expose jamais l’objet session', async () => {
    await nm.connect(LOOPBACK, String(peer.controlPort));
    const devices = nm.getConnectedDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].session).toBeUndefined();
    expect(devices[0].ip).toBe(LOOPBACK);
  });

  test('la synchronisation d’horloge (CK count=0) est émise dès l’établissement', async () => {
    await nm.connect(LOOPBACK, String(peer.controlPort));
    await waitFor(() => peer.dataRx.some((m) => commandOf(m) === CMD.CLOCK_SYNC), {
      label: 'CK initial'
    });
    const ck = peer.dataRx.find((m) => commandOf(m) === CMD.CLOCK_SYNC);
    expect(ck.length).toBe(36);
    expect(ck[8]).toBe(0); // count = 0 → nous initions la ronde
  });

  test('déconnexion : BY envoyé au pair, network:disconnected émis une seule fois', async () => {
    const events = [];
    nm.on('network:disconnected', (e) => events.push(e));
    await nm.connect(LOOPBACK, String(peer.controlPort));

    await nm.disconnect(LOOPBACK);

    await waitFor(() => peer.controlRx.some((m) => commandOf(m) === CMD.END), { label: 'BY' });
    expect(events).toHaveLength(1);
    expect(nm.rtpSessions.size).toBe(0);
    expect(nm.connectedDevices.size).toBe(0);
    await expect(nm.disconnect(LOOPBACK)).rejects.toThrow(/not connected/);
  });

  test('F-49 — se reconnecter à une IP déjà connectée ne doit pas abandonner la session précédente', async () => {
    await nm.connect(LOOPBACK, String(peer.controlPort));
    const first = nm.rtpSessions.get(LOOPBACK);
    expect(first.isConnected()).toBe(true);

    await nm.connect(LOOPBACK, String(peer.controlPort));
    const second = nm.rtpSessions.get(LOOPBACK);

    expect(second).not.toBe(first);
    // La première session doit avoir été fermée : sinon son intervalle de
    // clock-sync et son chien de garde survivent, et le pair conserve une
    // session semi-ouverte que plus personne ne peut clore.
    expect(first.state).toBe('closed');
    expect(first._clockTimer).toBeNull();
    expect(first._watchdogTimer).toBeNull();
  });
});

describe('L04/§N02 — refus d’invitation', () => {
  test('NO du pair → connect rejette et aucune session ne subsiste', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    const peer = new FakeApplePeer(base + 2, { mode: 'reject' });
    await peer.start();
    const disconnects = [];
    nm.on('network:disconnected', (e) => disconnects.push(e));
    try {
      await expect(nm.connect(LOOPBACK, String(peer.controlPort))).rejects.toThrow(/rejected/i);

      expect(nm.rtpSessions.size).toBe(0);
      expect(nm.connectedDevices.size).toBe(0);
      // Une session qui n'a JAMAIS été connectée émet quand même
      // `network:disconnected` (close() est le propriétaire unique du teardown).
      expect(disconnects).toHaveLength(1);
      // …et l'entrée créée dans le catalogue par la tentative reste en place.
      expect(nm.devices.has(LOOPBACK)).toBe(true);
    } finally {
      await nm.shutdown();
      await peer.close();
    }
  });
});

describe('L04/§N01 — flux RTP-MIDI entrant (perte, duplication, réordonnancement, troncature)', () => {
  let nm, peer, base, midi;

  beforeEach(async () => {
    base = nextPortBlock();
    nm = makeManager(base);
    peer = new FakeApplePeer(base + 2);
    await peer.start();
    midi = [];
    nm.on('midi:data', (e) => midi.push(e));
    await nm.connect(LOOPBACK, String(peer.controlPort));
    await waitFor(() => peer.managerDataPort != null, { label: 'port données du manager' });
  });

  afterEach(async () => {
    await nm.shutdown();
    await peer.close();
  });

  const push = (buf) => peer.sendData(buf, peer.managerDataPort);

  test('un note-on traverse le fil et ressort typé', async () => {
    push(rtpMidiPacket({ seq: 1, midi: [0x90, 0x3c, 0x64] }));
    await waitFor(() => midi.length === 1, { label: 'note-on' });
    expect(midi[0]).toMatchObject({
      ip: LOOPBACK,
      type: 'noteon',
      data: { channel: 0, note: 0x3c, velocity: 0x64 }
    });
  });

  test('running status DANS un paquet : les deux notes sont émises', async () => {
    // [status+data] puis [delta-time VLQ 0x00][data seulement]
    push(rtpMidiPacket({ seq: 2, midi: [0x90, 0x3c, 0x40, 0x00, 0x3e, 0x40] }));
    await waitFor(() => midi.length === 2, { label: '2 notes' });
    expect(midi.map((m) => m.data.note)).toEqual([0x3c, 0x3e]);
  });

  test('running status REPORTÉ d’un paquet à l’autre (bit P) — RFC 6295', async () => {
    push(rtpMidiPacket({ seq: 3, midi: [0x90, 0x3c, 0x40] }));
    await waitFor(() => midi.length === 1, { label: 'paquet 1' });
    push(rtpMidiPacket({ seq: 4, midi: [0x41, 0x40], p: true }));
    await waitFor(() => midi.length === 2, { label: 'paquet 2 (P=1)' });
    expect(midi[1]).toMatchObject({ type: 'noteon', data: { note: 0x41, velocity: 0x40 } });
  });

  test('messages système (clock, SysEx) : transmis en octets bruts, jamais perdus', async () => {
    push(rtpMidiPacket({ seq: 5, midi: [0xf8] }));
    push(rtpMidiPacket({ seq: 6, midi: [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7] }));
    await waitFor(() => midi.length === 2, { label: 'système' });
    expect(midi[0].data).toEqual([0xf8]);
    expect(midi[0].type).toBeUndefined(); // route vers handleRawMidi côté app
    expect(midi[1].data).toEqual([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);
  });

  test('PAQUET PERDU : le trou n’est ni détecté ni réparé (pas de journal de récupération)', async () => {
    push(rtpMidiPacket({ seq: 10, midi: [0x90, 0x3c, 0x40] }));
    /* seq 11 volontairement jamais envoyé */
    push(rtpMidiPacket({ seq: 12, midi: [0x90, 0x3e, 0x40] }));
    await waitFor(() => midi.length === 2, { label: '2 paquets sur 3' });
    // Deux notes reçues, aucune erreur, aucune demande de retransmission :
    // la note du paquet perdu est définitivement absente. C'est exactement ce
    // que l'auto-déclaration `degraded` du projet annonce (§N02).
    expect(midi.map((m) => m.data.note)).toEqual([0x3c, 0x3e]);
    expect(nm.rtpSessions.get(LOOPBACK).isConnected()).toBe(true);
  });

  test('F-51 — PAQUET DUPLIQUÉ : le même numéro de séquence est joué DEUX FOIS', async () => {
    const dup = rtpMidiPacket({ seq: 20, midi: [0x90, 0x3c, 0x7f] });
    push(dup);
    push(dup); // duplication réseau (retransmission, boucle, bridge Wi-Fi)
    await waitFor(() => midi.length === 2, { label: 'duplicata' });
    expect(midi.map((m) => m.data.note)).toEqual([0x3c, 0x3c]);
  });

  test('F-51 (suite) — PAQUETS RÉORDONNÉS : le note-off est livré avant son note-on', async () => {
    const on = rtpMidiPacket({ seq: 30, midi: [0x90, 0x40, 0x7f] });
    const off = rtpMidiPacket({ seq: 31, midi: [0x80, 0x40, 0x00] });
    push(off); // arrivé en premier
    push(on);
    await waitFor(() => midi.length === 2, { label: 'réordonnancement' });
    // Aucun tampon de réordonnancement : l'ordre du fil est l'ordre joué → la
    // note reste tenue indéfiniment côté instrument.
    expect(midi.map((m) => m.type)).toEqual(['noteoff', 'noteon']);
  });

  test('PAQUETS TRONQUÉS / MALFORMÉS : ignorés sans exception, la session survit', async () => {
    push(Buffer.from([0x80, 97, 0x00])); // < 12 octets
    push(Buffer.alloc(12)); // en-tête nu, pas de payload
    const truncatedExt = Buffer.concat([
      Buffer.from([0x90, 97, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]), // bit X posé
      Buffer.from([0x00, 0x01])
    ]);
    push(truncatedExt);
    const lying = Buffer.concat([
      rtpMidiPacket({ seq: 41, midi: [] }).subarray(0, 12),
      Buffer.from([0x8f, 0xff, 0x90, 0x3c]) // longueur annoncée 4095, 2 octets réels
    ]);
    push(lying);
    await new Promise((r) => setTimeout(r, 60));

    expect(midi).toHaveLength(0);
    expect(nm.rtpSessions.get(LOOPBACK).isConnected()).toBe(true);

    // La session accepte encore un paquet valide après la rafale malformée.
    push(rtpMidiPacket({ seq: 42, midi: [0x90, 0x3c, 0x40] }));
    await waitFor(() => midi.length === 1, { label: 'reprise après malformés' });
  });

  test('émission : sendMidiMessage produit un paquet RTP-MIDI (PT 97) à séquence croissante', async () => {
    const before = peer.dataRx.length;
    await nm.sendMidiMessage(LOOPBACK, 'noteon', { channel: 2, note: 60, velocity: 100 });
    await nm.sendMidiMessage(LOOPBACK, 'noteoff', { channel: 2, note: 60, velocity: 0 });
    await waitFor(() => peer.dataRx.length >= before + 2, { label: 'paquets sortants' });

    const rtp = peer.dataRx.slice(before).filter((m) => m[0] === 0x80 && (m[1] & 0x7f) === 97);
    expect(rtp.length).toBeGreaterThanOrEqual(2);
    const seq0 = rtp[0].readUInt16BE(2);
    const seq1 = rtp[1].readUInt16BE(2);
    expect((seq1 - seq0) & 0xffff).toBe(1);
    expect(Array.from(rtp[0].subarray(13))).toEqual([0x92, 60, 100]);
  });

  test('émission vers une IP non connectée → erreur explicite', async () => {
    await expect(nm.sendMidiMessage('10.9.9.9', 'noteon', { note: 60 })).rejects.toThrow(
      /not connected/
    );
  });
});

describe('L04/§N01 — session ENTRANTE (rôle répondeur)', () => {
  test('F-50 — une invitation entrante est acceptée SUR LE PORT SOURCE du pair', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await nm._ensureSockets();
    const connected = [];
    nm.on('network:connected', (e) => connected.push(e));

    // Le pair écoute sur base+2 / base+3 : des ports DIFFÉRENTS de ceux du
    // manager, comme un iPad ou un Mac dont Bonjour annonce un port dynamique.
    const peer = new FakeApplePeer(base + 2, { mode: 'silent' });
    await peer.start();
    try {
      const token = 0x11223344;
      // Invitation entrante sur le port de CONTRÔLE du manager.
      peer.control.send(
        encodeInvitation(CMD.INVITATION, { initiatorToken: token, ssrc: 0x1234, name: 'iPad' }),
        base,
        LOOPBACK
      );
      await waitFor(() => peer.controlRx.length >= 1, { label: 'OK contrôle' });
      expect(commandOf(peer.controlRx[0])).toBe(CMD.INVITATION_ACCEPTED);
      expect(nm.rtpSessions.has(LOOPBACK)).toBe(true);

      // Puis l'invitation sur le port de DONNÉES établit la session.
      peer.data.send(
        encodeInvitation(CMD.INVITATION, { initiatorToken: token, ssrc: 0x1234, name: 'iPad' }),
        base + 1,
        LOOPBACK
      );
      await waitFor(() => connected.length === 1, { label: 'network:connected' });
      expect(nm.connectedDevices.get(LOOPBACK).name).toMatch(/Network MIDI/);
      expect(nm.connectedDevices.get(LOOPBACK).port).toBe(String(base + 2));
    } finally {
      await nm.shutdown();
      await peer.close();
    }
  });

  test('F-50 (suite) — invitations depuis N adresses inconnues : autant de sessions, sans plafond', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await nm._ensureSockets();
    const invitation = encodeInvitation(CMD.INVITATION, {
      initiatorToken: 1,
      ssrc: 2,
      name: 'flood'
    });

    for (let i = 0; i < 500; i++) {
      nm._handleControlInbound(invitation, { address: `10.0.${Math.floor(i / 250)}.${i % 250}` });
    }

    // Aucun plafond, aucune limitation de débit : 500 sessions + 500 chiens de
    // garde de 10 s armés par 500 datagrammes non authentifiés.
    expect(nm.rtpSessions.size).toBe(500);
    await nm.shutdown();
    expect(nm.rtpSessions.size).toBe(0); // shutdown les referme toutes
  });

  test('un datagramme de données d’un pair inconnu est ignoré (pas de session fantôme)', async () => {
    const base = nextPortBlock();
    const nm = makeManager(base);
    await nm._ensureSockets();
    nm._handleDataInbound(rtpMidiPacket({ midi: [0x90, 0x3c, 0x40] }), { address: '10.1.1.1' });
    expect(nm.rtpSessions.size).toBe(0);
    await nm.shutdown();
  });
});

describe('L04/§N01 — surface hors socket (découverte, statut, conversion)', () => {
  let nm;
  beforeEach(() => {
    nm = makeManager(nextPortBlock());
  });

  test('parseMDNSOutput ne retient que les lignes résolues', () => {
    nm.parseMDNSOutput(
      [
        '',
        '+;eth0;IPv4;Piano;_apple-midi._udp;local', // non résolue → ignorée
        '=;eth0;IPv4;Piano du salon;_apple-midi._udp;local;piano.local;192.168.1.42;5004;',
        '=;eth0;IPv4;Sans IP;_apple-midi._udp;local;x.local;(null);5004;'
      ].join('\n')
    );
    expect(nm.devices.size).toBe(1);
    expect(nm.devices.get('192.168.1.42')).toMatchObject({
      name: 'Piano du salon',
      port: '5004',
      protocol: 'RTP-MIDI'
    });
  });

  test('les devices de test restent opt-in (GMBOOP_NETWORK_TEST_DEVICES)', () => {
    delete process.env.GMBOOP_NETWORK_TEST_DEVICES;
    nm.addTestDevices();
    nm.addTestDevicesIP('192.168.1');
    expect(nm.devices.size).toBe(0);

    process.env.GMBOOP_NETWORK_TEST_DEVICES = '1';
    try {
      nm.addTestDevices();
      expect(nm.devices.size).toBe(2);
    } finally {
      delete process.env.GMBOOP_NETWORK_TEST_DEVICES;
    }
  });

  test('startScan refuse un second scan concurrent et stopScan le libère', async () => {
    nm.scanning = true;
    await expect(nm.startScan(1, false)).rejects.toThrow(/already in progress/);
    nm.stopScan();
    expect(nm.getStatus().scanning).toBe(false);
  });

  test('checkReachability rejette les entrées non-IP sans ouvrir de socket', async () => {
    await expect(nm.checkReachability('; rm -rf /')).resolves.toBe(false);
    await expect(nm.isHostReachable('example.com')).resolves.toBe(false);
  });

  test('parseMidiBytes couvre les 7 messages de canal et refuse les trames courtes', () => {
    expect(nm.parseMidiBytes([0x90, 60, 100])).toEqual({
      type: 'noteon',
      data: { channel: 0, note: 60, velocity: 100 }
    });
    expect(nm.parseMidiBytes([0x81, 60, 0]).type).toBe('noteoff');
    expect(nm.parseMidiBytes([0xb2, 7, 90]).data).toEqual({ channel: 2, controller: 7, value: 90 });
    expect(nm.parseMidiBytes([0xc3, 40])).toEqual({
      type: 'program',
      data: { channel: 3, number: 40 }
    });
    expect(nm.parseMidiBytes([0xe4, 0x00, 0x40]).data.value).toBe(8192);
    expect(nm.parseMidiBytes([0xa5, 60, 20]).data.pressure).toBe(20);
    expect(nm.parseMidiBytes([0xd6, 30]).data.pressure).toBe(30);
    expect(nm.parseMidiBytes([0x90, 60])).toBeNull(); // tronqué
    expect(nm.parseMidiBytes([])).toBeNull();
    expect(nm.parseMidiBytes(null)).toBeNull();
  });

  test('getLocalSubnet retombe sur 192.168.1 sans interface externe', () => {
    const subnet = nm.getLocalSubnet();
    expect(subnet).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
