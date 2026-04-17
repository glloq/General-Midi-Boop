// ============================================================================
// File: public/js/views/components/midi-editor/MidiEditorConstants.js
// Description: Constants shared by all MIDI editor modules
// ============================================================================

const MidiEditorConstants = {

    // Default canvas height in pixels for the standalone velocity / tempo /
    // CC-pitchbend editors when the caller does not provide options.height.
    defaultEditorHeight: 150,

    // Grille de snap pour l'edition (contrainte de positionnement)
    // Valeurs en ticks (base sur 480 ticks par noire)
    snapValues: [
        { ticks: 120, label: '1/1' },  // Ronde (snap a 120 = 1/16, evite sauts enormes)
        { ticks: 60,  label: '1/2' },  // Blanche (snap a 60 = 1/32)
        { ticks: 30,  label: '1/4' },  // Noire (snap a 30 = 1/64)
        { ticks: 15,  label: '1/8' },  // Croche (snap a 15 = 1/128)
        { ticks: 1,   label: '1/16' }  // Double croche (snap a 1 tick = PRECISION MAXIMALE)
    ],

    defaultSnapIndex: 3, // Par defaut 1/8 (15 ticks, tres fin)

    // Couleurs eclatantes pour les 16 canaux MIDI
    channelColors: [
        '#FF0066', // 1 - Rose/Magenta vif
        '#00FFFF', // 2 - Cyan eclatant
        '#FF00FF', // 3 - Magenta pur
        '#FFFF00', // 4 - Jaune vif
        '#00FF00', // 5 - Vert pur
        '#FF6600', // 6 - Orange eclatant
        '#9D00FF', // 7 - Violet vif
        '#00FF99', // 8 - Vert menthe eclatant
        '#FF0000', // 9 - Rouge pur
        '#00BFFF', // 10 - Bleu ciel eclatant (Drums)
        '#FFD700', // 11 - Or eclatant
        '#FF1493', // 12 - Rose profond
        '#00FFAA', // 13 - Turquoise eclatant
        '#FF4500', // 14 - Orange-rouge vif
        '#7FFF00', // 15 - Vert chartreuse
        '#FF69B4'  // 16 - Rose chaud
    ],

    // Table des instruments General MIDI
    gmInstruments: [
        // Piano (0-7)
        'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
        'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
        // Chromatic Percussion (8-15)
        'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
        // Organ (16-23)
        'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
        // Guitar (24-31)
        'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
        'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar harmonics',
        // Bass (32-39)
        'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
        'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
        // Strings (40-47)
        'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
        // Ensemble (48-55)
        'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
        'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
        // Brass (56-63)
        'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
        // Reed (64-71)
        'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
        // Pipe (72-79)
        'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
        // Synth Lead (80-87)
        'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
        'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
        // Synth Pad (88-95)
        'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
        'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
        // Synth Effects (96-103)
        'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
        'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
        // Ethnic (104-111)
        'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
        // Percussive (112-119)
        'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
        // Sound Effects (120-127)
        'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
    ]
};

if (typeof window !== 'undefined') {
    window.MidiEditorConstants = MidiEditorConstants;
}
