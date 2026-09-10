// tests/frontend/r20-transport-header.test.js
//
// Audit R20 — F-90 ("the Stop button is never disabled, even when nothing is
// playing") and the client half of F-94 ("after a reload the header offers no
// way to stop the orchestra").
//
// Both defects live in ONE function: `updatePlaybackControls()` in
// public/index.html, which used to derive the transport buttons from the
// *selected file* instead of from the *transport*:
//
//     playPauseBtn.disabled = !currentFileId;
//     stopBtn.disabled      = !currentFileId;
//
// so Stop stayed clickable forever after the first play (the file id is kept on
// purpose, to allow a replay), and Stop stayed *disabled* after a reload,
// because a fresh page has no file id — while the backend was still playing.
//
// Rather than paraphrase that function, this suite extracts it from index.html
// and runs it, so the assertions are about the code that actually ships. The
// end-to-end proof lives in tests/e2e/specs/04-resilience.spec.mjs.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const INDEX = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');

/**
 * Extract a top-level function of the SPA's inline script. The inline script is
 * indented by 8 spaces, so the function's closing brace is the first line that
 * is exactly `        }`.
 */
function extractFunction(name) {
  const start = INDEX.indexOf(`        function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = INDEX.indexOf('\n        }\n', start);
  expect(end).toBeGreaterThan(start);
  return INDEX.slice(start, end + '\n        }'.length);
}

/**
 * Build a runnable `updatePlaybackControls` with the SPA globals it reads
 * injected as parameters.
 */
function buildUpdatePlaybackControls({
  currentFileId = null,
  isPlaying = false,
  isPaused = false,
  activePlaylistId = null,
  i18n = { t: (k) => ({ 'ui.play': 'Play' })[k] || k }
} = {}) {
  const src = extractFunction('updatePlaybackControls');
  const factory = new Function(
    'currentFileId',
    'isPlaying',
    'isPaused',
    'activePlaylistId',
    'i18n',
    `${src}\nreturn updatePlaybackControls;`
  );
  return factory(currentFileId, isPlaying, isPaused, activePlaylistId, i18n);
}

/** The header transport, as index.html declares it. */
function renderHeader() {
  document.body.innerHTML = `
    <button class="btn" id="headerPlayPauseBtn" disabled aria-label="Play">▶️ <span data-i18n="ui.play">Lecture</span></button>
    <button class="btn btn-danger" id="headerStopBtn" disabled aria-label="Stop">⏹️ Stop</button>
    <button class="btn" id="headerPrevBtn">⏮️</button>
    <button class="btn" id="headerNextBtn">⏭️</button>
    <button class="btn" id="headerPlaybackCtrlBtn" aria-expanded="false">🎛️</button>
    <div id="playbackControlsPopover" hidden></div>
    <span id="headerPlaylistInfo" class="hidden"></span>
    <div class="header-progress"><div id="headerProgressFill"></div></div>
  `;
  return {
    play: document.getElementById('headerPlayPauseBtn'),
    stop: document.getElementById('headerStopBtn'),
    ctrl: document.getElementById('headerPlaybackCtrlBtn'),
    fill: document.getElementById('headerProgressFill')
  };
}

describe('R20 · the header transport tells the truth about what is playing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('a fresh page with nothing selected offers neither Play nor Stop', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls()();
    expect(el.play.disabled).toBe(true);
    expect(el.stop.disabled).toBe(true);
    expect(el.ctrl.disabled).toBe(true);
  });

  it('a selected file enables Play but NOT Stop — nothing is playing yet', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: 4 })();
    expect(el.play.disabled).toBe(false);
    expect(el.stop.disabled).toBe(true);
  });

  it('Stop is offered while playing', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: 4, isPlaying: true })();
    expect(el.stop.disabled).toBe(false);
    expect(el.play.textContent).toContain('Pause');
    expect(el.fill.classList.contains('playing')).toBe(true);
  });

  it('Stop is offered while paused — a paused transport still holds the notes', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: 4, isPaused: true })();
    expect(el.stop.disabled).toBe(false);
  });

  // F-90: measured sequence was play → Stop → `playing:false` on the backend,
  // `#headerStopBtn.disabled === false` in the UI, forever.
  it('F-90 · after a Stop the file stays selected but Stop goes back to inert', () => {
    const el = renderHeader();
    const update = buildUpdatePlaybackControls({ currentFileId: 4 });
    update();
    expect(el.stop.disabled).toBe(true);
    expect(el.play.disabled).toBe(false); // …and the piece can be replayed
  });

  // F-94: reloaded page, backend still playing, no file id in this browser.
  it('F-94 · a live transport with no local file id still offers Stop and Pause', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: null, isPlaying: true })();
    expect(el.stop.disabled).toBe(false);
    expect(el.play.disabled).toBe(false);
    expect(el.ctrl.disabled).toBe(false);
  });

  it('the Play label goes through i18n instead of the hard-coded French one (F-91)', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({
      currentFileId: 4,
      i18n: { t: (k) => (k === 'ui.play' ? 'Reproducir' : k) }
    })();
    expect(el.play.textContent).toContain('Reproducir');
    expect(el.play.textContent).not.toContain('Lecture');
  });

  it('falls back to English rather than printing a raw key when i18n misses', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: 4, i18n: { t: (k) => k } })();
    expect(el.play.textContent).toContain('Play');
    expect(el.play.textContent).not.toContain('ui.play');
  });

  it('playlist navigation still appears only for an active playlist', () => {
    const el = renderHeader();
    buildUpdatePlaybackControls({ currentFileId: 4, isPlaying: true, activePlaylistId: 9 })();
    expect(document.getElementById('headerPrevBtn').style.display).toBe('');
    expect(document.getElementById('headerPlaylistInfo').classList.contains('hidden')).toBe(false);
    expect(el.stop.disabled).toBe(false);
  });
});

