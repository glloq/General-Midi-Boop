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

    // ── Constantes de décodage MIDI ──────────────────────────────────────── //

    const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    const CC_NAMES = {
        0:'Bank Select', 1:'Modulation', 2:'Breath', 4:'Foot Ctrl',
        5:'Portamento Time', 6:'Data Entry', 7:'Volume', 8:'Balance',
        10:'Pan', 11:'Expression', 12:'Effect 1', 13:'Effect 2',
        64:'Sustain', 65:'Portamento', 66:'Sostenuto', 67:'Soft Pedal',
        68:'Legato', 70:'Sound Variation', 71:'Résonance', 72:'Release',
        73:'Attack', 74:'Cutoff', 75:'Decay', 76:'Vibrato Rate',
        77:'Vibrato Depth', 78:'Vibrato Delay', 84:'Portamento Ctrl',
        91:'Reverb', 92:'Tremolo', 93:'Chorus', 94:'Detune', 95:'Phaser',
        120:'All Sound Off', 121:'Reset Ctrl', 123:'All Notes Off'
    };

    const TYPE_LABELS = {
        drums:'Percussions', bass:'Basse', melody:'Mélodie',
        harmony:'Harmonie', percussive:'Percussif'
    };

    const ROUTING_LABELS = {
        unrouted:'Non routé', partial:'Partiel',
        playable:'Prêt', routed_incomplete:'Incomplet', auto_assigned:'Auto-assigné'
    };

    // ── Helpers ───────────────────────────────────────────────────────────── //

    function midiNote(n) {
        if (n == null) return '—';
        return NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1) + ` (${n})`;
    }

    function esc(s) {
        return String(s ?? '')
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;');
    }

    function fmt(v, fb = '—') {
        return (v !== null && v !== undefined && String(v).trim() !== '') ? v : fb;
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
                setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 200);
            };
            overlay.querySelector('.file-info-modal-close').addEventListener('click', close);
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            const onKey = e => { if (e.key === 'Escape') close(); };
            document.addEventListener('keydown', onKey);

            try {
                const [textData, channelData, metaData] = await this._fetchAll();
                const localStats = this._computeLocalStats();
                const body = overlay.querySelector('.file-info-modal-body');
                body.innerHTML = this._renderBody(textData, channelData, metaData, localStats);
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
                this.modal.api.sendCommand('file_channels',    { fileId: id }).catch(() => null),
                this.modal.api.sendCommand('file_metadata',    { fileId: id }).catch(() => null)
            ]);
        }

        // ------------------------------------------------------------------ //
        // STATISTIQUES calculées localement depuis midiData.tracks           //
        // ------------------------------------------------------------------ //

        _computeLocalStats() {
            const tracks = this.modal.midiData?.tracks || [];
            const stats = {
                eventCounts: {},
                ccUsage:     {},
                timeSigs:    [],
                keySigs:     [],
                progChanges: [],
                tempoMap:    [],   // [{tick, bpm}] for tick→time conversion
                sysexCount:  0,
                hasPitchBend:false,
                velMin: 127, velMax: 0, velSum: 0, velCount: 0,
                noteMin: 127, noteMax: 0,
                totalNotes: 0,
                polyMax: 0,
                tempoChanges: 0
            };

            let activeNotes = 0;

            for (const track of tracks) {
                let tick = 0;
                for (const ev of (track.events || track || [])) {
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
                        stats.progChanges.push({ tick, channel: (ev.channel ?? 0) + 1, program: ev.programNumber });
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

            if (stats.velCount === 0) { stats.velMin = 0; stats.velMax = 0; }
            if (stats.noteMin > stats.noteMax) { stats.noteMin = 0; stats.noteMax = 0; }

            return stats;
        }

        // ------------------------------------------------------------------ //
        // RENDU HTML — corps du modal                                         //
        // ------------------------------------------------------------------ //

        _renderBody(textData, channelData, metaData, ls) {
            const m   = this.modal;
            const hdr = m.midiData?.header || {};
            const meta = metaData?.metadata || {};

            const title     = textData?.title     || null;
            const copyright = textData?.copyright || null;
            const lyrics    = textData?.grouped?.lyrics || [];
            const hasLyrics = lyrics.length > 0;

            const ppq = hdr.ticksPerBeat ?? meta.ppq ?? 480;

            let html = '';

            // ── 🗂 Fichier ───────────────────────────────────────────────── //
            const routingLabel = ROUTING_LABELS[meta.routingStatus] || meta.routingStatus || '—';
            const adaptedLabel = meta.isAdapted ? 'Oui' : (meta.isAdapted === false ? 'Non' : '—');
            const karaokeBadge = hasLyrics
                ? `<span class="fi-karaoke-badge" title="${lyrics.length} événements de paroles">🎤 Karaoké</span>`
                : '';
            html += this._section(
                `🗂 Fichier ${karaokeBadge}`,
                `${title ? this._rowHighlight('Titre', esc(title)) : ''}
                ${copyright ? this._row('Copyright', esc(copyright)) : ''}
                ${this._row('Nom du fichier', esc(m.currentFilename || m.currentFile))}
                ${this._row('Taille', fmtSize(meta.size))}
                ${this._row('Format MIDI', hdr.format !== undefined ? `Type ${hdr.format}` : '—')}
                ${this._row('Pistes SMF', fmt(hdr.numTracks ?? meta.tracks))}
                ${this._row('Durée', fmtDuration(meta.duration))}
                ${this._row('Tempo initial', m.tempo ? `${Math.round(m.tempo)} BPM` : '—')}
                ${this._row('Changements tempo', ls.tempoChanges > 1 ? `${ls.tempoChanges} changements` : (ls.tempoChanges === 1 ? 'Fixe' : '—'))}
                ${this._row('PPQ', fmt(hdr.ticksPerBeat ?? meta.ppq))}
                ${this._row('Statut routing', routingLabel)}
                ${this._row('Adapté', adaptedLabel)}`,
                { collapsed: false }
            );

            // ── 🎤 Paroles ────────────────────────────────────────────────── //
            if (hasLyrics) {
                html += this._section(
                    '🎤 Paroles',
                    this._renderLyrics(lyrics, ppq, ls.tempoMap, m.tempo),
                    { collapsed: false, badge: `${lyrics.length} tokens` }
                );
            }

            // ── 📍 Marqueurs ──────────────────────────────────────────────── //
            const markers = textData?.grouped?.marker || [];
            if (markers.length > 0) {
                const rows = markers.map(e => {
                    const sec = ticksToSec(e.tick, ppq, ls.tempoMap, m.tempo);
                    return `<tr>
                        <td class="fi-td-num">${fmtSec(sec)}</td>
                        <td class="fi-td-num fi-td-tick">${e.tick}</td>
                        <td>${esc(e.text)}</td>
                    </tr>`;
                }).join('');
                html += this._section('📍 Marqueurs', `
                    <table class="file-info-table">
                        <thead><tr><th>Temps</th><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `, { collapsed: false, badge: markers.length });
            }

            // ── 🎹 Canaux ────────────────────────────────────────────────── //
            const dbChannels = channelData?.channels || [];
            const uiChannels = m.channels || [];

            if (uiChannels.length > 0 || dbChannels.length > 0) {
                const merged = this._mergeChannels(uiChannels, dbChannels);
                const rows = merged.map(ch => {
                    const instName = m.getInstrumentName?.(ch.program) || ch.instrument || `Prog. ${ch.program ?? '?'}`;
                    const isDrum   = ch.channel === 9;
                    const typeRaw  = ch.estimated_type;
                    const typeStr  = typeRaw ? (TYPE_LABELS[typeRaw] || typeRaw) : '—';
                    const conf     = ch.type_confidence != null ? `<span class="fi-conf">${ch.type_confidence}%</span>` : '';
                    const range    = (ch.note_range_min != null && ch.note_range_max != null)
                        ? `${NOTE_NAMES[ch.note_range_min % 12]}${Math.floor(ch.note_range_min/12-1)}–${NOTE_NAMES[ch.note_range_max % 12]}${Math.floor(ch.note_range_max/12-1)}`
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
                }).join('');
                html += this._section('🎹 Canaux', `
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
                `, { collapsed: false, badge: merged.length });
            }

            // ── 📊 Statistiques — collapsé par défaut ───────────────────── //
            const velAvg = ls.velCount > 0 ? Math.round(ls.velSum / ls.velCount) : 0;
            html += this._section('📊 Statistiques', `
                ${this._row('Notes totales',  fmt(ls.totalNotes || meta.noteCount))}
                ${this._row('Note la plus basse', midiNote(ls.noteMin > ls.noteMax ? null : ls.noteMin))}
                ${this._row('Note la plus haute', midiNote(ls.noteMin > ls.noteMax ? null : ls.noteMax))}
                ${this._row('Polyphonie max', ls.polyMax > 0 ? `${ls.polyMax} voix simultanées` : '—')}
                ${this._row('Vélocité min / moy / max',
                    ls.velCount > 0 ? `${ls.velMin} / ${velAvg} / ${ls.velMax}` : '—')}
                ${this._row('Pitch Bend',     ls.hasPitchBend ? 'Oui' : 'Non')}
                ${this._row('Messages SysEx', ls.sysexCount > 0 ? ls.sysexCount : 'Aucun')}
                ${this._row('Canaux actifs',  fmt(meta.channelCount))}
            `, { collapsed: true });

            // ── 🎛 Contrôleurs CC — collapsé par défaut ──────────────────── //
            const ccEntries = Object.entries(ls.ccUsage)
                .sort((a, b) => b[1].count - a[1].count);
            if (ccEntries.length > 0) {
                const rows = ccEntries.map(([cc, info]) => {
                    const name = CC_NAMES[cc] || `CC${cc}`;
                    const chans = Array.from(info.channels).sort((a,b)=>a-b).join(', ');
                    return `<tr>
                        <td class="fi-td-num">CC${cc}</td>
                        <td>${esc(name)}</td>
                        <td class="fi-td-num">${info.count}</td>
                        <td class="fi-td-num">${chans}</td>
                    </tr>`;
                }).join('');
                html += this._section('🎛 Contrôleurs (CC)', `
                    <table class="file-info-table">
                        <thead><tr><th>#</th><th>Nom</th><th>Événements</th><th>Canaux</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `, { collapsed: true, badge: ccEntries.length });
            }

            // ── 🎼 Signatures + Changements programme — collapsé par défaut ─ //
            if (ls.timeSigs.length > 0 || ls.keySigs.length > 0) {
                const KEY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
                let sigHtml = '<div class="fi-sig-cols">';
                if (ls.timeSigs.length > 0) {
                    const rows = ls.timeSigs.map(s =>
                        `<tr><td class="fi-td-num">${s.tick}</td><td>${s.num}/${s.den}</td></tr>`
                    ).join('');
                    sigHtml += `<div class="fi-sig-group"><strong>Mesure</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Signature</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
                }
                if (ls.keySigs.length > 0) {
                    const rows = ls.keySigs.map(s => {
                        const ni = ((s.key % 12) + 12) % 12;
                        const ton = KEY_NAMES[ni] + (s.scale === 0 ? ' Maj' : ' min');
                        const acc = s.key > 0 ? `${s.key}#` : s.key < 0 ? `${Math.abs(s.key)}♭` : '';
                        return `<tr><td class="fi-td-num">${s.tick}</td><td>${ton}</td><td class="fi-td-num">${acc}</td></tr>`;
                    }).join('');
                    sigHtml += `<div class="fi-sig-group"><strong>Tonalité</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Tonalité</th><th>Armure</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
                }
                sigHtml += '</div>';
                html += this._section('🎼 Signatures', sigHtml, { collapsed: true });
            }

            if (ls.progChanges.length > 0) {
                const rows = ls.progChanges.map(p => {
                    const name = m.getInstrumentName?.(p.program) || `Prog. ${p.program}`;
                    return `<tr>
                        <td class="fi-td-num">${p.tick}</td>
                        <td class="fi-td-num">CH${p.channel}</td>
                        <td>${esc(name)}</td>
                        <td class="fi-td-num">${p.program}</td>
                    </tr>`;
                }).join('');
                html += this._section('🔄 Changements de programme', `
                    <table class="file-info-table">
                        <thead><tr><th>Tick</th><th>Canal</th><th>Instrument</th><th>Prog#</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `, { collapsed: true, badge: ls.progChanges.length });
            }

            // ── 📄 Autres textes ──────────────────────────────────────────── //
            const otherTypes = ['text', 'instrumentName', 'cuePoint', 'programName', 'deviceName'];
            const others = (textData?.events || []).filter(e => otherTypes.includes(e.event_type));
            if (others.length > 0) {
                const rows = others.map(e =>
                    `<tr><td class="fi-td-tag">${esc(e.event_type)}</td><td class="fi-td-num">${e.tick}</td><td>${esc(e.text)}</td></tr>`
                ).join('');
                html += this._section('📄 Autres textes', `
                    <table class="file-info-table">
                        <thead><tr><th>Type</th><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `, { collapsed: false, badge: others.length });
            }

            return html || `<p class="file-info-empty">${this.modal.t('midiEditor.fileInfoNoMetadata')}</p>`;
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
            const lineCount  = parsed.reduce((n, v) => n + v.lines.length, 0);
            const verseCount = parsed.length;

            // Texte brut pour le bouton Copier (sans annotations de temps)
            const plainText = parsed
                .map(v => v.lines.map(l => l.text).join('\n'))
                .join('\n\n');

            // ── Vue texte ─────────────────────────────────────────────── //
            let textViewHtml = '<div class="fi-lyrics-display fi-lyrics-view-text">';
            parsed.forEach((verse, vi) => {
                textViewHtml += `<div class="fi-lyrics-verse">
                    <div class="fi-lyrics-verse-num">♩ Couplet ${vi + 1}</div>`;
                verse.lines.forEach(line => {
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
            const tableRows = lyrics.map(ev => {
                const sec = ticksToSec(ev.tick, ppq, tempoMap, bpm);
                const raw = (ev.text || '').replace(/[\r\n]/g, '↵').replace(/[\/\\]/g, '⏎');
                return `<tr>
                    <td class="fi-td-num">${fmtSec(sec)}</td>
                    <td class="fi-td-num fi-td-tick">${ev.tick}</td>
                    <td>${esc(raw)}</td>
                </tr>`;
            }).join('');

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

            const LINE_GAP  = ppq * 2;   // 2 temps = nouvelle ligne
            const VERSE_GAP = ppq * 8;   // 8 temps = nouveau couplet

            const verses = [];
            let curVerse = [];
            let curLine  = { tokens: [], tick: lyrics[0].tick };
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
                const verseBreakChar = /^[\n\/\\]|[\n\/\\]$/.test(text);
                const lineBreakChar  = /^\r|\r$/.test(text);

                // Nettoyer : ruptures de ligne + caractères de contrôle + marqueurs KAR (%chord<)
                const clean = stripKarMarkers(
                    text.replace(/[\r\n\/\\]/g, '').replace(/[\x00-\x1f]/g, '')
                );

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
            bodyEl.querySelectorAll('.file-info-section.fi-collapsible').forEach(section => {
                const titleEl = section.querySelector('.file-info-section-title');
                titleEl.addEventListener('click', () => {
                    section.classList.toggle('collapsed');
                });
            });

            // 2. Copier les paroles
            bodyEl.querySelectorAll('.fi-lyrics-copy').forEach(btn => {
                btn.addEventListener('click', () => {
                    const text = btn.dataset.text || '';
                    navigator.clipboard.writeText(text).then(() => {
                        const orig = btn.textContent;
                        btn.textContent = '✓ Copié !';
                        btn.disabled = true;
                        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
                    }).catch(() => {
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
                        setTimeout(() => { btn.textContent = '📋 Copier'; btn.disabled = false; }, 1800);
                    });
                });
            });

            // 3. Basculer vue texte ↔ tableau
            bodyEl.querySelectorAll('.fi-lyrics-toggle-view').forEach(btn => {
                btn.addEventListener('click', () => {
                    const section = btn.closest('.file-info-section-body');
                    const textView  = section.querySelector('.fi-lyrics-view-text');
                    const tableView = section.querySelector('.fi-lyrics-view-table');
                    if (!textView || !tableView) return;

                    const showingText = textView.style.display !== 'none';
                    textView.style.display  = showingText ? 'none' : '';
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
            for (const ch of uiChannels)  byChannel[ch.channel] = { ...ch };
            for (const ch of dbChannels) {
                const c = ch.channel;
                byChannel[c] = { ...(byChannel[c] || {}), ...ch };
            }
            return Object.values(byChannel).sort((a, b) => a.channel - b.channel);
        }

        /**
         * Génère le HTML d'une section collapsible.
         * @param {string}  title    — Titre (peut contenir du HTML simple, ex. badge)
         * @param {string}  content  — Corps HTML
         * @param {object}  opts
         * @param {boolean} opts.collapsed — Commence replié (défaut: false)
         * @param {number|string|null} opts.badge — Compteur affiché à droite du titre
         */
        _section(title, content, { collapsed = false, badge = null } = {}) {
            const colClass = collapsed ? 'fi-collapsible collapsed' : 'fi-collapsible';
            const badgeHtml = badge != null
                ? `<span class="fi-section-badge">${badge}</span>`
                : '';
            return `<div class="file-info-section ${colClass}">
                <div class="file-info-section-title">
                    <span class="fi-section-chevron">▶</span>
                    <span class="fi-section-label">${title}</span>
                    ${badgeHtml}
                </div>
                <div class="file-info-section-body">${content}</div>
            </div>`;
        }

        _row(label, value) {
            return `<div class="file-info-row">
                <span class="fi-label">${label}</span>
                <span class="fi-value">${value}</span>
            </div>`;
        }

        /** Ligne mise en avant (titre, copyright) */
        _rowHighlight(label, value) {
            return `<div class="file-info-row fi-row-highlight">
                <span class="fi-label">${label}</span>
                <span class="fi-value fi-value-highlight">${value}</span>
            </div>`;
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorInfoModal = MidiEditorInfoModal;
    }
})();
