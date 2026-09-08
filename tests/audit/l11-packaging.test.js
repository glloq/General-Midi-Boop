// tests/audit/l11-packaging.test.js
//
// Lot L11 — §B04 (Docker) et §B03 (PM2/systemd). Tests de CARACTÉRISATION :
// ils décrivent l'état PROUVÉ du packaging à HEAD. `Dockerfile`,
// `docker-compose.yml` et `ecosystem.config.cjs` sont des fichiers partagés :
// L11 propose les diffs, il ne les applique pas.
//
// Preuves d'exécution (docker 29.3.1, 2026-09-07, journaux dans le bac à
// sable du lot) :
//   1. `docker build .`                       -> ERROR "/locales": not found
//   2. + COPY corrigé                          -> conteneur Exited(1) :
//        Cannot find module '/app/shared/BinaryFrameCodec.js'
//   3. + COPY shared/ assets/ scripts/ config.json -> Exited(1) :
//        better-sqlite3 « Could not locate the bindings file »
//        (conséquence directe de `npm ci --ignore-scripts`)
//   4. + `npm rebuild better-sqlite3`          -> Up, GET /api/health = 200
//      image 456 MB, build 11 s à chaud / ~75 s à froid.
//
// MISE À JOUR — vague 2, R7 (2026-09-08). Le correctif est APPLIQUÉ. Les tests
// §B04 ci-dessous, que ce fichier annonçait lui-même « à inverser après
// correctif », assertent désormais l'état CORRIGÉ : chaque inversion garde en
// commentaire ce qui était caractérisé. §B03 (PM2/systemd, F-127) reste ouvert
// et ses tests sont inchangés. Les vérifications ajoutées par R7 vivent dans
// tests/audit/r7-packaging.test.js.

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

/**
 * Chemins sources de chaque `COPY <src> <dst>` hors `COPY --from=`.
 *
 * Les drapeaux (`--chown=`, `--chmod=`) sont retirés avant l'analyse : depuis
 * R7 chaque COPY porte `--chown=appuser:appuser`, et l'ancienne expression
 * rationnelle ne reconnaissait plus AUCUN de ces COPY — les assertions
 * `not.toContain(...)` passaient alors à vide, ce qui est un faux vert.
 */
function copySources(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!/^COPY\s/.test(line)) continue;
    const parts = line.trim().split(/\s+/).slice(1);
    if (parts.some((p) => p.startsWith('--from='))) continue;
    const args = parts.filter((p) => !p.startsWith('--'));
    if (args.length >= 2) out.push(...args.slice(0, -1));
  }
  return out;
}

describe('L11 §B04 — le Dockerfile se construit (corrigé par R7)', () => {
  const sources = copySources(dockerfile);

  test('aucun COPY ne pointe dans le vide (F-118 / F-157 — corrigé)', () => {
    // CARACTÉRISÉ AVANT R7 : `expect(sources).toContain('locales/')`, un
    // répertoire racine qui n'a jamais existé -> `"/locales": not found`,
    // et donc `docker build` en échec systématique.
    expect(sources).not.toContain('locales/');
    expect(existsSync(join(ROOT, 'locales'))).toBe(false);
    // Les locales vivent sous public/locales/ — déjà copiées par COPY public/.
    expect(existsSync(join(ROOT, 'public/locales'))).toBe(true);
    expect(sources).toContain('public/');

    // La garde générale : chaque source de COPY existe réellement dans l'arbre.
    for (const src of sources) {
      const bare = src.replace(/\/$/, '');
      if (bare.includes('*')) continue;
      expect({ src, exists: existsSync(join(ROOT, bare)) }).toEqual({ src, exists: true });
    }
  });

  test("shared/ est importé par le runtime ET copié dans l'image (F-157 — corrigé)", () => {
    // CARACTÉRISÉ AVANT R7 : `expect(sources).not.toContain('shared/')`.
    // Conséquence mesurée : Exited(1) avec ERR_MODULE_NOT_FOUND sur
    // file:///app/shared/BinaryFrameCodec.js — reproduit à nouveau en R7 en
    // retirant la ligne, puis vert avec elle.
    const wsQueue = readFileSync(join(ROOT, 'src/api/WsOutputQueue.js'), 'utf8');
    expect(wsQueue).toMatch(/from '\.\.\/\.\.\/shared\/BinaryFrameCodec\.js'/);
    expect(existsSync(join(ROOT, 'shared/BinaryFrameCodec.js'))).toBe(true);
    expect(sources).toContain('shared/');
  });

  test("scripts/ et config.json sont copiés, assets/ vient de l'étage builder (corrigé)", () => {
    // CARACTÉRISÉ AVANT R7 : aucun des trois n'était copié. Conséquences :
    // pas de soundfont par défaut, `system_update` renvoyait « Update script
    // not found », et la configuration livrée était silencieusement remplacée
    // par getDefaultConfig().
    expect(sources).toContain('scripts/');
    expect(sources).toContain('config.json');
    // assets/ n'est PAS copié depuis le contexte : le soundfont est
    // gitignoré et récupéré dans l'étage builder, d'où il est repris par
    // `COPY --from=builder /app/assets` — l'image ne dépend donc pas de ce
    // qui traîne sur le disque du développeur.
    expect(sources).not.toContain('assets/');
    expect(dockerfile).toMatch(/COPY --from=builder[^\n]*\/app\/assets \.\/assets/);
    const sysCmds = readFileSync(join(ROOT, 'src/api/commands/SystemCommands.js'), 'utf8');
    expect(sysCmds).toMatch(/Update script not found or not executable/);
  });

  test('le binding better-sqlite3 est reconstruit après --ignore-scripts (F-118 — corrigé)', () => {
    // CARACTÉRISÉ AVANT R7 : `expect(dockerfile).not.toMatch(/npm rebuild/)`.
    // --ignore-scripts reste nécessaire (l'étage builder n'a ni Python ni
    // toolchain, `midi` ferait échouer tout le npm ci), mais il prive AUSSI
    // better-sqlite3 de son install script. Sans le rebuild ciblé, le build
    // réussit et le conteneur meurt au boot sur « Could not locate the
    // bindings file » — reproduit à nouveau en R7 : Exited(1).
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(dockerfile).toMatch(/npm rebuild better-sqlite3/);
    // Et le paquet est bien une dépendance de production obligatoire.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies['better-sqlite3']).toBeDefined();
  });

  test("l'étage runtime n'installe plus libasound2 (couche inutile — corrigé)", () => {
    // CARACTÉRISÉ AVANT R7 : `RUN apt-get install … libasound2`. Inutile sans
    // le module natif `midi`, que --ignore-scripts ne bâtit jamais — et la
    // couche faisait dépendre chaque build d'un miroir Debian joignable.
    // libasound2 n'apparaît plus que dans le commentaire qui explique
    // comment réactiver le MIDI USB matériel : plus aucun apt-get.
    expect(dockerfile).not.toMatch(/^\s*RUN\s+apt-get/m);
  });
});

