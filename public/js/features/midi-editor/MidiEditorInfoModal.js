// ============================================================================
// File: public/js/features/midi-editor/MidiEditorInfoModal.js
// Description: Popup d'informations complètes du fichier MIDI.
//   Sources de données :
//     1. file_metadata  (WS) — taille, routing, durée DB
//     2. file_channels  (WS) — analyse par canal (type, polyphonie, densité)
//     3. file_text_events (WS) — titre, copyright, paroles, marqueurs…
//     4. midiData (local) — statistiques calculées depuis les tracks brutes
//
// Sections collapsibles : clic sur l'en-tête pour plier/déplier.
// Section Paroles : vue texte (défaut) + toggle vue tableau.
// ============================================================================

(function () {
  'use strict';

  // ── Helpers ───────────────────────────────────────────────────────────── //

  function esc(s) {
    // Escape the full OWASP set including the apostrophe, matching the sibling
    // esc() in MidiEditorInfoModalRender.js — removes a single-quoted-attribute
    // foot-gun if any sink here moves to that context (audit D L1).
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ticksToSec(tick, ppq, tempoMap, defaultBpm = 120) {
    if (!ppq || ppq <= 0) return 0;
    if (!tempoMap || tempoMap.length === 0) {
      return (tick / ppq) * (60 / (defaultBpm || 120));
    }
    let elapsed = 0;
    let prevTick = 0;
    let prevBpm = 120; // MIDI default before first tempo event
    for (const pt of tempoMap) {
      if (pt.tick >= tick) break;
      elapsed += ((pt.tick - prevTick) / ppq) * (60 / prevBpm);
      prevTick = pt.tick;
      prevBpm = pt.bpm;
    }
    elapsed += ((tick - prevTick) / ppq) * (60 / prevBpm);
    return elapsed;
  }

  function fmtSec(sec) {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
  }

  /**
   * Strip KAR-format markers from a lyric token.
   * KAR embeds chord symbols as %chordName and uses < to separate
   * chord info from the lyric syllable: e.g. "%F%Gm<Hello world"
   *   → "Hello world"
   * Lines starting with @ are KAR metadata (title, artist) → "".
   * Tokens that are only chord markers (no <) → "".
   */
  function stripKarMarkers(text) {
    if (!text) return '';
    // Skip KAR metadata lines (@LENGL, @T title, etc.)
    if (text.startsWith('@')) return '';
    // If token contains <, the lyric syllable is everything after it
    if (text.includes('<')) {
      text = text.slice(text.indexOf('<') + 1);
    } else if (text.startsWith('%')) {
      // Pure chord marker — no lyric syllable
      return '';
    }
    // Strip any trailing/embedded %chord tokens
    return text.replace(/%[A-Za-z0-9#b+°øΔ/-]+/g, '').trim();
  }

  // ── Classe principale ─────────────────────────────────────────────────── //

  class MidiEditorInfoModal {
    constructor(modal) {
      this.modal = modal;
      // Sub-feature: HTML rendering (audit §1.3).
      this.render =
        typeof MidiEditorInfoModalRender !== 'undefined'
          ? new MidiEditorInfoModalRender(this)
          : null;
    }

    // ------------------------------------------------------------------ //
    // PUBLIC                                                              //
    // ------------------------------------------------------------------ //

    async show() {
      if (document.querySelector('.file-info-modal-overlay')) return;

      const overlay = document.createElement('div');
      overlay.className = 'file-info-modal-overlay';
      overlay.innerHTML = `
                <div class="file-info-modal">
                    <div class="file-info-modal-header">
                        <span class="file-info-modal-icon">📝</span>
                        <h3 class="file-info-modal-title">Informations du fichier</h3>
                        <button class="file-info-modal-close" title="Fermer">&times;</button>
                    </div>
                    <div class="file-info-modal-body">
                        <div class="file-info-loading">⏳ Chargement…</div>
                    </div>
                </div>`;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('visible'));

      const close = () => {
        document.removeEventListener('keydown', onKey);
        overlay.classList.remove('visible');
        setTimeout(() => {
          if (overlay.parentNode) overlay.remove();
        }, 200);
      };
      overlay.querySelector('.file-info-modal-close').addEventListener('click', close);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
      const onKey = (e) => {
        if (e.key === 'Escape') close();
      };
      document.addEventListener('keydown', onKey);

      try {
        const [textData, channelData, metaData] = await this._fetchAll();
        const localStats = this._computeLocalStats();
        const body = overlay.querySelector('.file-info-modal-body');
        body.innerHTML = this.render.renderBody(textData, channelData, metaData, localStats);
        this._attachInteractivity(body);
      } catch (err) {
        overlay.querySelector('.file-info-modal-body').innerHTML =
          `<p class="file-info-error">${this.modal.t('midiEditor.fileInfoLoadFailed', { error: esc(err.message) })}</p>`;
      }
    }

    // ------------------------------------------------------------------ //
    // DONNÉES — requêtes WS parallèles                                   //
    // ------------------------------------------------------------------ //

    async _fetchAll() {
      const id = this.modal.currentFile;
      if (!id) return [null, null, null];
      return Promise.all([
        this.modal.api.sendCommand('file_text_events', { fileId: id }).catch(() => null),
        this.modal.api.sendCommand('file_channels', { fileId: id }).catch(() => null),
        this.modal.api.sendCommand('file_metadata', { fileId: id }).catch(() => null)
      ]);
    }

    // ------------------------------------------------------------------ //
    // STATISTIQUES calculées localement depuis midiData.tracks           //
    // ------------------------------------------------------------------ //

    _computeLocalStats() {
      const tracks = this.modal.midiData?.tracks || [];
      const stats = {
        eventCounts: {},
        ccUsage: {},
        timeSigs: [],
        keySigs: [],
        progChanges: [],
        tempoMap: [], // [{tick, bpm}] for tick→time conversion
        sysexCount: 0,
        hasPitchBend: false,
        velMin: 127,
        velMax: 0,
        velSum: 0,
        velCount: 0,
        noteMin: 127,
        noteMax: 0,
        totalNotes: 0,
        polyMax: 0,
        tempoChanges: 0
      };

      let activeNotes = 0;

      for (const track of tracks) {
        let tick = 0;
        for (const ev of track.events || track || []) {
          tick += ev.deltaTime || 0;
          const t = ev.type;

          stats.eventCounts[t] = (stats.eventCounts[t] || 0) + 1;

          if (t === 'noteOn' && ev.velocity > 0) {
            stats.totalNotes++;
            stats.velSum += ev.velocity;
            stats.velCount++;
            if (ev.velocity < stats.velMin) stats.velMin = ev.velocity;
            if (ev.velocity > stats.velMax) stats.velMax = ev.velocity;
            if (ev.noteNumber < stats.noteMin) stats.noteMin = ev.noteNumber;
            if (ev.noteNumber > stats.noteMax) stats.noteMax = ev.noteNumber;
            activeNotes++;
            if (activeNotes > stats.polyMax) stats.polyMax = activeNotes;
          } else if (t === 'noteOff' || (t === 'noteOn' && ev.velocity === 0)) {
            if (activeNotes > 0) activeNotes--;
          } else if (t === 'controller') {
            const cc = ev.controllerType;
            if (!stats.ccUsage[cc]) stats.ccUsage[cc] = { count: 0, channels: new Set() };
            stats.ccUsage[cc].count++;
            stats.ccUsage[cc].channels.add(ev.channel + 1);
          } else if (t === 'pitchBend') {
            stats.hasPitchBend = true;
          } else if (t === 'sysEx' || t === 'endSysEx') {
            stats.sysexCount++;
          } else if (t === 'timeSignature') {
            stats.timeSigs.push({ tick, num: ev.numerator, den: ev.denominator });
          } else if (t === 'keySignature') {
            stats.keySigs.push({ tick, key: ev.key, scale: ev.scale });
          } else if (t === 'programChange') {
            stats.progChanges.push({
              tick,
              channel: (ev.channel ?? 0) + 1,
              program: ev.programNumber
            });
          } else if (t === 'setTempo') {
            stats.tempoChanges++;
            if (ev.microsecondsPerBeat) {
              stats.tempoMap.push({ tick, bpm: Math.round(60000000 / ev.microsecondsPerBeat) });
            }
          }
        }
      }

      // Sort tempo map by tick (may come from multiple tracks)
      stats.tempoMap.sort((a, b) => a.tick - b.tick);

      if (stats.velCount === 0) {
        stats.velMin = 0;
        stats.velMax = 0;
      }
      if (stats.noteMin > stats.noteMax) {
        stats.noteMin = 0;
        stats.noteMax = 0;
      }

      return stats;
    }

    // ------------------------------------------------------------------ //
    // RENDU HTML — corps du modal                                         //
    // ------------------------------------------------------------------ //

    _renderBody(textData, channelData, metaData, ls) {
      return this.render?.renderBody(textData, channelData, metaData, ls);
    }

    // ------------------------------------------------------------------ //
    // RENDU PAROLES                                                       //
    // ------------------------------------------------------------------ //

    /**
     * Regroupe les événements lyrics en couplets et lignes, puis génère
     * deux vues : texte formaté (défaut) et tableau détaillé (toggle).
     */
    _renderLyrics(lyrics, ppq, tempoMap, bpm) {
      const parsed = this._parseLyricsIntoVerses(lyrics, ppq);
      const lineCount = parsed.reduce((n, v) => n + v.lines.length, 0);
      const verseCount = parsed.length;

      // Texte brut pour le bouton Copier (sans annotations de temps)
      const plainText = parsed.map((v) => v.lines.map((l) => l.text).join('\n')).join('\n\n');

      // ── Vue texte ─────────────────────────────────────────────── //
      let textViewHtml = '<div class="fi-lyrics-display fi-lyrics-view-text">';
      parsed.forEach((verse, vi) => {
        textViewHtml += `<div class="fi-lyrics-verse">
                    <div class="fi-lyrics-verse-num">♩ Couplet ${vi + 1}</div>`;
        verse.lines.forEach((line) => {
          const sec = ticksToSec(line.tick, ppq, tempoMap, bpm);
          textViewHtml += `<div class="fi-lyrics-line">
                        <span class="fi-lyrics-time">${fmtSec(sec)}</span>
                        <span class="fi-lyrics-text">${esc(line.text)}</span>
                    </div>`;
        });
        textViewHtml += '</div>';
      });
      textViewHtml += '</div>';

      // ── Vue tableau ───────────────────────────────────────────── //
      const tableRows = lyrics
        .map((ev) => {
          const sec = ticksToSec(ev.tick, ppq, tempoMap, bpm);
          const raw = (ev.text || '').replace(/[\r\n]/g, '↵').replace(/[/\\]/g, '⏎');
          return `<tr>
                    <td class="fi-td-num">${fmtSec(sec)}</td>
                    <td class="fi-td-num fi-td-tick">${ev.tick}</td>
                    <td>${esc(raw)}</td>
                </tr>`;
        })
        .join('');

      const tableViewHtml = `
                <div class="fi-lyrics-display fi-lyrics-view-table" style="display:none">
                    <div class="fi-scroll-x">
                    <table class="file-info-table">
                        <thead><tr><th>Temps</th><th>Tick</th><th>Syllabe brute</th></tr></thead>
                        <tbody>${tableRows}</tbody>
                    </table>
                    </div>
                </div>`;

      return `
                <div class="fi-lyrics-toolbar">
                    <button class="fi-btn fi-lyrics-copy"
                            data-text="${esc(plainText)}"
                            title="Copier les paroles en texte brut">📋 Copier</button>
                    <button class="fi-btn fi-lyrics-toggle-view" title="Basculer entre vue texte et tableau">
                        ≡ Tableau
                    </button>
                    <span class="fi-lyrics-stats">${lineCount} ligne${lineCount > 1 ? 's' : ''} · ${verseCount} couplet${verseCount > 1 ? 's' : ''}</span>
                </div>
                ${textViewHtml}
                ${tableViewHtml}
            `;
    }

    /**
     * Regroupe les événements lyrics bruts en couplets et lignes lisibles.
     *
     * Convention MIDI karaoke (KAR) :
     *   \r en début/fin de token → saut de ligne (même couplet)
     *   \n, / ou \ en début/fin  → saut de couplet
     *   Long silence (> 8 temps) → saut de couplet
     *   Silence moyen (> 2 temps) → saut de ligne
     */
    _parseLyricsIntoVerses(lyrics, ppq) {
      if (!lyrics || lyrics.length === 0) return [];

      const LINE_GAP = ppq * 2; // 2 temps = nouvelle ligne
      const VERSE_GAP = ppq * 8; // 8 temps = nouveau couplet

      const verses = [];
      let curVerse = [];
      let curLine = { tokens: [], tick: lyrics[0].tick };
      let prevTick = -1;

      const flushLine = () => {
        const text = curLine.tokens.join('').trim();
        if (text) curVerse.push({ text, tick: curLine.tick });
        curLine = { tokens: [], tick: -1 };
      };

      const flushVerse = () => {
        flushLine();
        if (curVerse.length) verses.push({ lines: curVerse });
        curVerse = [];
      };

      for (const ev of lyrics) {
        let text = ev.text || '';
        const gap = prevTick >= 0 ? ev.tick - prevTick : 0;

        // Détecter les marqueurs de rupture dans le texte
        const verseBreakChar = /^[\n/\\]|[\n/\\]$/.test(text);
        const lineBreakChar = /^\r|\r$/.test(text);

        // Nettoyer : ruptures de ligne + caractères de contrôle + marqueurs KAR (%chord<)
        const clean = stripKarMarkers(text.replace(/[\r\n/\\]/g, '').replace(/[\x00-\x1f]/g, ''));

        // Priorité : grande pause → couplet ; pause moyenne → ligne
        if (gap > VERSE_GAP || verseBreakChar) {
          flushVerse();
        } else if (gap > LINE_GAP || lineBreakChar) {
          flushLine();
        }

        if (curLine.tick < 0) curLine.tick = ev.tick;

        // Ajouter la syllabe (sans espace forcé — la syllabe peut déjà en contenir)
        if (clean) curLine.tokens.push(clean);

        prevTick = ev.tick;
      }

      flushVerse();
      return verses;
    }

    // ------------------------------------------------------------------ //
    // INTERACTIVITÉ (wired après rendu HTML)                              //
    // ------------------------------------------------------------------ //

    _attachInteractivity(bodyEl) {
      // 1. Sections collapsibles
      bodyEl.querySelectorAll('.file-info-section.fi-collapsible').forEach((section) => {
        const titleEl = section.querySelector('.file-info-section-title');
        titleEl.addEventListener('click', () => {
          section.classList.toggle('collapsed');
        });
      });

      // 2. Copier les paroles
      bodyEl.querySelectorAll('.fi-lyrics-copy').forEach((btn) => {
        btn.addEventListener('click', () => {
          const text = btn.dataset.text || '';
          navigator.clipboard
            .writeText(text)
            .then(() => {
              const orig = btn.textContent;
              btn.textContent = '✓ Copié !';
              btn.disabled = true;
              setTimeout(() => {
                btn.textContent = orig;
                btn.disabled = false;
              }, 1800);
            })
            .catch(() => {
              // Fallback pour navigateurs sans clipboard API
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.cssText = 'position:fixed;opacity:0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
              btn.textContent = '✓ Copié !';
              btn.disabled = true;
              setTimeout(() => {
                btn.textContent = '📋 Copier';
                btn.disabled = false;
              }, 1800);
            });
        });
      });

      // 3. Basculer vue texte ↔ tableau
      bodyEl.querySelectorAll('.fi-lyrics-toggle-view').forEach((btn) => {
        btn.addEventListener('click', () => {
          const section = btn.closest('.file-info-section-body');
          const textView = section.querySelector('.fi-lyrics-view-text');
          const tableView = section.querySelector('.fi-lyrics-view-table');
          if (!textView || !tableView) return;

          const showingText = textView.style.display !== 'none';
          textView.style.display = showingText ? 'none' : '';
          tableView.style.display = showingText ? '' : 'none';
          btn.textContent = showingText ? '¶ Texte' : '≡ Tableau';
          btn.title = showingText
            ? 'Revenir à la vue texte'
            : 'Voir les syllabes brutes avec ticks';
        });
      });
    }

    // ------------------------------------------------------------------ //
    // HELPERS                                                             //
    // ------------------------------------------------------------------ //

    _mergeChannels(uiChannels, dbChannels) {
      const byChannel = {};
      for (const ch of uiChannels) byChannel[ch.channel] = { ...ch };
      for (const ch of dbChannels) {
        const c = ch.channel;
        byChannel[c] = { ...(byChannel[c] || {}), ...ch };
      }
      return Object.values(byChannel).sort((a, b) => a.channel - b.channel);
    }

    // Delegates to render sub-feature (extracted per audit §1.3)
    _section(title, content, opts) {
      return this.render?.section(title, content, opts);
    }
    _row(label, value) {
      return this.render?.row(label, value);
    }
    _rowHighlight(label, value) {
      return this.render?.rowHighlight(label, value);
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorInfoModal = MidiEditorInfoModal;
  }
})();
