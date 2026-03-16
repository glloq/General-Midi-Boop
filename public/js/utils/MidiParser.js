// ============================================================================
// Fichier: frontend/js/utils/MidiParser.js
// Projet: MidiMind v3.0 - Système d'Orchestration MIDI pour Raspberry Pi
// Version: 3.0.0
// Date: 2025-10-14
// ============================================================================
// Description:
//   Parser de fichiers MIDI standard (formats 0, 1, 2).
//   Fallback si MidiJsonConverter indisponible ou pour parsing brut.
//
// Fonctionnalités:
//   - Parsing header MIDI (format, tracks, division)
//   - Parsing tracks (MTrk chunks)
//   - Parsing événements MIDI (running status)
//   - Parsing meta-events (tempo, time signature, etc.)
//   - Parsing SysEx
//   - Validation format MIDI
//   - Extraction métadonnées (title, composer, etc.)
//
// Architecture:
//   MidiParser (classe statique)
//   - Lecture binaire avec DataView
//   - État parser (running status)
//   - Validation progressive
//
// Auteur: MidiMind Team
// ============================================================================

class MidiParser {
    constructor() {
        // Configuration du parser
        this.config = {
            parseMetaEvents: true,
            parseSysEx: false,
            strictMode: false
        };
        
        // Statistiques de parsing
        this.stats = {
            filesParsed: 0,
            errors: 0,
            warnings: 0
        };
    }

    /**
     * Parse un fichier MIDI depuis un ArrayBuffer
     * @param {ArrayBuffer} arrayBuffer - Données brutes du fichier
     * @returns {Promise<Object>} - Données MIDI parsées
     */
    async parseFile(arrayBuffer) {
        try {
            const view = new DataView(arrayBuffer);
            let offset = 0;
            
            // 1️⃣ Parser l'en-tête
            const header = this.parseHeader(view, offset);
            offset += 14; // Taille de l'en-tête MIDI
            
            // 2️⃣ Parser les tracks
            const tracks = [];
            for (let i = 0; i < header.trackCount; i++) {
                const track = this.parseTrack(view, offset);
                tracks.push(track);
                offset += track.size + 8; // MTrk header + data
            }
            
            // 3️⃣ Analyser et structurer les données
            const midiData = {
                format: header.format,
                trackCount: header.trackCount,
                ticksPerQuarter: header.division,
                tracks: tracks,
                
                // Données dérivées
                duration: this.calculateDuration(tracks, header.division),
                tempo: this.extractTempo(tracks),
                timeSignature: this.extractTimeSignature(tracks),
                allNotes: this.extractAllNotes(tracks),
                tempoChanges: this.extractTempoChanges(tracks),
                
                // Métadonnées
                metadata: this.extractMetadata(tracks)
            };
            
            this.stats.filesParsed++;
            return midiData;
            
        } catch (error) {
            this.stats.errors++;
            console.error('Erreur parsing MIDI:', error);
            throw new Error(`Échec du parsing MIDI: ${error.message}`);
        }
    }

    /**
     * Parse l'en-tête du fichier MIDI
     */
    parseHeader(view, offset) {
        // Vérifier la signature "MThd"
        const signature = this.readString(view, offset, 4);
        if (signature !== 'MThd') {
            throw new Error('Signature MIDI invalide (attendu: MThd)');
        }
        
        // Lire la taille de l'en-tête (devrait être 6)
        const headerSize = view.getUint32(offset + 4);
        
        // Lire le format (0, 1 ou 2)
        const format = view.getUint16(offset + 8);
        
        // Lire le nombre de tracks
        const trackCount = view.getUint16(offset + 10);
        
        // Lire la division (ticks par quarter note)
        const division = view.getUint16(offset + 12);
        
        return {
            signature,
            headerSize,
            format,
            trackCount,
            division
        };
    }