describe('L11 §B04 — cohérence docker-compose ↔ Dockerfile', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

  test('le plafond de tas V8 est strictement sous la limite mémoire du conteneur (corrigé)', () => {
    // CARACTÉRISÉ AVANT R7 : `memory: 512M` face à `ENV NODE_HEAP_MB=512`.
    // 512 Mo de tas V8 DANS 512 Mo de conteneur : RSS = tas + heap natif +
    // buffers + code. L'OOM-killer arrivait avant la limite V8.
    const heap = Number(compose.match(/NODE_HEAP_MB:-(\d+)/)[1]);
    const limit = Number(compose.match(/MEMORY_LIMIT:-(\d+)M/)[1]);
    expect(heap).toBeLessThan(limit);
    // Marge : RSS = tas V8 + heap natif + buffers + code. Viser ~60-65 %.
    expect(heap / limit).toBeLessThanOrEqual(0.7);
  });

  test('aucun volume ne persiste dist/ ni public/lib : le repli CDN survit aux redémarrages', () => {
    expect(compose).toMatch(/gmboop-data:\/app\/data/);
    expect(compose).not.toMatch(/\/app\/public\/lib/);
    expect(compose).not.toMatch(/\/app\/dist/);
  });
});

describe('L11 §B03 — PM2 et systemd divergent', () => {
  const eco = readFileSync(join(ROOT, 'ecosystem.config.cjs'), 'utf8');
  const install = readFileSync(join(ROOT, 'scripts/Install.sh'), 'utf8');

  test('Install.sh installe un service systemd, jamais PM2 sur Linux (F-124)', () => {
    // PM2 est installé globalement (étape 3) puis n'est utilisé que sur macOS.
    expect(install).toMatch(/sudo npm install -g pm2/);
    expect(install).toMatch(/\/etc\/systemd\/system\/gmboop\.service/);
    const macosBlock = install.slice(
      install.indexOf('elif [ "$OS" == "macos" ]', install.indexOf('print_step "8.'))
    );
    expect(macosBlock).toMatch(/pm2 start ecosystem\.config\.cjs/);
  });

  test("l'unité systemd n'applique aucun des réglages mémoire d'ecosystem.config.cjs (F-124)", () => {
    expect(eco).toMatch(/--max-old-space-size=\$\{HEAP_MB\}/);
    expect(eco).toMatch(/max_memory_restart/);
    // L'unité écrite par Install.sh est un `ExecStart=$NODE_PATH server.js`
    // nu : ni --max-old-space-size, ni --expose-gc, ni EnvironmentFile=.env.
    const unit = install.slice(install.indexOf('[Unit]'), install.indexOf('[Install]'));
    expect(unit).toMatch(/ExecStart=\$NODE_PATH \$WORKING_DIR\/server\.js/);
    expect(unit).not.toMatch(/max-old-space-size/);
    expect(unit).not.toMatch(/EnvironmentFile/);
  });

  test('update.sh sait redémarrer PM2 ET systemd, mais suppose un sudo sans mot de passe non installé (F-123)', () => {
    const update = readFileSync(join(ROOT, 'scripts/update.sh'), 'utf8');
    expect(update).toMatch(/sudo -n systemctl restart gmboop/);
    // Install.sh n'écrit AUCUNE règle sudoers pour systemctl : seules
    // hciconfig/rfkill (bluetooth) et hotspot.sh sont autorisées sans mot
    // de passe. Le redémarrage systemd d'une mise à jour échoue donc, et
    // le script retombe sur le chemin « kill par port + node nu ».
    expect(install).toMatch(/NOPASSWD: \/usr\/bin\/hciconfig hci0 up/);
    expect(install).toMatch(/NOPASSWD: \$HOTSPOT_SCRIPT/);
    expect(install).not.toMatch(/NOPASSWD:.*systemctl/);
  });
});
