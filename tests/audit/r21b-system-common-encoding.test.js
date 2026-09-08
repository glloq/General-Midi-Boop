// tests/audit/r21b-system-common-encoding.test.js
//
// Vague 4 · complément de R21 — les deux correctifs que le lot R21/R23 avait
// identifiés mais ne pouvait pas appliquer (hors de son périmètre de fichiers).
//
// Sans eux, R21 était complet sur USB et *seulement* sur USB :
//
//   1. `MidiUtils.convertToMidiBytes()` renvoyait `null` pour `position`,
//      `select`, `mtc`, `tune` et `sensing`. Or sa propre JSDoc la présente
//      comme « shared utility used by all transport managers (Bluetooth,
//      Network, Serial) » : tout Song Position Pointer routé vers BLE, série
//      ou RTP était donc silencieusement abandonné. Émettre un SPP que trois
//      transports sur quatre jettent aurait créé une nouvelle divergence de
//      parité — exactement la classe de bug que F-08 puis F-38 ont coûté cher
//      à trouver.
//
//   2. `PRIORITY_MSG_TYPES` ne contenait pas `'position'`. Un seek n'émet
//      qu'un seul SPP ; s'il est jeté par le limiteur de débit sur un appareil
//      au plafond, le `Continue` qui suit fait repartir l'esclave au mauvais
//      endroit — le bug de F-43, réintroduit par le limiteur.
//
// État vérifié avant correctif (`git show HEAD:src/utils/MidiUtils.js`, chargé
// côte à côte avec la version corrigée) : les cinq types renvoyaient `null`.
import MidiUtils from '../../src/utils/MidiUtils.js';
import { PRIORITY_MSG_TYPES } from '../../src/core/constants.js';

describe('R21b §F-43 — les System Common sont encodés en sortie', () => {
  test('Song Position Pointer : [0xF2, lsb, msb]', () => {
    expect(MidiUtils.convertToMidiBytes('position', { bytes: [3, 1] })).toEqual([0xf2, 3, 1]);
  });

  test('les autres System Common / Real-Time sortants sont encodés', () => {
    expect(MidiUtils.convertToMidiBytes('select', { bytes: [7] })).toEqual([0xf3, 7]);
    expect(MidiUtils.convertToMidiBytes('mtc', { bytes: [42] })).toEqual([0xf1, 42]);
    expect(MidiUtils.convertToMidiBytes('tune', {})).toEqual([0xf6]);
    expect(MidiUtils.convertToMidiBytes('sensing', {})).toEqual([0xfe]);
  });

  test('les octets de données sont masqués sur 7 bits, jamais tronqués en silence', () => {
    // 0xFF déborde : le masque doit produire un octet de données légal plutôt
    // qu'une trame invalide qui désynchroniserait le parseur d'en face.
    expect(MidiUtils.convertToMidiBytes('position', { bytes: [0xff, 0xff] })).toEqual([
      0xf2, 0x7f, 0x7f
    ]);
  });

  test('bytes absent ne jette pas et produit une trame valide', () => {
    expect(MidiUtils.convertToMidiBytes('position', {})).toEqual([0xf2, 0, 0]);
  });

  test('un type réellement inconnu renvoie toujours null', () => {
    expect(MidiUtils.convertToMidiBytes('pas-un-message-midi', {})).toBeNull();
  });
});

describe('R21b §F-43 — le SPP échappe au limiteur de débit', () => {
  test("'position' est un type prioritaire", () => {
    expect(PRIORITY_MSG_TYPES.has('position')).toBe(true);
  });

  test('les exemptions déjà acquises ne sont pas perdues', () => {
    // 'noteoff' est le plus critique : le jeter laisse une note bloquée.
    for (const t of ['noteoff', 'reset', 'clock', 'start', 'stop', 'continue']) {
      expect(PRIORITY_MSG_TYPES.has(t)).toBe(true);
    }
  });
});