describe('R20 · the SPA asks the server what it is playing when it connects', () => {
  it('loads the resync module', () => {
    expect(INDEX).toContain('js/features/transport/PlaybackResync.js');
  });

  it('resynchronises on every connection, not only the first one', () => {
    // The `connected` handler gates one-time UI wiring behind
    // `connectedCount === 1`; the resync must sit OUTSIDE that gate, because a
    // Wi-Fi drop can hide a transition the client never saw.
    const handler = INDEX.slice(
      INDEX.indexOf("api.on('connected'"),
      INDEX.indexOf("api.on('disconnected'")
    );
    expect(handler).toContain('resyncTransportFromBackend()');
    const gate = handler.indexOf('if (connectedCount === 1)');
    const call = handler.indexOf('resyncTransportFromBackend()');
    const gateEnd = handler.indexOf('}', handler.indexOf('initAdvancedFilters'));
    expect(call > gateEnd || call < gate).toBe(true);
  });

  it('reads the state from the backend command, never from local state alone', () => {
    const fn = INDEX.slice(
      INDEX.indexOf('async function resyncTransportFromBackend()'),
      INDEX.indexOf("api.on('playback_status'")
    );
    expect(fn).toContain('api.getPlaybackStatus()');
    expect(fn).toContain('window.PlaybackResync.plan(');
    // Nothing playing must actively clear the transport, not be ignored.
    expect(fn).toContain('isPlaying = false');
  });

  it('BackendAPIClient exposes the playback_status command it needs', () => {
    const src = readFileSync(resolve(ROOT, 'public', 'js', 'api', 'BackendAPIClient.js'), 'utf8');
    const sent = [];
    const client = {
      sendCommand(command, data) {
        sent.push([command, data]);
        return Promise.resolve({});
      }
    };
    new Function(`${src}\nreturn window.BackendAPIClient;`)();
    const Klass = window.BackendAPIClient;
    expect(typeof Klass.prototype.getPlaybackStatus).toBe('function');
    Klass.prototype.getPlaybackStatus.call(client);
    expect(sent).toEqual([['playback_status', undefined]]);
  });
});
