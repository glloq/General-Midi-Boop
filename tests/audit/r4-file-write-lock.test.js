// tests/audit/r4-file-write-lock.test.js
//
// Vague 1 — R4 : contrat du verrou par fichier (`src/files/FileWriteLock.js`).
//
// Deux propriétés comptent, et la seconde est celle qui rend le contrôle de
// version optimiste possible :
//   1. exclusion mutuelle PAR CLÉ (deux fichiers différents ne se gênent pas) ;
//   2. `acquire()` CÈDE TOUJOURS la main (il est `async`). C'est ce point qui
//      transforme deux requêtes que Node exécuterait séquentiellement en deux
//      requêtes réellement concurrentes : chacune prend son instantané de
//      version AVANT que l'autre n'écrive, donc l'instantané du perdant est
//      prouvablement périmé et le conflit est détectable.

import { describe, test, expect } from '@jest/globals';
import FileWriteLock, { getFileWriteLock } from '../../src/files/FileWriteLock.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('R4 — FileWriteLock', () => {
  test('exclusion mutuelle : les sections critiques d’une même clé ne s’entrelacent jamais', async () => {
    const lock = new FileWriteLock();
    const trace = [];
    const worker = async (tag) => {
      const release = await lock.acquire('file-1');
      try {
        trace.push(`${tag}:in`);
        await tick();
        await tick();
        trace.push(`${tag}:out`);
      } finally {
        release();
      }
    };
    await Promise.all([worker('A'), worker('B'), worker('C')]);
    expect(trace).toEqual(['A:in', 'A:out', 'B:in', 'B:out', 'C:in', 'C:out']);
  });

  test('les clés sont indépendantes : deux fichiers progressent en parallèle', async () => {
    const lock = new FileWriteLock();
    const trace = [];
    const worker = async (key, tag) => {
      const release = await lock.acquire(key);
      try {
        trace.push(`${tag}:in`);
        await tick();
        trace.push(`${tag}:out`);
      } finally {
        release();
      }
    };
    await Promise.all([worker('a', 'A'), worker('b', 'B')]);
    // Entrelacés : B entre avant que A ne sorte.
    expect(trace.indexOf('B:in')).toBeLessThan(trace.indexOf('A:out'));
  });

  test('`acquire()` cède la main même sans contention — c’est ce qui rend le CAS possible', async () => {
    const lock = new FileWriteLock();
    const order = [];
    const p = lock.acquire('file-1').then((release) => {
      order.push('inside');
      release();
    });
    order.push('after-call');
    await p;
    // Le corps protégé ne s'exécute PAS dans le tour de boucle de l'appelant.
    expect(order).toEqual(['after-call', 'inside']);
  });

  test('`release()` est idempotent et libère bien le suivant', async () => {
    const lock = new FileWriteLock();
    const release = await lock.acquire('k');
    release();
    release();
    const second = await lock.acquire('k');
    second();
    expect(typeof second).toBe('function');
  });

  test('`withLock` libère même quand la section critique lève', async () => {
    const lock = new FileWriteLock();
    await expect(
      lock.withLock('k', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    // Non wedgé : la clé est de nouveau prenable.
    await expect(lock.withLock('k', () => 'ok')).resolves.toBe('ok');
  });

  test('un porteur bloqué ne fige pas la clé pour toujours (garde de délai)', async () => {
    const lock = new FileWriteLock({ timeoutMs: 30 });
    // Ce porteur ne relâche jamais.
    await lock.acquire('stuck');
    const t0 = Date.now();
    const release = await lock.acquire('stuck');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
    release();
  });

  test('la carte des clés ne fuit pas : elle redescend à zéro une fois tout relâché', async () => {
    const lock = new FileWriteLock();
    for (let i = 0; i < 20; i++) {
      const release = await lock.acquire(`f${i}`);
      release();
    }
    await tick();
    await tick();
    expect(lock.activeKeys).toBe(0);
  });

  test('`getFileWriteLock` : un verrou par façade app, et celui du conteneur DI a la priorité', () => {
    const appA = { logger: null };
    const appB = { logger: null };
    expect(getFileWriteLock(appA)).toBe(getFileWriteLock(appA));
    expect(getFileWriteLock(appA)).not.toBe(getFileWriteLock(appB));

    const injected = new FileWriteLock();
    expect(getFileWriteLock({ fileWriteLock: injected })).toBe(injected);
  });
});
