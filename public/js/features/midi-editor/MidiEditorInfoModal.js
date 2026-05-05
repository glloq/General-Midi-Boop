// ============================================================================
// File: public/js/features/midi-editor/MidiEditorInfoModal.js
// Description: Popup d'informations complètes du fichier MIDI.
//   Combine trois sources de données :
//     1. file_metadata  (WS) — taille, routing, durée DB
//     2. file_channels  (WS) — analyse par canal (type, polyphonie, densité)
//     3. file_text_events (WS) — titre, copyright, paroles, marqueurs…
//     4. midiData (local) — statistiques calculées depuis les tracks brutes
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
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

    function fmtPct(v) {
        return v != null ? Math.round(v) + ' %' : '—';
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
                overlay.classList.remove('visible');
                setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 200);
            };
            overlay.querySelector('.file-info-modal-close').addEventListener('click', close);
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
            document.addEventListener('keydown', onKey);

            try {
                const [textData, channelData, metaData] = await this._fetchAll();
                const localStats = this._computeLocalStats();
                overlay.querySelector('.file-info-modal-body').innerHTML =
                    this._renderBody(textData, channelData, metaData, localStats);
            } catch (err) {
                overlay.querySelector('.file-info-modal-body').innerHTML =
                    `<p class="file-info-error">Impossible de charger les métadonnées : ${esc(err.message)}</p>`;
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
                eventCounts: {},   // type → count
                ccUsage:     {},   // ccNumber → { count, channels: Set }
                timeSigs:    [],   // { tick, num, den }
                keySigs:     [],   // { tick, key, scale }
                progChanges: [],   // { tick, channel, program }
                sysexCount:  0,
                hasPitchBend:false,
                velMin: 127, velMax: 0, velSum: 0, velCount: 0,
                noteMin: 127, noteMax: 0,
                totalNotes: 0,
                polyMax: 0,        // max simultaneous noteOn across all channels
                tempoChanges: 0
            };

            // Active note tracking for polyphony
            let activeNotes = 0;

            for (const track of tracks) {
                let tick = 0;
                for (const ev of (track.events || track || [])) {
                    tick += ev.deltaTime || 0;
                    const t = ev.type;

                    // Count every event type
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
                    }
                }
            }

            if (stats.velCount === 0) { stats.velMin = 0; stats.velMax = 0; }
            if (stats.noteMin > stats.noteMax) { stats.noteMin = 0; stats.noteMax = 0; }

            return stats;
        }

        // ------------------------------------------------------------------ //
        // RENDU HTML                                                          //
        // ------------------------------------------------------------------ //

        _renderBody(textData, channelData, metaData, ls) {
            const m   = this.modal;
            const hdr = m.midiData?.header || {};
            const meta = metaData?.metadata || {};

            const title     = textData?.title     || '—';
            const copyright = textData?.copyright || '—';

            let html = '';

            // ── 🗂 Fichier ───────────────────────────────────────────────── //
            const routingLabel = ROUTING_LABELS[meta.routingStatus] || meta.routingStatus || '—';
            const adaptedLabel = meta.isAdapted ? 'Oui' : (meta.isAdapted === false ? 'Non' : '—');
            html += this._section('🗂 Fichier', `
                ${this._row('Nom',           esc(m.currentFilename || m.currentFile))}
                ${this._row('Titre',         esc(title))}
                ${this._row('Copyright',     esc(copyright))}
                ${this._row('Taille',        fmtSize(meta.size))}
                ${this._row('Format MIDI',   hdr.format !== undefined ? `Type ${hdr.format}` : '—')}
                ${this._row('Pistes SMF',    fmt(hdr.numTracks ?? meta.tracks))}
                ${this._row('Durée',         fmtDuration(meta.duration))}
                ${this._row('Tempo initial', m.tempo ? `${Math.round(m.tempo)} BPM` : '—')}
                ${this._row('Changements tempo', ls.tempoChanges > 1 ? `${ls.tempoChanges} changements` : (ls.tempoChanges === 1 ? 'Fixe' : '—'))}
                ${this._row('PPQ',           fmt(hdr.ticksPerBeat ?? meta.ppq))}
                ${this._row('Statut routing',routingLabel)}
                ${this._row('Adapté',        adaptedLabel)}
            `);

            // ── 📊 Statistiques ──────────────────────────────────────────── //
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
            `);

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
                    const poly     = ch.polyphony_max > 0 ? ch.polyphony_max : '—';
                    const dens     = ch.density != null ? ch.density.toFixed(2) : '—';
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
                `);
            }

            // ── 🎛 Contrôleurs CC ────────────────────────────────────────── //
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
                `);
            }

            // ── 🎼 Signatures ────────────────────────────────────────────── //
            const KEY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
            if (ls.timeSigs.length > 0 || ls.keySigs.length > 0) {
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
                html += this._section('🎼 Signatures', sigHtml);
            }

            // ── 🔄 Changements de programme ─────────────────────────────── //
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
                `);
            }

            // ── 📍 Marqueurs ──────────────────────────────────────────────── //
            const markers = textData?.grouped?.marker || [];
            if (markers.length > 0) {
                const rows = markers.map(e =>
                    `<tr><td class="fi-td-num">${e.tick}</td><td>${esc(e.text)}</td></tr>`
                ).join('');
                html += this._section('📍 Marqueurs', `
                    <table class="file-info-table">
                        <thead><tr><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `);
            }

            // ── 🎤 Paroles ────────────────────────────────────────────────── //
            const lyrics = textData?.grouped?.lyrics || [];
            if (lyrics.length > 0) {
                const rows = lyrics.map(e =>
                    `<tr><td class="fi-td-num">${e.tick}</td><td>${esc(e.text)}</td></tr>`
                ).join('');
                html += this._section('🎤 Paroles', `
                    <table class="file-info-table">
                        <thead><tr><th>Tick</th><th>Parole</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `);
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
                `);
            }

            return html || '<p class="file-info-empty">Aucune métadonnée disponible.</p>';
        }

        // ------------------------------------------------------------------ //
        // HELPERS                                                             //
        // ------------------------------------------------------------------ //

        _mergeChannels(uiChannels, dbChannels) {
            const byChannel = {};
            for (const ch of uiChannels) {
                byChannel[ch.channel] = { ...ch };
            }
            for (const ch of dbChannels) {
                const c = ch.channel ?? ch.channel;
                byChannel[c] = { ...(byChannel[c] || {}), ...ch };
            }
            return Object.values(byChannel).sort((a, b) => a.channel - b.channel);
        }

        _section(title, content) {
            return `<div class="file-info-section">
                <div class="file-info-section-title">${title}</div>
                <div class="file-info-section-body">${content}</div>
            </div>`;
        }

        _row(label, value) {
            return `<div class="file-info-row">
                <span class="fi-label">${label}</span>
                <span class="fi-value">${value}</span>
            </div>`;
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorInfoModal = MidiEditorInfoModal;
    }
})();
