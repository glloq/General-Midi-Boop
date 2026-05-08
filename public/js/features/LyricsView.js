/**
 * @file public/js/features/LyricsView.js
 * @description Karaoke lyrics ribbon — horizontal scrolling band during playback.
 *
 * Fixed at the bottom of the viewport (z-index 60, above piano roll at 50).
 * Text scrolls right→left; the current token is highlighted at a fixed marker.
 * Body gets class "lyrics-visible" when shown so the piano roll adjusts its
 * bottom offset via CSS.
 *
 * Events consumed (via eventBus):
 *   file:selected           { fileId, lyrics:[{tick,text}], tempo, ticksPerBeat, tempoMap }
 *   playback:play           {}
 *   playback:pause          {}
 *   playback:stop           {}
 *   playback:time           { time }   (seconds)
 *   settings:lyrics_changed { enabled }
 */
class LyricsView {
  // pixels per second of audio (scroll speed)
  static PPS = 80;
  // px from left of stage where "now" is fixed
  static MARKER_LEFT = 140;

  constructor(eventBus, logger = {}) {
    this.eventBus = eventBus;
    this.log = {
      info:  m => (logger.info  || console.log)(m),
      warn:  m => (logger.warn  || console.warn)(m),
      error: m => (logger.error || console.error)(m),
    };

    this.isEnabled  = false;
    this.isVisible  = false;
    this.isPlaying  = false;

    this.lyrics     = [];   // [{startSec, endSec, text, _el}]
    this.currentIdx = -1;

    // rAF interpolation
    this._lastKnownTime = 0;
    this._lastKnownAt   = 0;
    this._rafId         = null;

    // Timing params for tick→second conversion
    this.tempo        = 120;
    this.ticksPerBeat = 480;
    this.tempoMap     = [];

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
      const s = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
      this.isEnabled = s.showLyrics || false;
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  createDOM() {
    this.container = document.createElement('div');
    this.container.id = 'lyrics-ribbon';
    this.container.className = 'lyrics-ribbon hidden';
    this.container.innerHTML = `
      <div class="lyrics-ribbon-icon">🎤</div>
      <div class="lyrics-ribbon-stage">
        <div class="lyrics-ribbon-marker"></div>
        <div class="lyrics-ribbon-track"></div>
      </div>
      <button class="lyrics-ribbon-close" title="Fermer">✕</button>
    `;

    // Append directly to body so piano-roll's hidden-for-pianoroll doesn't affect it
    document.body.appendChild(this.container);

    this.container.querySelector('.lyrics-ribbon-close').addEventListener('click', () => {
      this.hide();
      try {
        const s = JSON.parse(localStorage.getItem('gmboop_settings') || '{}');
        s.showLyrics = false;
        localStorage.setItem('gmboop_settings', JSON.stringify(s));
      } catch (e) {}
      window.eventBus?.emit('settings:lyrics_changed', { enabled: false });
    });

    this._stageEl = this.container.querySelector('.lyrics-ribbon-stage');
    this._trackEl = this.container.querySelector('.lyrics-ribbon-track');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  setupEvents() {
    if (!this.eventBus) return;
    this._eventUnsubs = [
      this.eventBus.on('settings:lyrics_changed', d => {
        this.isEnabled = d.enabled;
        if (!this.isEnabled) this.hide();
        else if (this.lyrics.length > 0 && this.isPlaying) this.show();
      }),

      this.eventBus.on('file:selected', data => {
        this.loadLyrics(data.lyrics || [], data.tempo, data.ticksPerBeat, data.tempoMap || []);
      }),

      this.eventBus.on('playback:play', () => {
        this.isPlaying = true;
        if (this.isEnabled && this.lyrics.length > 0) {
          this.show();
          this._startRAF();
        }
      }),

      this.eventBus.on('playback:pause', () => {
        this.isPlaying = false;
        this._stopRAF();
      }),

      this.eventBus.on('playback:stop', () => {
        this.isPlaying = false;
        this._stopRAF();
        this.hide();
        this._resetRibbon();
      }),

      this.eventBus.on('playback:time', data => {
        this._lastKnownTime = data.time || 0;
        this._lastKnownAt   = performance.now();
        // When rAF isn't running (paused), still update position
        if (!this._rafId && this.isVisible) this._updateRibbon(this._lastKnownTime);
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  loadLyrics(rawLyrics, tempo = 120, ticksPerBeat = 480, tempoMap = []) {
    this.tempo        = tempo;
    this.ticksPerBeat = ticksPerBeat;
    this.tempoMap     = tempoMap;
    this.currentIdx   = -1;

    if (!rawLyrics || rawLyrics.length === 0) {
      this.lyrics = [];
      this._trackEl.innerHTML = '';
      if (this.isVisible) this.hide();
      return;
    }

    const converted = rawLyrics
      .map(ev => ({
        startSec: this._ticksToSeconds(ev.tick),
        text:     this._stripKarMarkers(ev.text),
      }))
      .filter(ev => ev.text.length > 0);

    if (converted.length === 0) {
      this.lyrics = [];
      this._trackEl.innerHTML = '';
      return;
    }

    this.lyrics = converted.map((ev, i) => ({
      startSec: ev.startSec,
      endSec:   converted[i + 1] ? converted[i + 1].startSec : ev.startSec + 999,
      text:     ev.text,
      _el:      null,
    }));

    this._buildRibbon();
  }

  _buildRibbon() {
    const PPS = LyricsView.PPS;
    this._trackEl.innerHTML = '';

    this.lyrics.forEach(item => {
      const span = document.createElement('span');
      span.className = 'lyrics-ribbon-token';
      span.textContent = item.text;
      span.style.left = `${item.startSec * PPS}px`;
      item._el = span;
      this._trackEl.appendChild(span);
    });

    // Track width = last token end time + some buffer
    const last = this.lyrics[this.lyrics.length - 1];
    this._trackEl.style.width = `${(last.endSec + 10) * PPS}px`;

    // Reset position to start
    this._updateRibbon(0);
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------

  _startRAF() {
    if (this._rafId) return;
    const tick = () => {
      if (!this.isPlaying || !this.isVisible) {
        this._rafId = null;
        return;
      }
      // Interpolate current time from last known sync point
      const elapsed = (performance.now() - this._lastKnownAt) / 1000;
      this._updateRibbon(this._lastKnownTime + elapsed);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopRAF() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  _updateRibbon(time) {
    if (!this._trackEl) return;
    const PPS        = LyricsView.PPS;
    const markerLeft = LyricsView.MARKER_LEFT;

    // Translate the track so "time" aligns with the marker
    this._trackEl.style.transform = `translateX(${markerLeft - time * PPS}px)`;

    // Find active token
    let idx = -1;
    for (let i = 0; i < this.lyrics.length; i++) {
      if (time >= this.lyrics[i].startSec && time < this.lyrics[i].endSec) {
        idx = i;
        break;
      }
    }
    if (idx === this.currentIdx) return;

    // Update token classes for past / active / upcoming
    this.lyrics.forEach((item, i) => {
      const el = item._el;
      if (!el) return;
      if      (i < idx)  { el.classList.add('past');   el.classList.remove('active'); }
      else if (i === idx) { el.classList.add('active'); el.classList.remove('past'); }
      else               { el.classList.remove('past', 'active'); }
    });
    this.currentIdx = idx;
  }

  _resetRibbon() {
    this.currentIdx = -1;
    if (this._trackEl) {
      this._trackEl.style.transform = `translateX(${LyricsView.MARKER_LEFT}px)`;
    }
    this.lyrics.forEach(item => item._el?.classList.remove('active', 'past'));
  }

  // ---------------------------------------------------------------------------
  // KAR format cleaning
  // ---------------------------------------------------------------------------

  _stripKarMarkers(text) {
    if (!text) return '';
    if (text.startsWith('@')) return '';
    if (text.includes('<')) {
      text = text.slice(text.indexOf('<') + 1);
    } else if (text.startsWith('%')) {
      return '';
    }
    return text.replace(/%[A-Za-z0-9#b+°øΔ/-]+/g, '').replace(/[\x00-\x1f]/g, '').trim();
  }

  // ---------------------------------------------------------------------------
  // Tick → second conversion
  // ---------------------------------------------------------------------------

  _ticksToSeconds(tick) {
    if (this.tempoMap && this.tempoMap.length > 0) {
      let elapsed  = 0;
      let prevTick = 0;
      let prevBpm  = 120;
      for (const pt of this.tempoMap) {
        if (pt.tick >= tick) break;
        elapsed += ((pt.tick - prevTick) / this.ticksPerBeat) * (60 / prevBpm);
        prevTick = pt.tick;
        prevBpm  = pt.bpm;
      }
      elapsed += ((tick - prevTick) / this.ticksPerBeat) * (60 / prevBpm);
      return elapsed;
    }
    return (tick / this.ticksPerBeat) * (60 / (this.tempo || 120));
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  show() {
    if (this.isVisible) return;
    this.isVisible = true;
    this.container.classList.remove('hidden');
    document.body.classList.add('lyrics-visible');
    if (this.isPlaying) this._startRAF();
  }

  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this._stopRAF();
    this.container.classList.add('hidden');
    document.body.classList.remove('lyrics-visible');
  }

  destroy() {
    this._stopRAF();
    this._eventUnsubs.forEach(fn => fn && fn());
    this._eventUnsubs = [];
    document.body.classList.remove('lyrics-visible');
    this.container?.remove();
  }
}

window.LyricsView = LyricsView;