    /**
     * Parse une track MIDI
     */
    parseTrack(view, offset) {
        // Vérifier la signature "MTrk"
        const signature = this.readString(view, offset, 4);
        if (signature !== 'MTrk') {
            throw new Error('Signature track invalide (attendu: MTrk)');
        }
        
        // Lire la taille de la track
        const size = view.getUint32(offset + 4);
        
        // Parser les événements de la track
        const events = [];
        let trackOffset = offset + 8;
        const trackEnd = trackOffset + size;
        let currentTime = 0;
        let runningStatus = null;
        
        while (trackOffset < trackEnd) {
            // Lire le delta time
            const deltaTime = this.readVariableLength(view, trackOffset);
            trackOffset += deltaTime.bytesRead;
            currentTime += deltaTime.value;

            // Lire l'événement
            const event = this.parseEvent(view, trackOffset, currentTime, runningStatus);
            if (event.bytesRead <= 0) {
                throw new Error(`Zero-length event at offset ${trackOffset} (corrupted MIDI data)`);
            }
            trackOffset += event.bytesRead;

            // Running status is only updated by channel messages, not meta-events or SysEx
            if (event.type !== 'running' && event.type !== 'meta' && event.type !== 'sysex') {
                runningStatus = event.status;
            }

            events.push(event);
        }
        
        // Extraire les informations de la track
        const trackInfo = {
            size,
            events,
            notes: this.extractNotes(events),
            name: this.extractTrackName(events),
            instrument: this.extractInstrument(events),
            channel: this.extractChannel(events),
            program: this.extractProgram(events)
        };
        
        return trackInfo;
    }

    /**
     * Parse un événement MIDI
     */
    parseEvent(view, offset, time, runningStatus) {
        const statusByte = view.getUint8(offset);
        
        // Meta event (0xFF)
        if (statusByte === 0xFF) {
            return this.parseMetaEvent(view, offset, time);
        }
        
        // SysEx event (0xF0 ou 0xF7)
        if (statusByte === 0xF0 || statusByte === 0xF7) {
            return this.parseSysExEvent(view, offset, time);
        }
        
        // MIDI channel event
        if (statusByte >= 0x80 && statusByte <= 0xEF) {
            return this.parseChannelEvent(view, offset, time, statusByte);
        }
        
        // Running status
        if (statusByte < 0x80 && runningStatus) {
            return this.parseChannelEvent(view, offset, time, runningStatus, true);
        }
        
        throw new Error(`Événement MIDI inconnu: 0x${statusByte.toString(16)}`);
    }

    /**
     * Parse un événement de canal MIDI
     */
    parseChannelEvent(view, offset, time, status, isRunningStatus = false) {
        const eventType = status & 0xF0;
        const channel = status & 0x0F;
        
        let bytesRead = isRunningStatus ? 0 : 1;
        let data1, data2;
        
        switch (eventType) {
            case 0x80: // Note Off
            case 0x90: // Note On
            case 0xA0: // Polyphonic Aftertouch
            case 0xB0: // Control Change
            case 0xE0: // Pitch Bend
                data1 = view.getUint8(offset + bytesRead);
                data2 = view.getUint8(offset + bytesRead + 1);
                bytesRead += 2;
                break;
                
            case 0xC0: // Program Change
            case 0xD0: // Channel Aftertouch
                data1 = view.getUint8(offset + bytesRead);
                bytesRead += 1;
                break;
        }
        
        return {
            type: this.getEventTypeName(eventType),
            status,
            channel,
            time,
            data1,
            data2,
            bytesRead
        };
    }

    /**
     * Parse un meta event
     */
    parseMetaEvent(view, offset, time) {
        const type = view.getUint8(offset + 1);
        const length = this.readVariableLength(view, offset + 2);
        
        let bytesRead = 2 + length.bytesRead + length.value;
        let data = [];
        
        for (let i = 0; i < length.value; i++) {
            data.push(view.getUint8(offset + 2 + length.bytesRead + i));
        }
        
        return {
            type: 'meta',
            metaType: type,
            metaTypeName: this.getMetaTypeName(type),
            time,
            data,
            bytesRead
        };
    }

