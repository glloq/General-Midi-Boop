// tests/audit/l11-hotspot-manager.test.js
//
// Lot L11 — §AE. `src/system/HotspotManager.js` (5,6 % de couverture) n'avait
// aucun test : la surface avait été RELUE en août, jamais EXÉCUTÉE.
//
// `scripts/hotspot.sh` n'est jamais lancé ici : `child_process` est remplacé
// par une doublure en mémoire (`jest.unstable_mockModule`). Aucune commande
// `sudo`, aucun `nmcli`, aucun état système touché.
//
// Le défaut central prouvé ici (F-121) : `_runScript()` récupère l'enveloppe
// d'erreur du script (`{"success":false,...}`) dans son `catch` et la renvoie
// comme si c'était un succès. `enable()` marquait alors le hotspot ACTIF en
// mémoire alors que `nmcli` avait échoué — et `isActive()` pilote le
// middleware de portail captif de HttpServer.

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/** File de réponses consommée par la doublure d'execFile. */
let responses = [];
/** Journal des appels `execFile(cmd, args, opts)`. */
let calls = [];

/**
 * Doublure d'execFile au format callback (c'est ce que `promisify` attend).
 * Une réponse `{ ok:false, stdout, stderr }` simule un code de sortie non nul
 * avec une enveloppe JSON sur stdout — exactement ce que fait hotspot.sh.
 */
function fakeExecFile(cmd, args, opts, cb) {
  calls.push({ cmd, args, opts });
  const next = responses.shift() || { ok: true, stdout: '{"success":true}\n', stderr: '' };
  setImmediate(() => {
    if (next.ok) return cb(null, { stdout: next.stdout, stderr: next.stderr || '' });
    const err = new Error(next.message || 'Command failed');
    err.stdout = next.stdout;
    err.stderr = next.stderr || '';
    cb(err);
  });
}
// promisify() lit ce symbole en priorité ; sans lui, la doublure callback
// suffit, mais on reste explicite.
fakeExecFile[Symbol.for('nodejs.util.promisify.custom')] = undefined;

jest.unstable_mockModule('child_process', () => ({
  execFile: fakeExecFile,
  default: { execFile: fakeExecFile }
}));

const { default: HotspotManager } = await import('../../src/system/HotspotManager.js');

const logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Construit un manager en neutralisant le status() du constructeur. */
function makeManager() {
  responses.push({
    ok: true,
    stdout: '{"success":true,"hotspotActive":false,"wifiActive":"maison","interface":"wlan0"}\n'
  });
  return new HotspotManager({ logger });
}

beforeEach(() => {
  responses = [];
  calls = [];
});

describe('L11 §AE — surface de commande (aucune injection possible)', () => {
  test('le script est invoqué en argv, via sudo -n, sans shell', async () => {
    const m = makeManager();
    responses.push({ ok: true, stdout: '{"success":true,"hotspotActive":true,"ssid":"x"}\n' });
    await m.enable({ ssid: 'Scene A', password: 'motdepasse', band: 'bg', channel: 6 });

    const call = calls[calls.length - 1];
    expect(call.cmd).toBe('sudo');
    expect(call.args[0]).toBe('-n');
    expect(call.args[1]).toMatch(/scripts[/\\]hotspot\.sh$/);
    expect(call.args.slice(2)).toEqual(['enable', 'Scene A', 'motdepasse', 'bg', '6']);
    expect(call.opts.timeout).toBe(20000);
  });

  test('un SSID hostile reste UN seul argument : ni shell, ni séparateur', async () => {
    const m = makeManager();
    responses.push({ ok: true, stdout: '{"success":true,"hotspotActive":true,"ssid":"x"}\n' });
    const hostile = '"; rm -rf / #';
    await m.enable({ ssid: hostile, password: 'motdepasse' });
    const call = calls[calls.length - 1];
    expect(call.args).toContain(hostile);
    expect(call.args.filter((a) => a === hostile)).toHaveLength(1);
  });

  test('sortie illisible : le manager lève au lieu de renvoyer un état faux', async () => {
    const m = makeManager();
    responses.push({ ok: true, stdout: 'not json at all\n' });
    await expect(m.status()).rejects.toThrow(/unparseable output/);
  });

  test("sudoers manquant : le message porte l'indice de remédiation", async () => {
    const m = makeManager();
    responses.push({ ok: false, stdout: '', stderr: 'sudo: a password is required' });
    await expect(m.status()).rejects.toThrow(/sudoers rule missing/);
  });

  test('deux activations concurrentes : la seconde est refusée', async () => {
    const m = makeManager();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    m._runScript = () => gate.then(() => ({ success: true, hotspotActive: true }));
    const first = m.enable({ ssid: 'a', password: 'motdepasse' });
    await expect(m.enable({ ssid: 'b', password: 'motdepasse' })).rejects.toThrow(
      /already in progress/
    );
    release();
    await first;
  });
});

describe('L11 §AE — F-121 : une enveloppe {"success":false} ne doit pas passer pour un succès', () => {
  test('enable() en échec doit lever et NE PAS marquer le hotspot actif', async () => {
    const m = makeManager();
    // hotspot.sh sort en code 1 avec son enveloppe d'erreur sur stdout.
    responses.push({
      ok: false,
      stdout:
        '{"success":false,"error":"failed to activate hotspot (nmcli connection up failed)"}\n',
      stderr: ''
    });

    await expect(m.enable({ ssid: 'Scene A', password: 'motdepasse' })).rejects.toThrow(
      /failed to activate hotspot/
    );
    // AVANT correctif : isActive() renvoyait true — le middleware de portail
    // captif s'allumait alors que wlan0 était resté en mode client.
    expect(m.isActive()).toBe(false);
  });

  test('wifiConnect() en échec doit lever (et ne pas journaliser une connexion)', async () => {
    const m = makeManager();
    responses.push({
      ok: false,
      stdout: '{"success":false,"error":"wifi connect failed: Secrets were required"}\n',
      stderr: ''
    });
    await expect(m.wifiConnect({ ssid: 'Voisin', password: 'motdepasse' })).rejects.toThrow(
      /wifi connect failed/
    );
  });

  test('wifiForget() sur un profil inconnu doit lever', async () => {
    const m = makeManager();
    responses.push({
      ok: false,
      stdout: '{"success":false,"error":"no saved profile named \'X\'"}\n',
      stderr: ''
    });
    await expect(m.wifiForget('X')).rejects.toThrow(/no saved profile/);
  });

  test('le chemin nominal reste inchangé : succès -> état actif', async () => {
    const m = makeManager();
    responses.push({
      ok: true,
      stdout: '{"success":true,"hotspotActive":true,"ssid":"Scene A"}\n'
    });
    const res = await m.enable({ ssid: 'Scene A', password: 'motdepasse' });
    expect(res.hotspotActive).toBe(true);
    expect(m.isActive()).toBe(true);
  });

  test('status() renvoyant {"success":false} ne doit pas être pris pour « hotspot éteint »', async () => {
    const m = makeManager();
    responses.push({
      ok: false,
      stdout: '{"success":false,"error":"nmcli not installed (NetworkManager required)"}\n',
      stderr: ''
    });
    await expect(m.status()).rejects.toThrow(/nmcli not installed/);
  });
});
