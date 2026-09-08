// tests/audit/l11-config-fuzz.test.js
//
// Lot L11 — §B05. Superposition config.json -> .env -> GMBOOP_*.
//
// `tests/config.test.js` couvre le chemin nominal. Ce fichier pose la
// question de l'audit : « une valeur absurde produit-elle un message clair
// ou une casse obscure ? ». Réponse mesurée : les surcharges d'environnement
// sont validées et refusées proprement, MAIS **rien de ce qui vient de
// `config.json` n'est validé** — les validateurs ne vivent que dans `set()`,
// et `loadConfig()` renvoie le JSON brut.
//
// Chaque cas utilise son propre fichier de config sous un répertoire
// temporaire : aucun fichier partagé n'est touché.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Config from '../../src/core/Config.js';

let dir;
const savedEnv = {};
const ENV_KEYS = [
  'PORT',
  'GMBOOP_SERVER_PORT',
  'GMBOOP_DATABASE_PATH',
  'GMBOOP_LOG_LEVEL',
  'GMBOOP_SERIAL_ENABLED',
  'GMBOOP_SF2_CACHE_MAX_BYTES'
];

/** Écrit un config.json ad hoc et renvoie un Config qui le lit. */
function configWith(json) {
  const p = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, typeof json === 'string' ? json : JSON.stringify(json));
  return new Config(p);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'l11-cfg-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('L11 §B05 — surcharges GMBOOP_* : validées et refusées proprement (PASS)', () => {
  test('PORT=0 est refusé, la valeur du fichier est conservée', () => {
    process.env.PORT = '0';
    const c = configWith({ server: { port: 8080 } });
    expect(c.get('server.port')).toBe(8080);
  });

  test('PORT=99999 est refusé', () => {
    process.env.PORT = '99999';
    const c = configWith({ server: { port: 8080 } });
    expect(c.get('server.port')).toBe(8080);
  });

  test('PORT=abc est refusé (NaN)', () => {
    process.env.PORT = 'abc';
    const c = configWith({ server: { port: 8080 } });
    expect(c.get('server.port')).toBe(8080);
  });

  test('GMBOOP_LOG_LEVEL=verbose est refusé (niveau inconnu)', () => {
    process.env.GMBOOP_LOG_LEVEL = 'verbose';
    const c = configWith({ logging: { level: 'info' } });
    expect(c.get('logging.level')).toBe('info');
  });

  test('GMBOOP_DATABASE_PATH avec traversée ../.. est refusé', () => {
    process.env.GMBOOP_DATABASE_PATH = '../../../etc/gmboop.db';
    const c = configWith({ database: { path: './data/gmboop.db' } });
    expect(c.get('database.path')).toBe('./data/gmboop.db');
  });

  test('un chemin absolu de base EST accepté (choix documenté : stockage externe)', () => {
    process.env.GMBOOP_DATABASE_PATH = '/mnt/ssd/gmboop.db';
    const c = configWith({ database: { path: './data/gmboop.db' } });
    expect(c.get('database.path')).toBe('/mnt/ssd/gmboop.db');
  });
});

describe('L11 §B05 — config.json : AUCUNE validation (F-125, caractérisation)', () => {
  test('un port 0 dans config.json passe tel quel (Node écouterait sur un port éphémère)', () => {
    const c = configWith({ server: { port: 0 } });
    // À INVERSER après correctif : loadConfig() doit rejeter/normaliser.
    expect(c.get('server.port')).toBe(0);
  });

  test('un port 99999 dans config.json passe tel quel (listen() lèvera un RangeError)', () => {
    const c = configWith({ server: { port: 99999 } });
    expect(c.get('server.port')).toBe(99999);
  });

  test('un port texte dans config.json passe tel quel', () => {
    const c = configWith({ server: { port: 'huit-mille' } });
    expect(c.get('server.port')).toBe('huit-mille');
  });

  test('un booléen mal typé ("yes") est accepté et devient truthy — un sous-système s\'active par erreur', () => {
    const c = configWith({ serial: { enabled: 'yes', baudRate: 31250 } });
    expect(c.get('serial.enabled')).toBe('yes');
    expect(Boolean(c.get('serial.enabled'))).toBe(true);
    // Contre-épreuve : par l'environnement, la coercition est correcte.
    // (typeof courant === 'string' ici, donc pas de coercition booléenne :
    //  c'est bien le type du FICHIER qui décide, d'où le piège.)
  });

  test('un niveau de log inconnu dans config.json passe tel quel', () => {
    const c = configWith({ logging: { level: 'trace', file: './logs/x.log', console: true } });
    expect(c.get('logging.level')).toBe('trace');
  });

  test('un config.json malformé retombe SILENCIEUSEMENT sur les valeurs par défaut (F-125)', () => {
    const c = configWith('{ "server": { "port": 8080 ');
    // Aucune exception, aucun log applicatif : seulement un console.error.
    // Conséquence terrain : `database.path` revient à ./data/gmboop.db et
    // l'opérateur croit avoir perdu ses données.
    expect(c.get('server.port')).toBe(8080);
    expect(c.get('database.path')).toBe('./data/gmboop.db');
  });

  test('une section entière absente est remplacée par les valeurs par défaut sans avertissement', () => {
    const c = configWith({ server: { port: 8080 } });
    expect(c.get('database.path')).toBeNull();
    // `get()` renvoie null (defaultValue) : ce n'est PAS la valeur par
    // défaut de getDefaultConfig(). Les deux notions de « défaut » diffèrent
    // selon que le fichier est illisible (défauts complets) ou incomplet
    // (null par clé) — piège de configuration réel.
  });
});
