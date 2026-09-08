// tests/audit/r7-packaging.test.js
//
// Vague 2 — R7. Vérifications STATIQUES du packaging Docker (F-118, F-157).
//
// Ces tests lisent des fichiers ; ils ne lancent aucun `docker`. C'est
// délibéré : un `docker build` n'a pas sa place dans une suite unitaire (il
// exige un démon, du réseau et ~450 Mo de disque). La vérification qui compte
// vraiment — build, démarrage, `/api/health` honnête — vit dans
// `scripts/verify-docker.sh`, à câbler dans un job CI dédié.
//
// Ce que ces tests attrapent quand même, et gratuitement : les trois
// régressions qui ont laissé `docker build` cassé pendant des mois sans que
// personne le sache.
//
// Preuves d'exécution R7 (docker 29.3.1, 2026-09-08, x86_64) :
//   * Dockerfile à HEAD^  -> `"/locales": not found`, EXIT=1 en 1,3 s
//   * sans `npm rebuild`  -> build OK, conteneur Exited(1) « Could not locate
//                            the bindings file »
//   * sans `COPY shared/` -> build OK, conteneur Exited(1) ERR_MODULE_NOT_FOUND
//   * corrigé             -> Up (healthy), /api/health 200, GET / 200

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');

/**
 * Le Dockerfile privé de ses lignes de commentaire. Les commentaires y
 * expliquent ce qui a été RETIRÉ (le `chown -R`, la couche libasound2) : les
 * chercher dans le texte brut donnerait un faux rouge.
 */
const dockerfileCode = dockerfile
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** Lignes non vides et non commentées d'un .dockerignore. */
const ignorePatterns = dockerignore
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

describe('R7 — le contexte de build est propre', () => {
  // node_modules du contexte = bindings natifs de la machine de BUILD. Sur un
  // poste x86_64 produisant une image ARM pour le Pi, ils sont muets mais faux.
  test.each(['node_modules', '.git', 'data', 'logs'])(
    '%s est exclu du contexte de build',
    (pattern) => {
      expect(ignorePatterns).toContain(pattern);
    }
  );

  test('les assets gitignorés ne viennent pas du disque du développeur', () => {
    // public/lib/WebAudioFontPlayer.js et assets/sf2/*.sf2 sont gitignorés et
    // récupérés au postinstall. Les laisser dans le contexte rend l'image
    // fonction de la machine de build — observé pendant R7 : un stub de
    // 42 octets s'était retrouvé dans l'image.
    expect(ignorePatterns).toContain('public/lib');
    expect(ignorePatterns).toContain('assets/sf2/*.sf2');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/public\/lib\/WebAudioFontPlayer\.js/);
    expect(gitignore).toMatch(/assets\/sf2\/\*\.sf2/);
  });

  test("README.md est ré-inclus : une redistribution sans sa notice n'en est pas une", () => {
    expect(ignorePatterns).toContain('*.md');
    expect(ignorePatterns).toContain('!README.md');
    expect(dockerfile).toMatch(/^COPY[^\n]*\bREADME\.md\b/m);
  });
});

describe('R7 — le Dockerfile embarque tout ce que le runtime importe', () => {
  const IMPORTED_AT_RUNTIME = [
    ['shared/', 'src/api/WsOutputQueue.js importe ../../shared/BinaryFrameCodec.js'],
    ['src/', "le code de l'application"],
    ['public/', 'la SPA et les 28 locales (public/locales/)'],
    ['migrations/', 'appliquées au démarrage'],
    ['server.js', "point d'entrée"],
    ['config.json', 'sinon Config retombe silencieusement sur getDefaultConfig()'],
    ['package.json', 'version lue par /api/health']
  ];

  test.each(IMPORTED_AT_RUNTIME)('COPY %s — %s', (path) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(dockerfile).toMatch(new RegExp(`^COPY[^\\n]*\\s${escaped}\\s`, 'm'));
  });

  test("aucun COPY ne référence un chemin absent de l'arbre", () => {
    const missing = [];
    for (const line of dockerfile.split('\n')) {
      if (!/^COPY\s/.test(line)) continue;
      const parts = line.trim().split(/\s+/).slice(1);
      if (parts.some((p) => p.startsWith('--from='))) continue;
      const args = parts.filter((p) => !p.startsWith('--')).slice(0, -1);
      for (const src of args) {
        const bare = src.replace(/\/$/, '');
        if (!bare.includes('*') && !existsSync(join(ROOT, bare))) missing.push(bare);
      }
    }
    // `COPY locales/` a fait échouer TOUS les builds pendant des mois.
    expect(missing).toEqual([]);
  });
});

