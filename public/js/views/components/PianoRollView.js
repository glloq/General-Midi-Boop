// ============================================================================
// Fichier: public/js/views/components/PianoRollView.js
// Version: v6.0.0 - Lecture DIRECTE du temps depuis le synthétiseur audio
// ============================================================================

class PianoRollView {
    constructor(eventBus, logger) {
        this.eventBus = eventBus;
        this.logger = logger;

        // État
        this.isVisible = false;
        this.isEnabled = false;
        this.isPlaying = false;

        // Données MIDI - stockées en SECONDES (comme VirtualMidiPlayer)
        this.notes = [];
        this.channels = [];
        this.mutedChannels = new Set();

        // Timing - reçu DIRECTEMENT de la source externe en SECONDES
        this.currentTime = 0;
        this.tempo = 120;
        this.ticksPerBeat = 480;

        // Fenêtre d'affichage en secondes (par défaut 20s, comme dans les réglages)
        this.displayWindowSeconds = 20;

        // Plage de notes
        this.noteMin = 21;
        this.noteMax = 108;

        // Canvas
        this.canvas = null;
        this.ctx = null;
        this.container = null;

        // Couleurs
        this.channelColors = [
            '#FF0066', '#00FFFF', '#FF00FF', '#FFFF00',
            '#00FF00', '#FF6600', '#9D00FF', '#00FF99',
            '#FF0000', '#00BFFF', '#FFD700', '#FF1493',
            '#00FFAA', '#FF4500', '#7FFF00', '#FF69B4'
        ];
        this.mutedColor = '#444';
        this.bgColor = '#111';
        this.gridColor = '#333';
        this.labelColor = '#888';

        this.init();

        // Écouter les changements de thème (bound reference for cleanup)
        this._onThemeChanged = () => this.updateTheme();
        document.addEventListener('theme-changed', this._onThemeChanged);
    }

    log(level, msg) {
        const text = `[PianoRoll] ${msg}`;
        if (this.logger && this.logger[level]) {
            this.logger[level](text);
        } else {
            console.log(text);
        }
    }

    init() {
        this.createDOM();
        this.setupEvents();
        this.loadSettings();
        this.updateTheme();
        this.log('info', 'v6 initialized (direct audio timing)');
    }

