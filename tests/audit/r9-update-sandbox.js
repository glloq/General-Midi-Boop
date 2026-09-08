/**
 * @file tests/audit/r9-update-sandbox.js
 * @description Throwaway sandbox for exercising `scripts/update.sh`.
 *
 * NOT a test suite (no `.test.js` suffix, Jest does not collect it) — it is
 * the harness the `r9-*` suites use.
 *
 * The real script is copied into a **disposable git repository** under the OS
 * temp dir, with a fake `origin` it can actually pull from, and with every
 * external command it shells out to replaced by a stub on `PATH`
 * (`npm`, `node`, `lsof`, `systemctl`, `curl`, `sleep`). Nothing here touches
 * the working copy, the host's services, or the network: no update is ever
 * run on this machine.
 *
 * Failure injection is done with environment variables read by the stubs:
 *   FAIL_INSTALL / FAIL_BUILD / FAIL_MIGRATE = 1
 *   FAKE_PORT_LISTENING = 0|1   what the `lsof` stub reports
 *   FAKE_NODE_MODE = die|live   whether a directly started server survives
 */
import { execFileSync } from 'child_process';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'fs';
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../..');
export const REAL_SCRIPT = join(REPO_ROOT, 'scripts/update.sh');

/** Run a git command inside `cwd`, throwing on failure. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'R9',
      GIT_AUTHOR_EMAIL: 'r9@example.invalid',
      GIT_COMMITTER_NAME: 'R9',
      GIT_COMMITTER_EMAIL: 'r9@example.invalid'
    }
  }).trim();
}

const DEFAULT_CONFIG = {
  server: { port: 8080, host: '0.0.0.0' },
  database: { path: './data/gmboop.db' }
};

/** Contents of the fake project, before the operator touches anything. */
function seedProject(dir) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'gmboop-fake', version: '1.0.0' }, null, 2) + '\n'
  );
  writeFileSync(join(dir, 'server.js'), '// fake server\n');
  writeFileSync(join(dir, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  writeFileSync(join(dir, 'scripts/migrate-db.js'), '// fake migration runner\n');
  writeFileSync(join(dir, 'src/marker.txt'), 'v1\n');
  writeFileSync(join(dir, '.gitignore'), 'logs/\nbackups/\nnode_modules/\ndist/\ndata/\n');
  // The script under test, verbatim.
  copyFileSync(REAL_SCRIPT, join(dir, 'scripts/update.sh'));
  chmodSync(join(dir, 'scripts/update.sh'), 0o755);
}

/** Write an executable stub on the sandbox PATH. */
function stub(binDir, name, body) {
  const p = join(binDir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function writeStubs(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });

  // npm: records every invocation, fails on demand.
  stub(
    binDir,
    'npm',
    `echo "npm $*" >> "${logPath}"
case "$1 $2" in
  "install --ignore-scripts")
      [ "\${FAIL_INSTALL:-0}" = "1" ] && { echo "npm install (fallback) failed" >&2; exit 1; }
      mkdir -p node_modules && echo installed > node_modules/.stamp; exit 0 ;;
esac
case "$1" in
  install)
      [ "\${FAIL_INSTALL:-0}" = "1" ] && { echo "npm ERR! install failed" >&2; exit 1; }
      mkdir -p node_modules && echo installed > node_modules/.stamp; exit 0 ;;
  rebuild) exit 0 ;;
  run)
      case "$2" in
        build)
            [ "\${FAIL_BUILD:-0}" = "1" ] && { echo "vite: build failed" >&2; exit 1; }
            mkdir -p dist && echo "<html>new bundle</html>" > dist/index.html; exit 0 ;;
        migrate)
            DB="$PWD/data/gmboop.db"
            if [ "\${FAIL_MIGRATE:-0}" = "1" ]; then
                echo "PARTIAL" >> "$DB"
                echo "SQLITE_ERROR: near \\"ALTER\\": syntax error" >&2
                exit 1
            fi
            echo "MIGRATED" >> "$DB"; exit 0 ;;
      esac
      exit 0 ;;
esac
exit 0`
  );

  // node: only ever used by the script for `node -p <expr>` and to start the
  // server directly in the last-resort restart path.
  stub(
    binDir,
    'node',
    `if [ "$1" = "-p" ]; then
    case "$2" in
      *database*) echo "./data/gmboop.db" ;;
      *server.port*) echo "8080" ;;
      *package.json*) echo "1.0.0" ;;
      *) echo "" ;;
    esac
    exit 0
fi
echo "node $*" >> "${logPath}"
if [ "\${FAKE_NODE_MODE:-die}" = "live" ]; then exec /usr/bin/sleep 3; fi
exit 1`
  );

  // lsof: the port probe. Answers whatever the scenario says.
  stub(binDir, 'lsof', `[ "\${FAKE_PORT_LISTENING:-1}" = "1" ] && { echo 4242; exit 0; }; exit 1`);

  // No PM2 / no systemd unit in the sandbox.
  stub(binDir, 'systemctl', 'exit 1');
  stub(binDir, 'curl', 'echo "000"; exit 1');
  // Keep the script's many settle-delays short but non-zero: the direct-start
  // path needs a real moment to observe that the fake server died.
  stub(binDir, 'sleep', 'exec /usr/bin/sleep 0.25');
}

/**
 * Build a disposable project + fake origin and return handles on both.
 *
 * @returns {Object} sandbox
 */
export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gmboop-r9-'));
  const upstream = join(root, 'upstream');
  const work = join(root, 'work');
  const binDir = join(root, 'bin');
  const cmdLog = join(root, 'commands.log');

  mkdirSync(upstream, { recursive: true });
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'config', 'user.email', 'r9@example.invalid');
  git(upstream, 'config', 'user.name', 'R9');
  seedProject(upstream);
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-q', '-m', 'v1');

  git(root, 'clone', '-q', upstream, work);
  git(work, 'config', 'user.email', 'r9@example.invalid');
  git(work, 'config', 'user.name', 'R9');
  mkdirSync(join(work, 'data'), { recursive: true });
  writeFileSync(join(work, 'data/gmboop.db'), 'SCHEMA_V1\n');
  writeStubs(binDir, cmdLog);
  writeFileSync(cmdLog, '');

  const api = {
    root,
    work,
    upstream,
    binDir,

    /** Publish a new upstream revision the update will pull. */
    publishUpstream(mutate = () => {}) {
      mutate(upstream);
      writeFileSync(join(upstream, 'src/marker.txt'), 'v2\n');
      git(upstream, 'add', '-A');
      git(upstream, 'commit', '-q', '-m', 'v2');
      return git(upstream, 'rev-parse', 'HEAD');
    },

    head(dir = work) {
      return git(dir, 'rev-parse', 'HEAD');
    },

    read(rel, dir = work) {
      return readFileSync(join(dir, rel), 'utf8');
    },

    write(rel, content, dir = work) {
      writeFileSync(join(dir, rel), content);
    },

    exists(rel, dir = work) {
      return existsSync(join(dir, rel));
    },

    /** Status line written by the script (`logs/update-status`). */
    status() {
      try {
        return readFileSync(join(work, 'logs/update-status'), 'utf8').trim();
      } catch {
        return null;
      }
    },

    /** Full transcript (`logs/update.log`). */
    log() {
      try {
        return readFileSync(join(work, 'logs/update.log'), 'utf8');
      } catch {
        return '';
      }
    },

    /** Everything the npm/node stubs were asked to do, in order. */
    commands() {
      return readFileSync(cmdLog, 'utf8').trim().split('\n').filter(Boolean);
    },

    /**
     * Run the script for real, in the sandbox, non-interactively but without
     * the double-fork (so the exit status is observable).
     *
     * @param {Object} [env] Extra environment (failure injection).
     */
    run(env = {}) {
      return spawnSync('bash', [join(work, 'scripts/update.sh')], {
        cwd: work,
        encoding: 'utf8',
        timeout: 120000,
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          HOME: root,
          LANG: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          NON_INTERACTIVE: '1',
          // Skip the double-fork: we want to observe this process's exit code.
          _GMBOOP_UPDATE_DETACHED: '1',
          UPDATE_DELAY_SECONDS: '0',
          SERVER_PORT: '8080',
          FAKE_PORT_LISTENING: '1',
          FAKE_NODE_MODE: 'die',
          ...env
        }
      });
    },

    /**
     * Source the script in library mode and run bash code against its
     * helpers. Nothing is pulled, installed or restarted.
     *
     * @param {string} code Bash snippet appended after the `source`.
     * @param {Object} [env]
     */
    lib(code, env = {}) {
      const snippet = `set -o pipefail
export GMBOOP_UPDATE_LIB_ONLY=1
source "${join(work, 'scripts/update.sh')}"
${code}`;
      return spawnSync('bash', ['-c', snippet], {
        cwd: work,
        encoding: 'utf8',
        timeout: 60000,
        env: {
          PATH: `${binDir}:/usr/bin:/bin`,
          HOME: root,
          LANG: 'C',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          ...env
        }
      });
    },

    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };

  return api;
}
