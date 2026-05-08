/**
 * @file public/js/features/LyricsView.js
 * @description Karaoke lyrics panel — shows synced lyric lines during playback.
 *
 * Lifecycle:
 *   new LyricsView(eventBus, logger)  → auto-creates DOM + listens to events
 *
 * Events consumed (via eventBus):
 *   file:selected          { fileId, lyrics:[{tick, text}], tempo, ticksPerBeat }
 *   playback:play          { fileId }
 *   playback:pause         {}
 *   playback:stop          {}
 *   playback:time          { time }          (seconds, from MidiSynthesizer)
 *   settings:lyrics_changed { enabled }
 *
 * Tick→second conversion uses the tempo map embedded in file:selected.
 */
class LyricsView {
  constructor(eventBus, logger = {}) {
    this.eventBus = eventBus;
    this.log = {
      info:  (m) => (logger.info  || console.log)(m),
      warn:  (m) => (logger.warn  || console.warn)(m),
      error: (m) => (logger.error || console.error)(m),
    };

    this.isEnabled = false;
    this.isVisible = false;

    // Current playback state
    this.lyrics = [];       // [{startSec, endSec, text}] — converted from ticks
    this.currentTime = 0;
    this.currentLineIdx = -1;

    // Timing params for tick→second conversion
    this.tempo = 120;
    this.ticksPerBeat = 480;
    this.tempoMap = [];     // [{tick, bpm}] from file:selected

    this._eventUnsubs = [];

    this.loadSettings();
    this.createDOM();
    this.setupEvents();
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  loadSettings() {
    try {
      const saved = localStorage.getItem('gmboop_settings');
      if (saved) {
        const s = JSON.parse(saved);
        this.isEnabled = s.showLyrics || false;
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  createDOM() {
    this.container = document.createElement('div');
    this.container.id = 'lyrics-view';
    this.container.className = 'lyrics-view hidden';
    this.container.innerHTML = `
      <div class="lyrics-view-header">
        <span class="lyrics-view-icon">🎤</span>
        <span class="lyrics-view-title">Paroles</span>
        <button class="lyrics-view-close" title="Fermer">✕</button>
      </div>
      <div class="lyrics-view-content">
        <div class="lyrics-prev-line"></div>
        <div class="lyrics-current-line"></div>
        <div class="lyrics-next-line"></div>
      </div>
    `;

    this.container.querySelector('.lyrics-view-close').addEventListener('click', () => {
      this.hide();
      // Persist the disabled state
      try {
        const s = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
        s.showLyrics = false;
        localStorage.setItem('gmboop_settings', JSON.stringify(s));
      } catch (e) {}
      if (window.eventBus) window.eventBus.emit('settings:lyrics_changed', { enabled: false });
    });

    const main = document.querySelector('.container');
    if (main) main.appendChild(this.container);
    else document.body.appendChild(this.container);

    this._prevEl    = this.container.querySelector('.lyrics-prev-line');
    this._currentEl = this.container.querySelector('.lyrics-current-line');
    this._nextEl    = this.container.querySelector('.lyrics-next-line');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  setupEvents() {
    if (!this.eventBus) return;

    this._eventUnsubs = [
      this.eventBus.on('settings:lyrics_changed', (d) => {
        this.isEnabled = d.enabled;
        if (!this.isEnabled && this.isVisible) this.hide();
        else if (this.isEnabled && this.lyrics.length > 0) this.show();
      }),

      this.eventBus.on('file:selected', (data) => {
        this.loadLyrics(data.lyrics || [], data.tempo, data.ticksPerBeat, data.tempoMap || []);
      }),

      this.eventBus.on('playback:play', () => {
        if (this.isEnabled && this.lyrics.length > 0) this.show();
      }),

      this.eventBus.on('playback:pause', () => {
        // Keep visible, nothing to cancel
      }),

      this.eventBus.on('playback:stop', () => {
        this.hide();
        this.currentTime = 0;
        this.currentLineIdx = -1;
        this._renderLines();
      }),

      this.eventBus.on('playback:time', (data) => {
        if (!this.isVisible) return;
        this.currentTime = data.time || 0;
        this._renderLines();
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /**
   * Receive lyrics from the playFile flow.
   * @param {Array} rawLyrics   [{tick, text}] sorted by tick
   * @param {number} tempo      BPM (first tempo event)
   * @param {number} ticksPerBeat
   * @param {Array} tempoMap    [{tick, bpm}] for multi-tempo files
   */
  loadLyrics(rawLyrics, tempo = 120, ticksPerBeat = 480, tempoMap = []) {
    this.tempo = tempo;
    this.ticksPerBeat = ticksPerBeat;
    this.tempoMap = tempoMap;
    this.currentLineIdx = -1;
    this.currentTime = 0;

    if (!rawLyrics || rawLyrics.length === 0) {
      this.lyrics = [];
      if (this.isVisible) this.hide();
      return;
    }

    // Convert ticks → seconds for each lyric event
    const converted = rawLyrics.map(ev => ({
      startSec: this._ticksToSeconds(ev.tick),
      text: ev.text
    }));

    // Compute end time of each line = start of next line (last ends at +999s)
    this.lyrics = converted.map((ev, i) => ({
      startSec: ev.startSec,
      endSec: converted[i + 1] ? converted[i + 1].startSec : ev.startSec + 999,
      text: ev.text
    }));

    this._renderLines();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _renderLines() {
    const t = this.currentTime;
    let idx = -1;
    for (let i = 0; i < this.lyrics.length; i++) {
      if (t >= this.lyrics[i].startSec && t < this.lyrics[i].endSec) {
        idx = i;
        break;
      }
    }
    if (idx === this.currentLineIdx) return; // nothing changed
    this.currentLineIdx = idx;

    this._prevEl.textContent    = idx > 0 ? this.lyrics[idx - 1].text : '';
    this._currentEl.textContent = idx >= 0 ? this.lyrics[idx].text : '';
    this._nextEl.textContent    = (idx >= 0 && idx + 1 < this.lyrics.length)
      ? this.lyrics[idx + 1].text : '';
  }

  // ---------------------------------------------------------------------------
  // Tick → second conversion (mirrors MidiSynthesizer logic)
  // ---------------------------------------------------------------------------

  _ticksToSeconds(tick) {
    if (this.tempoMap && this.tempoMap.length > 0) {
      let elapsedSec = 0;
      let prevTick = 0;
      let prevBpm  = 120;

      for (const point of this.tempoMap) {
        if (point.tick >= tick) break;
        elapsedSec += ((Math.min(point.tick, tick) - prevTick) / this.ticksPerBeat) * (60 / prevBpm);
        prevTick = point.tick;
        prevBpm  = point.bpm;
      }
      elapsedSec += ((tick - prevTick) / this.ticksPerBeat) * (60 / prevBpm);
      return elapsedSec;
    }
    // Single tempo fallback
    return (tick / this.ticksPerBeat) * (60 / (this.tempo || 120));
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  show() {
    if (this.isVisible) return;
    this.isVisible = true;
    this.container.classList.remove('hidden');
    this._renderLines();
  }

  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.container.classList.add('hidden');
  }

  destroy() {
    this._eventUnsubs.forEach(fn => fn && fn());
    this._eventUnsubs = [];
    this.container?.remove();
  }
}

// Make available globally (no bundler)
window.LyricsView = LyricsView;