describe("R7 — les modules natifs sont utilisables dans l'image", () => {
  test("better-sqlite3 est reconstruit puis fumé dans l'étage builder", () => {
    expect(dockerfile).toMatch(/npm rebuild better-sqlite3/);
    // Le test de fumée transforme « le conteneur meurt au boot » — que
    // personne ne regardait — en « le build échoue ».
    expect(dockerfile).toMatch(/require\('better-sqlite3'\)/);
  });

  test('aucun apt-get : plus de couche libasound2 inutile ni de miroir Debian requis', () => {
    expect(dockerfileCode).not.toMatch(/apt-get/);
  });

  test("les COPY portent --chown plutôt qu'un chown -R final", () => {
    // `chown -R appuser /app` réécrit chaque fichier dans une seconde couche
    // copy-on-write : +113 Mo mesurés sur cette image, pour rien.
    expect(dockerfileCode).not.toMatch(/chown -R/);
    expect(dockerfileCode).toMatch(/COPY --chown=appuser:appuser/);
  });

  test('le conteneur ne tourne pas en root', () => {
    expect(dockerfile).toMatch(/^USER appuser$/m);
  });
});

describe('R7 — cohérence docker-compose ↔ Dockerfile', () => {
  test('les build args du compose existent dans le Dockerfile', () => {
    for (const arg of ['NODE_IMAGE', 'WITH_RUNTIME_ASSETS']) {
      expect(compose).toMatch(new RegExp(`${arg}:\\s*\\$\\{${arg}`));
      expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}`, 'm'));
    }
  });

  test('le port publié correspond à celui que le conteneur écoute', () => {
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
    expect(compose).toMatch(/"\$\{PORT:-8080\}:8080"/);
    expect(compose).toMatch(/- PORT=8080$/m);
  });

  test("les trois répertoires d'état sont créés dans l'image ET montés en volume", () => {
    for (const dir of ['data', 'logs', 'backups']) {
      expect(dockerfile).toMatch(new RegExp(`/app/${dir}`));
      expect(compose).toMatch(new RegExp(`gmboop-${dir}:/app/${dir}`));
      expect(compose).toMatch(new RegExp(`^  gmboop-${dir}:$`, 'm'));
    }
  });

  test('le plafond de tas V8 laisse de la marge sous la limite mémoire', () => {
    const heap = Number(compose.match(/NODE_HEAP_MB:-(\d+)/)[1]);
    const limit = Number(compose.match(/MEMORY_LIMIT:-(\d+)M/)[1]);
    expect(heap).toBeGreaterThan(0);
    expect(heap / limit).toBeLessThanOrEqual(0.7);
  });
});

describe('R7 — le script de vérification est livré et exécutable', () => {
  test("scripts/verify-docker.sh existe et va jusqu'à /api/health", () => {
    const p = join(ROOT, 'scripts/verify-docker.sh');
    expect(existsSync(p)).toBe(true);
    const sh = readFileSync(p, 'utf8');
    expect(sh).toMatch(/docker build/);
    expect(sh).toMatch(/api\/health/);
    // Il refuse un /api/health qui prétendrait que l'USB est prêt dans un
    // conteneur — la régression que L12 a corrigée ne doit pas revenir.
    expect(sh).toMatch(/claims ready inside a container/);
  });
});
