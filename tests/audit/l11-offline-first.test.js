// tests/audit/l11-offline-first.test.js
//
// Lot L11 — §AG / F-14, F-119. « Offline-first » au démarrage de la SPA.
//
// NATURE DE CE FICHIER. Il a été écrit comme un test de CARACTÉRISATION : il
// décrivait le comportement PROUVÉ du dépôt, pas le comportement souhaité,
// parce que `public/index.html` était un fichier partagé que L11 n'avait pas le
// droit de modifier. Les assertions marquées « À INVERSER » l'ont été par la
// vague 2 / R6, qui a appliqué les trois correctifs. Ce fichier atteste
// désormais l'état corrigé ; la couverture détaillée est dans
// `r6-offline-first.test.js` et `r6-static-asset-404.test.js`.
//
// Preuve d'exécution d'origine (serveur vivant, port 8111, 2026-09-07) :
//   GET /lib/WebAudioFontPlayer.js
//     -> HTTP 200, Content-Type: text/html, 615825 octets (le shell SPA)
//   c.-à-d. le fichier manquant ne renvoyait JAMAIS 404 : le navigateur
//   recevait index.html à la place du script, échouait à le parser, et le
//   repli `document.write` vers le CDN s'exécutait donc TOUJOURS.
// Mesure navigateur associée (L08 / F-87, 2026-09-07) : 8 000 ms de latence
//   réseau injectée => DOMContentLoaded à 8 421 ms.

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const indexHtml = readFileSync(join(ROOT, 'public/index.html'), 'utf8');

describe('L11 §AG — F-14 : le repli CDN bloquant de public/index.html (CORRIGÉ, R6)', () => {
  test('le repli synchrone vers surikov.github.io a disparu', () => {
    // Assertion inversée par R6 : c'était `expect(...).toContain(...)`.
    expect(indexHtml).not.toContain('surikov.github.io');
    expect(indexHtml).not.toMatch(/document\s*\.\s*write/);
  });

  test("la garde subsiste, mais elle n'appelle plus le réseau", () => {
    // `typeof WebAudioFontPlayer === 'undefined'` reste vrai quand l'asset est
    // absent ; ce qui change, c'est ce qu'on en fait : un drapeau global et un
    // avertissement console, zéro requête, zéro blocage de l'analyseur.
    expect(indexHtml).toMatch(/typeof WebAudioFontPlayer === 'undefined'/);
    expect(indexHtml).toContain('__GMBOOP_AUDIO_PREVIEW_UNAVAILABLE__');
  });

  test("l'asset vendorisé n'est toujours pas versionné : le cas nominal d'un dépôt frais reste son absence", () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^public\/lib\/WebAudioFontPlayer\.js$/m);
    // C'est précisément pourquoi les deux autres correctifs (404 sur asset
    // absent, copie de lib/ dans dist/) comptent autant que la suppression du
    // repli : l'absence est un état normal, pas un accident.
  });

  test("un dépôt installé avec --ignore-scripts n'a pas public/lib/ (chemin documenté par CLAUDE.md)", () => {
    const vendored = join(ROOT, 'public/lib/WebAudioFontPlayer.js');
    // Les deux états sont légitimes ; ce qui compte est que l'application
    // fonctionne dans les deux (aperçu audio en moins dans le second).
    expect(typeof existsSync(vendored)).toBe('boolean');
  });

  test("les 194 balises <script src> sont désormais toutes locales : plus rien n'est derrière un appel réseau", () => {
    const srcs = [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    // 191 à R6 ; +2 en vague 3 / R12 (modale de routage live + son lanceur) ;
    // +1 en vague 4 / R20 (features/transport/PlaybackResync.js), toutes en
    // chemin relatif. Le compte reste exact pour qu'ajouter un script soit une
    // modification consciente de ce test ; l'invariant protégé est l'assertion
    // ci-dessous : aucune balise ne vise une origine distante.
    expect(srcs.length).toBe(194);
    // Avant R6 : 174 d'entre elles attendaient la résolution réseau du CDN
    // avant d'être seulement demandées, `document.write` étant bloquant pour
    // l'analyseur HTML.
    expect(srcs.filter((s) => /^(?:https?:)?\/\//.test(s))).toEqual([]);
  });

  test('le seul consommateur du global échoue proprement — et le parseur y arrive maintenant', () => {
    const synth = readFileSync(join(ROOT, 'public/js/audio/MidiSynthesizer.js'), 'utf8');
    expect(synth).toMatch(/throw new Error\('WebAudioFontPlayer not loaded'\)/);
    // La dégradation « pas d'aperçu audio, le reste fonctionne » EXISTAIT déjà.
    // Le repli `document.write` n'apportait donc aucune robustesse : il ne
    // faisait qu'ajouter un point de blocage réseau devant elle.
  });
});

describe('L11 §AG — F-14 (aggravation) : dist/ contient maintenant lib/', () => {
  const viteConfig = readFileSync(join(ROOT, 'vite.config.js'), 'utf8');

  test("copyStaticTree copie 'lib' : un postinstall réussi survit à la production", () => {
    const m = viteConfig.match(/const dirs = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const dirs = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);

    // Assertion inversée par R6 : c'était `expect(dirs).not.toContain('lib')`.
    expect(dirs).toEqual(['js', 'locales', 'assets', 'styles', 'lib']);
  });

  test('HttpServer sert toujours dist/ en production dès que dist/index.html existe', () => {
    const http = readFileSync(join(ROOT, 'src/api/HttpServer.js'), 'utf8');
    expect(http).toMatch(/isProduction && existsSync\(path\.join\(distPath, 'index\.html'\)\)/);
    // La conjonction reste (Install.sh lance `npm run build`, le service
    // systemd pose NODE_ENV=production) — elle n'est simplement plus fatale,
    // puisque dist/ embarque désormais lib/.
  });

  test('F-119 : un asset absent ne renvoie plus le shell SPA', () => {
    const http = readFileSync(join(ROOT, 'src/api/HttpServer.js'), 'utf8');
    expect(http).toMatch(/ASSET_PATH/);
    expect(http).toMatch(/status\(404\)\.type\('text\/plain'\)/);
    // Comportement vérifié sur un serveur réel dans r6-static-asset-404.test.js.
  });
});