    updateTheme() {
        const isDark = document.body.classList.contains('dark-mode');
        if (isDark) {
            this.bgColor = '#111';
            this.mutedColor = '#444';
            this.gridColor = '#333';
            this.labelColor = '#888';
        } else {
            this.bgColor = '#d8d0ec';
            this.mutedColor = '#9490b0';
            this.gridColor = '#c8c0de';
            this.labelColor = '#4a3f6b';
        }
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('maestro_settings');
            if (saved) {
                const s = JSON.parse(saved);
                this.isEnabled = s.showPianoRoll || false;
                this.displayWindowSeconds = s.noteDisplayTime || 20;
            }
        } catch (e) {}
    }

    createDOM() {
        this.container = document.createElement('div');
        this.container.id = 'piano-roll-view';
        this.container.className = 'piano-roll-view hidden';
        this.container.innerHTML = `
            <div class="piano-roll-view-header">
                <div class="piano-roll-view-title">
                    <span class="piano-roll-icon">🎹</span>
                    <span class="piano-roll-title-text">Piano Roll</span>
                </div>
                <div class="piano-roll-view-channels" id="pianoRollChannelBtns"></div>
            </div>
            <div class="piano-roll-view-content">
                <canvas id="pianoRollCanvas"></canvas>
            </div>
        `;

        const main = document.querySelector('.container');
        if (main) main.appendChild(this.container);
        else document.body.appendChild(this.container);

        this.canvas = document.getElementById('pianoRollCanvas');
        this.ctx = this.canvas.getContext('2d');
    }

    setupEvents() {
        if (!this.eventBus) return;

        // Settings
        this.eventBus.on('settings:piano_roll_changed', (d) => {
            this.isEnabled = d.enabled;
            if (!this.isEnabled && this.isVisible) this.hide();
        });

        // Temps d'affichage en preview
        this.eventBus.on('settings:display_time_changed', (d) => {
            if (d.time) {
                this.displayWindowSeconds = d.time;
                this.log('info', `Display window set to ${d.time}s`);
            }
        });

        // Fichier chargé - UTILISER parsedEvents si disponible (timing IDENTIQUE à l'audio)
        this.eventBus.on('file:selected', (data) => {
            if (data.tempo) this.tempo = data.tempo;
            if (data.ticksPerBeat) this.ticksPerBeat = data.ticksPerBeat;

            // PRIORITÉ: utiliser parsedEvents s'ils existent (timing exact de VirtualMidiPlayer)
            if (data.parsedEvents && data.parsedEvents.length > 0) {
                this.loadFromParsedEvents(data.parsedEvents);
                this.log('info', `Using pre-parsed events: ${this.notes.length} notes`);
            } else if (data.midiData) {
                this.loadMidiData(data.midiData);
                this.log('info', `Parsed MIDI: ${this.notes.length} notes`);
            }
        });

        // Play - démarrer notre propre boucle d'animation
        this.eventBus.on('playback:play', () => {
            this.isPlaying = true;
            if (this.isEnabled && this.notes.length > 0) {
                this.show();
                this.startAnimationLoop();
            }
        });

        // Pause - arrêt immédiat
        this.eventBus.on('playback:pause', () => {
            this.isPlaying = false;
            this.stopAnimationLoop();
        });

        // Stop
        this.eventBus.on('playback:stop', () => {
            this.isPlaying = false;
            this.currentTime = 0;
            this.stopAnimationLoop();
            this.hide();
        });

        // Temps - utiliser comme source de timing DIRECTE
        this.eventBus.on('playback:time', (data) => {
            if (data.time !== undefined) {
                this.currentTime = data.time;
            }
        });
    }

    // Boucle d'animation propre au piano roll - LIT LE TEMPS DIRECTEMENT depuis l'audio
    startAnimationLoop() {
        if (this.animationFrame) return;

        const animate = () => {
            if (!this.isPlaying) return;

            // LIRE LE TEMPS DIRECTEMENT depuis le synthétiseur - PAS via événements!
            this.updateTimeFromSynth();

            // Skip draw if time hasn't changed significantly (saves GPU)
            if (this.isVisible && Math.abs(this.currentTime - (this._lastDrawnTime || -1)) > 0.016) {
                this.draw();
                this._lastDrawnTime = this.currentTime;
            }
            this.animationFrame = requestAnimationFrame(animate);
        };
        this.animationFrame = requestAnimationFrame(animate);
    }

    // Obtenir le temps depuis la source appropriée
    updateTimeFromSynth() {
        // Essayer d'abord le player virtuel (mode instrument virtuel)
        const player = window.virtualPlayer;
        if (player && player.synthesizer && player.synthesizer.audioContext) {
            const synth = player.synthesizer;
            const audioTime = synth.audioContext.currentTime;
            const startTime = synth.startTime || 0;
            const newTime = Math.max(0, audioTime - startTime);

            // DEBUG: Log timing every second
            if (this._debug && (!this._lastDebugLog || newTime - this._lastDebugLog >= 1)) {
                console.log(`[PianoRoll DEBUG] VIRTUAL mode: time=${newTime.toFixed(2)}s`);
                this._lastDebugLog = newTime;
            }

            this.currentTime = newTime;
            return;
        }

        // Mode backend: utiliser le temps reçu via playback:time events
        // (déjà mis à jour par l'event handler)
        // DEBUG: Log timing every second
        if (this._debug && (!this._lastDebugLog || this.currentTime - this._lastDebugLog >= 1)) {
            console.log(`[PianoRoll DEBUG] BACKEND mode: time=${this.currentTime.toFixed(2)}s`);
            this._lastDebugLog = this.currentTime;
        }
    }

    stopAnimationLoop() {
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
    }

    loadMidiData(midiData) {
        if (!midiData || !midiData.tracks) {
            this.notes = [];
            this.channels = [];
            return;
        }

        // Parser les notes - EXACTEMENT comme VirtualMidiPlayer.buildEventList()
        // Stocker en SECONDES pour synchronisation parfaite
        this.notes = [];
        const channelSet = new Set();
        const noteOns = {};

        // Calculer ticksPerSecond avec tempo et ticksPerBeat de la source
        const beatsPerSecond = this.tempo / 60;
        const ticksPerSecond = beatsPerSecond * this.ticksPerBeat;

        midiData.tracks.forEach(track => {
            if (!track.events) return;
            const events = track.events;

            let currentTick = 0; // Accumulation de deltaTime

            events.forEach(event => {
                // Accumuler deltaTime (comme VirtualMidiPlayer)
                currentTick += event.deltaTime || 0;

                // Convertir en secondes EXACTEMENT comme VirtualMidiPlayer
                const timeInSeconds = currentTick / ticksPerSecond;

                const ch = event.channel !== undefined ? event.channel : 0;
                const note = event.noteNumber;
                const vel = event.velocity || 0;

                // noteOn avec velocity > 0
                if (event.type === 'noteOn' && vel > 0 && note !== undefined) {
                    noteOns[`${ch}_${note}`] = { time: timeInSeconds, ch, note, vel };
                    channelSet.add(ch);
                }
                // noteOff ou noteOn avec velocity 0
                else if ((event.type === 'noteOff' || (event.type === 'noteOn' && vel === 0)) && note !== undefined) {
                    const key = `${ch}_${note}`;
                    if (noteOns[key]) {
                        const on = noteOns[key];
                        this.notes.push({
                            startTime: on.time,
                            endTime: timeInSeconds,
                            note: on.note,
                            channel: on.ch
                        });
                        delete noteOns[key];
                    }
                }
            });
        });

        this.notes.sort((a, b) => a.startTime - b.startTime);

        // Plage de notes
        if (this.notes.length > 0) {
            let minN = 127, maxN = 0;
            this.notes.forEach(n => {
                if (n.note < minN) minN = n.note;
                if (n.note > maxN) maxN = n.note;
            });
            this.noteMin = Math.max(0, minN - 2);
            this.noteMax = Math.min(127, maxN + 2);
        }

        this.channels = Array.from(channelSet).sort((a, b) => a - b).map(ch => ({ channel: ch }));
        this.renderButtons();
    }

    // Charger depuis les événements pré-parsés de VirtualMidiPlayer
    // Ces événements ont EXACTEMENT le même timing que l'audio
    loadFromParsedEvents(events) {
        this.notes = [];
        const channelSet = new Set();
        const noteOns = {}; // key: "channel_note" -> {time, channel, note, velocity}

        // Coupler noteOn/noteOff (événements déjà triés par temps)
        for (const event of events) {
            const key = `${event.channel}_${event.note}`;

            if (event.type === 'noteOn' && event.velocity > 0) {
                noteOns[key] = {
                    time: event.time,
                    channel: event.channel,
                    note: event.note,
                    velocity: event.velocity
                };
                channelSet.add(event.channel);
            } else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.velocity === 0)) {
                if (noteOns[key]) {
                    const on = noteOns[key];
                    this.notes.push({
                        startTime: on.time,
                        endTime: event.time,
                        note: on.note,
                        channel: on.channel
                    });
                    delete noteOns[key];
                }
            }
        }

        this.notes.sort((a, b) => a.startTime - b.startTime);

        // Plage de notes
        if (this.notes.length > 0) {
            let minN = 127, maxN = 0;
            this.notes.forEach(n => {
                if (n.note < minN) minN = n.note;
                if (n.note > maxN) maxN = n.note;
            });
            this.noteMin = Math.max(0, minN - 2);
            this.noteMax = Math.min(127, maxN + 2);
        }

        // DEBUG: Log first few notes timing
        if (this._debug && this.notes.length > 0) {
            console.log('[PianoRoll DEBUG] First 5 notes loaded:', this.notes.slice(0, 5).map(n => ({
                start: n.startTime.toFixed(3),
                end: n.endTime.toFixed(3),
                note: n.note,
                ch: n.channel
            })));
        }

        this.channels = Array.from(channelSet).sort((a, b) => a - b).map(ch => ({ channel: ch }));
        this.renderButtons();
    }

    renderButtons() {
        const c = document.getElementById('pianoRollChannelBtns');
        if (!c) return;

        if (this.channels.length === 0) {
            c.innerHTML = `<span style="color:#666">${typeof i18n !== 'undefined' ? i18n.t('pianoRoll.noChannels') : 'No channels'}</span>`;
            return;
        }

        c.innerHTML = this.channels.map(ch => {
            const muted = this.mutedChannels.has(ch.channel);
            const color = this.channelColors[ch.channel % 16];
            return `<button class="channel-btn" data-ch="${ch.channel}"
                style="background:${muted ? '#333' : color};border-color:${muted ? '#555' : color};color:${muted ? '#888' : '#000'}">
                Ch ${ch.channel + 1}</button>`;
        }).join('');

        c.querySelectorAll('.channel-btn').forEach(btn => {
            btn.onclick = () => this.toggleMute(parseInt(btn.dataset.ch));
        });
    }

    toggleMute(ch) {
        if (this.mutedChannels.has(ch)) this.mutedChannels.delete(ch);
        else this.mutedChannels.add(ch);
        this.renderButtons();
        if (this.eventBus) {
            this.eventBus.emit('pianoroll:channel_toggled', { channel: ch, muted: this.mutedChannels.has(ch) });
        }
        if (this.isVisible) this.draw();
    }

    show() {
        if (this.isVisible) return;
        this.isVisible = true;
        this.container.classList.remove('hidden');
        this.container.classList.add('fullscreen');

        const mainGrid = document.querySelector('.main-grid');
        if (mainGrid) mainGrid.classList.add('hidden-for-pianoroll');

        requestAnimationFrame(() => {
            const header = document.querySelector('header');
            if (header) this.container.style.top = `${header.getBoundingClientRect().bottom + 8}px`;
            this.resizeCanvas();
            this.draw();
        });
    }

    hide() {
        this.isVisible = false;
        this.container.classList.add('hidden');
        this.container.classList.remove('fullscreen');
        const mainGrid = document.querySelector('.main-grid');
        if (mainGrid) mainGrid.classList.remove('hidden-for-pianoroll');
    }

    resizeCanvas() {
        if (!this.canvas) return;
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const rect = parent.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;

        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
    }

    draw() {
        if (!this.ctx || !this.canvas) return;

        const w = this.canvas.width / (window.devicePixelRatio || 1);
        const h = this.canvas.height / (window.devicePixelRatio || 1);

        // Fond
        this.ctx.fillStyle = this.bgColor;
        this.ctx.fillRect(0, 0, w, h);

        if (this.notes.length === 0) {
            this.ctx.fillStyle = '#666';
            this.ctx.font = '14px sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Aucune note', w / 2, h / 2);
            return;
        }

        // Fenêtre d'affichage directement en SECONDES
        const windowSeconds = this.displayWindowSeconds;
        const startTime = this.currentTime;
        const endTime = startTime + windowSeconds;

        // Dimensions
        const noteRange = this.noteMax - this.noteMin;
        const noteH = Math.max(3, h / noteRange);
        const playheadX = 50;

        // Binary search to find the first note that could be visible
        // (notes are sorted by startTime)
        let lo = 0, hi = this.notes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.notes[mid].endTime < startTime) lo = mid + 1;
            else hi = mid;
        }

        // Compute alpha: semi-transparent when multiple channels are visible
        const visibleChannels = new Set();
        for (let i = lo; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.startTime > endTime) break;
            if (!this.mutedChannels.has(n.channel)) visibleChannels.add(n.channel);
            if (visibleChannels.size > 1) break;
        }
        const noteAlpha = visibleChannels.size > 1 ? 0.7 : 1.0;

        // Draw only visible notes starting from binary search result
        for (let i = lo; i < this.notes.length; i++) {
            const n = this.notes[i];
            if (n.startTime > endTime) break;

            const muted = this.mutedChannels.has(n.channel);

            // X position - directement en secondes
            const x1 = playheadX + ((n.startTime - startTime) / windowSeconds) * (w - playheadX);
            const x2 = playheadX + ((n.endTime - startTime) / windowSeconds) * (w - playheadX);

            // Y position (inversé)
            const y = h - ((n.note - this.noteMin) / noteRange) * h;

            // Couleur avec semi-transparence pour le mélange multi-canal
            this.ctx.globalAlpha = muted ? 0.4 : noteAlpha;
            this.ctx.fillStyle = muted ? this.mutedColor : this.channelColors[n.channel % 16];
            this.ctx.fillRect(x1, y - noteH / 2, Math.max(2, x2 - x1), noteH);
        }
        this.ctx.globalAlpha = 1.0;

        // Playhead
        const isDarkTheme = document.body.classList.contains('dark-mode');
        this.ctx.strokeStyle = isDarkTheme ? '#fff' : '#667eea';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(playheadX, 0);
        this.ctx.lineTo(playheadX, h);
        this.ctx.stroke();

        // Temps - directement en secondes
        const m = Math.floor(this.currentTime / 60);
        const s = Math.floor(this.currentTime % 60);
        this.ctx.fillStyle = isDarkTheme ? '#fff' : '#2d3561';
        this.ctx.font = '12px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(`${m}:${s.toString().padStart(2, '0')}`, 5, 15);
    }

    destroy() {
        this.stopAnimationLoop();
        if (this._onThemeChanged) {
            document.removeEventListener('theme-changed', this._onThemeChanged);
        }
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}

if (typeof window !== 'undefined') {
    window.PianoRollView = PianoRollView;
    console.log('✓ PianoRollView v6 loaded (direct audio timing)');
}