    /**
     * Parse un SysEx event
     */
    parseSysExEvent(view, offset, time) {
        const length = this.readVariableLength(view, offset + 1);
        
        return {
            type: 'sysex',
            time,
            length: length.value,
            bytesRead: 1 + length.bytesRead + length.value
        };
    }

    /**
     * Lit une valeur de longueur variable
     */
    readVariableLength(view, offset) {
        let value = 0;
        let bytesRead = 0;
        let byte;

        do {
            if (bytesRead >= 4) {
                throw new Error(`Variable-length value exceeds 4 bytes at offset ${offset} (corrupted MIDI data)`);
            }
            byte = view.getUint8(offset + bytesRead);
            value = (value << 7) | (byte & 0x7F);
            bytesRead++;
        } while (byte & 0x80);

        return { value, bytesRead };
    }

    /**
     * Lit une chaîne de caractères
     */
    readString(view, offset, length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(view.getUint8(offset + i));
        }
        return str;
    }

    /**
     * Obtient le nom d'un type d'événement
     */
    getEventTypeName(eventType) {
        const names = {
            0x80: 'noteOff',
            0x90: 'noteOn',
            0xA0: 'polyAftertouch',
            0xB0: 'controlChange',
            0xC0: 'programChange',
            0xD0: 'channelAftertouch',
            0xE0: 'pitchBend'
        };
        return names[eventType] || 'unknown';
    }

    /**
     * Obtient le nom d'un meta type
     */
    getMetaTypeName(metaType) {
        const names = {
            0x00: 'sequenceNumber',
            0x01: 'text',
            0x02: 'copyright',
            0x03: 'trackName',
            0x04: 'instrumentName',
            0x05: 'lyric',
            0x06: 'marker',
            0x07: 'cuePoint',
            0x20: 'channelPrefix',
            0x2F: 'endOfTrack',
            0x51: 'setTempo',
            0x54: 'smpteOffset',
            0x58: 'timeSignature',
            0x59: 'keySignature',
            0x7F: 'sequencerSpecific'
        };
        return names[metaType] || 'unknown';
    }

    // ===== EXTRACTION DE DONNÉES =====

    /**
     * Extrait toutes les notes d'une track
     */
    extractNotes(events) {
        const notes = [];
        const activeNotes = new Map();
        
        events.forEach(event => {
            if (event.type === 'noteOn' && event.data2 > 0) {
                // Note On
                const key = `${event.channel}_${event.data1}`;
                activeNotes.set(key, {
                    note: event.data1,
                    channel: event.channel,
                    velocity: event.data2,
                    startTime: event.time
                });
            } else if (event.type === 'noteOff' || (event.type === 'noteOn' && event.data2 === 0)) {
                // Note Off
                const key = `${event.channel}_${event.data1}`;
                const noteOn = activeNotes.get(key);
                
                if (noteOn) {
                    notes.push({
                        note: noteOn.note,
                        channel: noteOn.channel,
                        velocity: noteOn.velocity,
                        startTime: noteOn.startTime,
                        endTime: event.time,
                        duration: event.time - noteOn.startTime
                    });
                    activeNotes.delete(key);
                }
            }
        });
        
        return notes;
    }

    /**
     * Extrait toutes les notes de toutes les tracks
     */
    extractAllNotes(tracks) {
        const allNotes = [];
        tracks.forEach(track => {
            if (track.notes) {
                allNotes.push(...track.notes);
            }
        });
        return allNotes;
    }

    /**
     * Extrait le nom d'une track
     */
    extractTrackName(events) {
        const nameEvent = events.find(e => e.metaTypeName === 'trackName');
        if (nameEvent) {
            return String.fromCharCode(...nameEvent.data);
        }
        return 'Untitled';
    }

    /**
     * Extrait l'instrument d'une track
     */
    extractInstrument(events) {
        const instEvent = events.find(e => e.metaTypeName === 'instrumentName');
        if (instEvent) {
            return String.fromCharCode(...instEvent.data);
        }
        return 'Piano'; // Par défaut
    }

    /**
     * Extrait le canal principal d'une track
     */
    extractChannel(events) {
        const channelEvent = events.find(e => e.channel !== undefined);
        return channelEvent ? channelEvent.channel : 0;
    }

    /**
     * Extrait le programme (patch) d'une track
     */
    extractProgram(events) {
        const programEvent = events.find(e => e.type === 'programChange');
        return programEvent ? programEvent.data1 : 0;
    }

    /**
     * Extrait le tempo
     */
    extractTempo(tracks) {
        for (const track of tracks) {
            const tempoEvent = track.events.find(e => e.metaTypeName === 'setTempo');
            if (tempoEvent) {
                const microsecondsPerQuarter = 
                    (tempoEvent.data[0] << 16) | 
                    (tempoEvent.data[1] << 8) | 
                    tempoEvent.data[2];
                return Math.round(60000000 / microsecondsPerQuarter);
            }
        }
        return 120; // Tempo par défaut
    }

    /**
     * Extrait tous les changements de tempo
     */
    extractTempoChanges(tracks) {
        const tempoChanges = [];
        tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.metaTypeName === 'setTempo') {
                    const microsecondsPerQuarter = 
                        (event.data[0] << 16) | 
                        (event.data[1] << 8) | 
                        event.data[2];
                    tempoChanges.push({
                        time: event.time,
                        bpm: Math.round(60000000 / microsecondsPerQuarter)
                    });
                }
            });
        });
        tempoChanges.sort((a, b) => a.time - b.time);
        return tempoChanges;
    }

    /**
     * Extrait la signature rythmique
     */
    extractTimeSignature(tracks) {
        for (const track of tracks) {
            const tsEvent = track.events.find(e => e.metaTypeName === 'timeSignature');
            if (tsEvent) {
                return {
                    numerator: tsEvent.data[0],
                    denominator: Math.pow(2, tsEvent.data[1])
                };
            }
        }
        return { numerator: 4, denominator: 4 }; // Par défaut
    }

    /**
     * Calcule la durée totale
     */
    calculateDuration(tracks, ticksPerQuarter) {
        // Find max tick across all tracks
        let maxTick = 0;
        tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.time > maxTick) {
                    maxTick = event.time;
                }
            });
        });

        // Get all tempo changes (already sorted by time)
        const tempoChanges = this.extractTempoChanges(tracks);

        if (tempoChanges.length <= 1) {
            // Single tempo: simple calculation
            const tempo = tempoChanges.length === 1 ? tempoChanges[0].bpm : 120;
            const microsecondsPerTick = (60000000 / tempo) / ticksPerQuarter;
            return (maxTick * microsecondsPerTick) / 1000000;
        }

        // Multi-tempo: walk through tempo changes
        let cumulativeSeconds = 0;
        let lastTick = 0;
        let currentBpm = tempoChanges[0].bpm;

        for (let i = 1; i < tempoChanges.length; i++) {
            const deltaTicks = tempoChanges[i].time - lastTick;
            const microsecondsPerTick = (60000000 / currentBpm) / ticksPerQuarter;
            cumulativeSeconds += (deltaTicks * microsecondsPerTick) / 1000000;
            lastTick = tempoChanges[i].time;
            currentBpm = tempoChanges[i].bpm;
        }
        // Add remaining ticks after last tempo change
        const remainingTicks = maxTick - lastTick;
        const microsecondsPerTick = (60000000 / currentBpm) / ticksPerQuarter;
        cumulativeSeconds += (remainingTicks * microsecondsPerTick) / 1000000;

        return cumulativeSeconds;
    }

    /**
     * Extrait les métadonnées
     */
    extractMetadata(tracks) {
        const metadata = {};
        
        tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.metaTypeName === 'text') {
                    metadata.text = String.fromCharCode(...event.data);
                }
                if (event.metaTypeName === 'copyright') {
                    metadata.copyright = String.fromCharCode(...event.data);
                }
            });
        });
        
        return metadata;
    }
}
window.MidiParser = MidiParser;