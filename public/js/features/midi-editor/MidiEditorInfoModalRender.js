// ============================================================================
// File: public/js/features/midi-editor/MidiEditorInfoModalRender.js
// Description: HTML rendering layer for MidiEditorInfoModal — extracted
//   per audit §1.3 (god-class split).
//
// Owns:
//   - `renderBody(textData, channelData, metaData, ls)` — assembles the
//     6+ collapsible sections (file metadata, lyrics, channels, CC,
//     time/key signatures, program changes, other meta events).
//   - `section()` / `row()` / `rowHighlight()` — small HTML primitives
//     used throughout the section assembly.
//
// File-scoped helpers (esc, fmt, fmtSize, fmtDuration, midiNote, CC_NAMES,
// TYPE_LABELS, ROUTING_LABELS) are duplicated here because the IIFE
// boundary makes them invisible to the main MidiEditorInfoModal closure
// and they have no state. Lyrics rendering / channel merging stays on
// the parent and is reached via `this.parent._renderLyrics` /
// `this.parent._mergeChannels`.
//
// Accessed via `modal.infoModal.render`. MidiEditorInfoModal keeps thin
// delegates so external callers (`modal.infoModal.show()`) are unchanged.
// ============================================================================

(function () {
  'use strict';

  // ── Constantes de décodage MIDI ──────────────────────────────────────── //

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const CC_NAMES = {
    0: 'Bank Select',
    1: 'Modulation',
    2: 'Breath',
    4: 'Foot Ctrl',
    5: 'Portamento Time',
    6: 'Data Entry',
    7: 'Volume',
    8: 'Balance',
    10: 'Pan',
    11: 'Expression',
    12: 'Effect 1',
    13: 'Effect 2',
    64: 'Sustain',
    65: 'Portamento',
    66: 'Sostenuto',
    67: 'Soft Pedal',
    68: 'Legato',
    70: 'Sound Variation',
    71: 'Résonance',
    72: 'Release',
    73: 'Attack',
    74: 'Cutoff',
    75: 'Decay',
    76: 'Vibrato Rate',
    77: 'Vibrato Depth',
    78: 'Vibrato Delay',
    84: 'Portamento Ctrl',
    91: 'Reverb',
    92: 'Tremolo',
    93: 'Chorus',
    94: 'Detune',
    95: 'Phaser',
    120: 'All Sound Off',
    121: 'Reset Ctrl',
    123: 'All Notes Off'
  };

  const TYPE_LABELS = {
    drums: 'Percussions',
    bass: 'Basse',
    melody: 'Mélodie',
    harmony: 'Harmonie',
    percussive: 'Percussif'
  };

  const ROUTING_LABELS = {
    unrouted: 'Non routé',
    partial: 'Partiel',
    playable: 'Prêt',
    routed_incomplete: 'Incomplet',
    auto_assigned: 'Auto-assigné'
  };

  // ── Helpers ───────────────────────────────────────────────────────────── //

  function midiNote(n) {
    if (n == null) return '—';
    return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1) + ` (${n})`;
  }

  function esc(s) {
    // Escape the full OWASP set including the apostrophe: omitting `'` left a
    // single-quoted-attribute foot-gun if any sink here ever moves to that
    // context (audit C low). Matches window.escapeHtml.
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmt(v, fb = '—') {
    return v !== null && v !== undefined && String(v).trim() !== '' ? v : fb;
  }

  function fmtSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtDuration(sec) {
    if (!sec || sec <= 0) return '—';
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${m}:${s}`;
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

  class MidiEditorInfoModalRender {
    /** @param {MidiEditorInfoModal} parent */
    constructor(parent) {
      this.parent = parent;
      this.modal = parent.modal;
    }

    renderBody(textData, channelData, metaData, ls) {
      const m = this.modal;
      const hdr = m.midiData?.header || {};
      const meta = metaData?.metadata || {};

      const title = textData?.title || null;
      const copyright = textData?.copyright || null;
      const lyrics = textData?.grouped?.lyrics || [];
      const hasLyrics = lyrics.length > 0;

      const ppq = hdr.ticksPerBeat ?? meta.ppq ?? 480;

      let html = '';

      // ── 🗂 Fichier ───────────────────────────────────────────────── //
      const routingLabel = ROUTING_LABELS[meta.routingStatus] || meta.routingStatus || '—';
      const adaptedLabel = meta.isAdapted ? 'Oui' : meta.isAdapted === false ? 'Non' : '—';
      const karaokeBadge = hasLyrics
        ? `<span class="fi-karaoke-badge" title="${lyrics.length} événements de paroles">🎤 Karaoké</span>`
        : '';
      html += this.section(
        `🗂 Fichier ${karaokeBadge}`,
        `${title ? this.rowHighlight('Titre', esc(title)) : ''}
                ${copyright ? this.row('Copyright', esc(copyright)) : ''}
                ${this.row('Nom du fichier', esc(m.currentFilename || m.currentFile))}
                ${this.row('Taille', fmtSize(meta.size))}
                ${this.row('Format MIDI', hdr.format !== undefined ? `Type ${hdr.format}` : '—')}
                ${this.row('Pistes SMF', fmt(hdr.numTracks ?? meta.tracks))}
                ${this.row('Durée', fmtDuration(meta.duration))}
                ${this.row('Tempo initial', m.tempo ? `${Math.round(m.tempo)} BPM` : '—')}
                ${this.row('Changements tempo', ls.tempoChanges > 1 ? `${ls.tempoChanges} changements` : ls.tempoChanges === 1 ? 'Fixe' : '—')}
                ${this.row('PPQ', fmt(hdr.ticksPerBeat ?? meta.ppq))}
                ${this.row('Statut routing', routingLabel)}
                ${this.row('Adapté', adaptedLabel)}`,
        { collapsed: false }
      );

      // ── 🎤 Paroles ────────────────────────────────────────────────── //
      if (hasLyrics) {
        html += this.section(
          '🎤 Paroles',
          this.parent._renderLyrics(lyrics, ppq, ls.tempoMap, m.tempo),
          { collapsed: false, badge: `${lyrics.length} tokens` }
        );
      }

      // ── 📍 Marqueurs ──────────────────────────────────────────────── //
      const markers = textData?.grouped?.marker || [];
      if (markers.length > 0) {
        const rows = markers
          .map((e) => {
            const sec = ticksToSec(e.tick, ppq, ls.tempoMap, m.tempo);
            return `<tr>
                        <td class="fi-td-num">${fmtSec(sec)}</td>
                        <td class="fi-td-num fi-td-tick">${e.tick}</td>
                        <td>${esc(e.text)}</td>
                    </tr>`;
          })
          .join('');
        html += this.section(
          '📍 Marqueurs',
          `
                    <table class="file-info-table">
                        <thead><tr><th>Temps</th><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `,
          { collapsed: false, badge: markers.length }
        );
      }

      // ── 🎹 Canaux ────────────────────────────────────────────────── //
      const dbChannels = channelData?.channels || [];
      const uiChannels = m.channels || [];

      if (uiChannels.length > 0 || dbChannels.length > 0) {
        const merged = this.parent._mergeChannels(uiChannels, dbChannels);
        const rows = merged
          .map((ch) => {
            const instName =
              m.getInstrumentName?.(ch.program) || ch.instrument || `Prog. ${ch.program ?? '?'}`;
            const isDrum = ch.channel === 9;
            const typeRaw = ch.estimated_type;
            const typeStr = typeRaw ? TYPE_LABELS[typeRaw] || typeRaw : '—';
            const conf =
              ch.type_confidence != null
                ? `<span class="fi-conf">${ch.type_confidence}%</span>`
                : '';
            const range =
              ch.note_range_min != null && ch.note_range_max != null
                ? `${NOTE_NAMES[ch.note_range_min % 12]}${Math.floor(ch.note_range_min / 12 - 1)}–${NOTE_NAMES[ch.note_range_max % 12]}${Math.floor(ch.note_range_max / 12 - 1)}`
                : '—';
            const poly = ch.polyphony_max > 0 ? ch.polyphony_max : '—';
            const dens = ch.density != null ? ch.density.toFixed(2) : '—';
            return `<tr>
                        <td class="fi-td-num">CH${ch.channel + 1}${isDrum ? '🥁' : ''}</td>
                        <td>${esc(instName)}</td>
                        <td>${esc(ch.gm_category || '—')}</td>
                        <td>${typeStr}${conf}</td>
                        <td class="fi-td-num">${range}</td>
                        <td class="fi-td-num">${fmt(ch.total_notes ?? ch.noteCount)}</td>
                        <td class="fi-td-num">${poly}</td>
                        <td class="fi-td-num">${dens}</td>
                    </tr>`;
          })
          .join('');
        html += this.section(
          '🎹 Canaux',
          `
                    <div class="fi-scroll-x">
                    <table class="file-info-table">
                        <thead><tr>
                            <th>Canal</th><th>Instrument</th><th>Catégorie</th>
                            <th>Type estimé</th><th>Plage</th>
                            <th>Notes</th><th>Poly.</th><th>Densité</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    </div>
                `,
          { collapsed: false, badge: merged.length }
        );
      }

      // ── 📊 Statistiques — collapsé par défaut ───────────────────── //
      const velAvg = ls.velCount > 0 ? Math.round(ls.velSum / ls.velCount) : 0;
      html += this.section(
        '📊 Statistiques',
        `
                ${this.row('Notes totales', fmt(ls.totalNotes || meta.noteCount))}
                ${this.row('Note la plus basse', midiNote(ls.noteMin > ls.noteMax ? null : ls.noteMin))}
                ${this.row('Note la plus haute', midiNote(ls.noteMin > ls.noteMax ? null : ls.noteMax))}
                ${this.row('Polyphonie max', ls.polyMax > 0 ? `${ls.polyMax} voix simultanées` : '—')}
                ${this.row(
                  'Vélocité min / moy / max',
                  ls.velCount > 0 ? `${ls.velMin} / ${velAvg} / ${ls.velMax}` : '—'
                )}
                ${this.row('Pitch Bend', ls.hasPitchBend ? 'Oui' : 'Non')}
                ${this.row('Messages SysEx', ls.sysexCount > 0 ? ls.sysexCount : 'Aucun')}
                ${this.row('Canaux actifs', fmt(meta.channelCount))}
            `,
        { collapsed: true }
      );

      // ── 🎛 Contrôleurs CC — collapsé par défaut ──────────────────── //
      const ccEntries = Object.entries(ls.ccUsage).sort((a, b) => b[1].count - a[1].count);
      if (ccEntries.length > 0) {
        const rows = ccEntries
          .map(([cc, info]) => {
            const name = CC_NAMES[cc] || `CC${cc}`;
            const chans = Array.from(info.channels)
              .sort((a, b) => a - b)
              .join(', ');
            return `<tr>
                        <td class="fi-td-num">CC${cc}</td>
                        <td>${esc(name)}</td>
                        <td class="fi-td-num">${info.count}</td>
                        <td class="fi-td-num">${chans}</td>
                    </tr>`;
          })
          .join('');
        html += this.section(
          '🎛 Contrôleurs (CC)',
          `
                    <table class="file-info-table">
                        <thead><tr><th>#</th><th>Nom</th><th>Événements</th><th>Canaux</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `,
          { collapsed: true, badge: ccEntries.length }
        );
      }

      // ── 🎼 Signatures + Changements programme — collapsé par défaut ─ //
      if (ls.timeSigs.length > 0 || ls.keySigs.length > 0) {
        const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        let sigHtml = '<div class="fi-sig-cols">';
        if (ls.timeSigs.length > 0) {
          const rows = ls.timeSigs
            .map((s) => `<tr><td class="fi-td-num">${s.tick}</td><td>${s.num}/${s.den}</td></tr>`)
            .join('');
          sigHtml += `<div class="fi-sig-group"><strong>Mesure</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Signature</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
        }
        if (ls.keySigs.length > 0) {
          const rows = ls.keySigs
            .map((s) => {
              const ni = ((s.key % 12) + 12) % 12;
              const ton = KEY_NAMES[ni] + (s.scale === 0 ? ' Maj' : ' min');
              const acc = s.key > 0 ? `${s.key}#` : s.key < 0 ? `${Math.abs(s.key)}♭` : '';
              return `<tr><td class="fi-td-num">${s.tick}</td><td>${ton}</td><td class="fi-td-num">${acc}</td></tr>`;
            })
            .join('');
          sigHtml += `<div class="fi-sig-group"><strong>Tonalité</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Tonalité</th><th>Armure</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
        }
        sigHtml += '</div>';
        html += this.section('🎼 Signatures', sigHtml, { collapsed: true });
      }

      if (ls.progChanges.length > 0) {
        const rows = ls.progChanges
          .map((p) => {
            const name = m.getInstrumentName?.(p.program) || `Prog. ${p.program}`;
            return `<tr>
                        <td class="fi-td-num">${p.tick}</td>
                        <td class="fi-td-num">CH${p.channel}</td>
                        <td>${esc(name)}</td>
                        <td class="fi-td-num">${p.program}</td>
                    </tr>`;
          })
          .join('');
        html += this.section(
          '🔄 Changements de programme',
          `
                    <table class="file-info-table">
                        <thead><tr><th>Tick</th><th>Canal</th><th>Instrument</th><th>Prog#</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `,
          { collapsed: true, badge: ls.progChanges.length }
        );
      }

      // ── 📄 Autres textes ──────────────────────────────────────────── //
      const otherTypes = ['text', 'instrumentName', 'cuePoint', 'programName', 'deviceName'];
      const others = (textData?.events || []).filter((e) => otherTypes.includes(e.event_type));
      if (others.length > 0) {
        const rows = others
          .map(
            (e) =>
              `<tr><td class="fi-td-tag">${esc(e.event_type)}</td><td class="fi-td-num">${e.tick}</td><td>${esc(e.text)}</td></tr>`
          )
          .join('');
        html += this.section(
          '📄 Autres textes',
          `
                    <table class="file-info-table">
                        <thead><tr><th>Type</th><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `,
          { collapsed: false, badge: others.length }
        );
      }

      return (
        html || `<p class="file-info-empty">${this.modal.t('midiEditor.fileInfoNoMetadata')}</p>`
      );
    }

    section(title, content, opts = {}) {
      const { collapsed = false, badge = null } = opts;
      const colClass = collapsed ? 'fi-collapsible collapsed' : 'fi-collapsible';
      const badgeHtml = badge != null ? `<span class="fi-section-badge">${badge}</span>` : '';
      return `<div class="file-info-section ${colClass}">
                <div class="file-info-section-title">
                    <span class="fi-section-chevron">▶</span>
                    <span class="fi-section-label">${title}</span>
                    ${badgeHtml}
                </div>
                <div class="file-info-section-body">${content}</div>
            </div>`;
    }

    row(label, value) {
      return `<div class="file-info-row">
                <span class="fi-label">${label}</span>
                <span class="fi-value">${value}</span>
            </div>`;
    }

    rowHighlight(label, value) {
      return `<div class="file-info-row fi-row-highlight">
                <span class="fi-label">${label}</span>
                <span class="fi-value fi-value-highlight">${value}</span>
            </div>`;
    }
  }

  if (typeof window !== 'undefined') {
    window.MidiEditorInfoModalRender = MidiEditorInfoModalRender;
  }
})();
