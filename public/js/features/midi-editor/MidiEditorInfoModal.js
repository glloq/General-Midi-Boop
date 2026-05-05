// ============================================================================
// File: public/js/features/midi-editor/MidiEditorInfoModal.js
// Description: Popup d'informations du fichier MIDI — affiche toutes les
//   métadonnées (tempo, durée, canaux, titre, copyright, paroles, marqueurs…)
//   récupérées depuis les données déjà chargées + l'endpoint
//   GET /api/files/:id/text-events.
// ============================================================================

(function () {
    'use strict';

    class MidiEditorInfoModal {
        constructor(modal) {
            this.modal = modal;
        }

        // ------------------------------------------------------------------ //
        // PUBLIC: ouvrir le popup                                             //
        // ------------------------------------------------------------------ //

        async show() {
            if (document.querySelector('.file-info-modal-overlay')) return; // déjà ouvert

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
                </div>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.classList.add('visible'));

            // Fermeture
            const close = () => {
                overlay.classList.remove('visible');
                setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 200);
            };
            overlay.querySelector('.file-info-modal-close').addEventListener('click', close);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', function onKey(e) {
                if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
            });

            // Remplir le contenu
            try {
                const textData = await this._fetchTextEvents();
                overlay.querySelector('.file-info-modal-body').innerHTML = this._renderBody(textData);
            } catch (err) {
                overlay.querySelector('.file-info-modal-body').innerHTML =
                    `<p class="file-info-error">Impossible de charger les métadonnées : ${err.message}</p>`;
            }
        }

        // ------------------------------------------------------------------ //
        // PRIVÉ : récupération des text events via HTTP                       //
        // ------------------------------------------------------------------ //

        async _fetchTextEvents() {
            const fileId = this.modal.currentFile;
            if (!fileId) return null;
            const resp = await fetch(`/api/files/${encodeURIComponent(fileId)}/text-events`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.json();
        }

        // ------------------------------------------------------------------ //
        // PRIVÉ : rendu HTML du corps                                         //
        // ------------------------------------------------------------------ //

        _renderBody(textData) {
            const m = this.modal;
            const midi = m.midiData;
            const header = midi?.header || {};

            const fmt = (v, fallback = '—') => (v !== null && v !== undefined && v !== '') ? v : fallback;
            const esc = (s) => String(s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Durée formatée
            const totalTicks = this._computeTotalTicks();
            const durationSec = this._ticksToSeconds(totalTicks);
            const durationFmt = durationSec > 0
                ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, '0')}`
                : '—';

            // Titre / copyright depuis l'API ou depuis les tracks chargés
            const title     = textData?.title     || this._extractLocalText('trackName',  0) || '—';
            const copyright = textData?.copyright || this._extractLocalText('copyright') || '—';

            let html = '';

            // ── Section : Fichier ──────────────────────────────────────────
            html += this._section('🗂 Fichier', `
                ${this._row('Nom',      esc(m.currentFilename || m.currentFile))}
                ${this._row('Titre',    esc(title))}
                ${this._row('Copyright', esc(copyright))}
                ${this._row('Format MIDI', fmt(header.format !== undefined ? `Type ${header.format}` : null))}
                ${this._row('Pistes',   fmt(header.numTracks))}
                ${this._row('Durée',    durationFmt)}
                ${this._row('Tempo',    m.tempo ? `${Math.round(m.tempo)} BPM` : '—')}
                ${this._row('PPQ',      fmt(header.ticksPerBeat))}
            `);

            // ── Section : Canaux ──────────────────────────────────────────
            if (m.channels && m.channels.length > 0) {
                const rows = m.channels.map(ch => {
                    const name = m.getInstrumentName?.(ch.program) || ch.instrument || `Programme ${ch.program}`;
                    const isDrum = ch.channel === 9;
                    return `<tr>
                        <td class="fi-td-num">Canal ${ch.channel + 1}${isDrum ? ' 🥁' : ''}</td>
                        <td>${esc(name)}</td>
                        <td class="fi-td-num">${ch.noteCount || 0} notes</td>
                    </tr>`;
                }).join('');
                html += this._section('🎹 Canaux', `
                    <table class="file-info-table">
                        <thead><tr><th>Canal</th><th>Instrument</th><th>Notes</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `);
            }

            // ── Section : Marqueurs ───────────────────────────────────────
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

            // ── Section : Paroles ─────────────────────────────────────────
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

            // ── Section : Autres événements texte ─────────────────────────
            const otherTypes = ['text', 'instrumentName', 'cuePoint', 'programName', 'deviceName'];
            const otherEvents = (textData?.events || []).filter(e => otherTypes.includes(e.event_type));
            if (otherEvents.length > 0) {
                const rows = otherEvents.map(e =>
                    `<tr><td class="fi-td-tag">${esc(e.event_type)}</td><td class="fi-td-num">${e.tick}</td><td>${esc(e.text)}</td></tr>`
                ).join('');
                html += this._section('📄 Autres textes', `
                    <table class="file-info-table">
                        <thead><tr><th>Type</th><th>Tick</th><th>Texte</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                `);
            }

            // ── Section : Signatures ──────────────────────────────────────
            const timeSigs = textData?.summary?.timeSignatures || [];
            const keySigs  = textData?.summary?.keySignatures  || [];
            if (timeSigs.length > 0 || keySigs.length > 0) {
                const KEY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
                let sigHtml = '';
                if (timeSigs.length > 0) {
                    const rows = timeSigs.map(s =>
                        `<tr><td class="fi-td-num">${s.tick}</td><td>${s.numerator}/${s.denominator}</td></tr>`
                    ).join('');
                    sigHtml += `<div class="fi-sig-group"><strong>Mesure</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Signature</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
                }
                if (keySigs.length > 0) {
                    const rows = keySigs.map(s => {
                        const noteIdx = ((s.key % 12) + 12) % 12;
                        const tonality = KEY_NAMES[noteIdx] + (s.scale === 0 ? ' Maj' : ' min');
                        return `<tr><td class="fi-td-num">${s.tick}</td><td>${tonality}</td></tr>`;
                    }).join('');
                    sigHtml += `<div class="fi-sig-group"><strong>Tonalité</strong>
                        <table class="file-info-table"><thead><tr><th>Tick</th><th>Tonalité</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`;
                }
                html += this._section('🎼 Signatures', sigHtml);
            }

            return html || '<p class="file-info-empty">Aucune métadonnée disponible.</p>';
        }

        // ------------------------------------------------------------------ //
        // HELPERS                                                              //
        // ------------------------------------------------------------------ //

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

        // Extrait un texte directement depuis midiData.tracks (fallback sans API)
        _extractLocalText(eventType, trackIndex = null) {
            const tracks = this.modal.midiData?.tracks || [];
            for (let i = 0; i < tracks.length; i++) {
                if (trackIndex !== null && i !== trackIndex) continue;
                for (const ev of tracks[i]?.events || []) {
                    if (ev.type === eventType && ev.text) return ev.text;
                }
            }
            return null;
        }

        _computeTotalTicks() {
            let max = 0;
            for (const track of (this.modal.midiData?.tracks || [])) {
                let t = 0;
                for (const ev of track?.events || []) t += ev.deltaTime || 0;
                if (t > max) max = t;
            }
            return max;
        }

        _ticksToSeconds(ticks) {
            const ppq = this.modal.midiData?.header?.ticksPerBeat || 480;
            const bpm = this.modal.tempo || 120;
            return (ticks / ppq) * (60 / bpm);
        }
    }

    if (typeof window !== 'undefined') {
        window.MidiEditorInfoModal = MidiEditorInfoModal;
    }
})();
