// tests/helpers/audioFixtures.js
// Tiny, generated audio fixtures for the transcription tests (§42).
//
// Everything here is synthesised from a formula — a sine tone, a silent
// buffer, a click pattern. Nothing is recorded, nothing is copyrighted, and
// no binary blob is committed to the repository.

/**
 * Build a mono 16-bit PCM WAV.
 *
 * @param {Object} [options]
 * @param {number} [options.durationSeconds=1]
 * @param {number} [options.frequency=440] - 0 produces silence.
 * @param {number} [options.sampleRate=22050]
 * @param {number} [options.amplitude=0.5] - 0..1.
 * @returns {Buffer}
 */
export function makeSineWav({
  durationSeconds = 1,
  frequency = 440,
  sampleRate = 22050,
  amplitude = 0.5
} = {}) {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const data = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const value =
      frequency > 0 ? Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude : 0;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return wrapWav(data, sampleRate, 1);
}

/**
 * A C major arpeggio (C-E-G-C), one tone per quarter of the duration.
 *
 * @param {Object} [options]
 * @param {number} [options.durationSeconds=2]
 * @param {number} [options.sampleRate=22050]
 * @returns {Buffer}
 */
export function makeArpeggioWav({ durationSeconds = 2, sampleRate = 22050 } = {}) {
  const frequencies = [261.63, 329.63, 392.0, 523.25];
  const perNote = Math.round((durationSeconds * sampleRate) / frequencies.length);
  const data = Buffer.alloc(perNote * frequencies.length * 2);
  let offset = 0;
  for (const frequency of frequencies) {
    for (let i = 0; i < perNote; i++) {
      // A short fade at each end keeps the fixture free of clicks.
      const envelope = Math.min(1, Math.min(i, perNote - i) / (sampleRate * 0.01));
      const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5 * envelope;
      data.writeInt16LE(Math.round(value * 32767), offset);
      offset += 2;
    }
  }
  return wrapWav(data, sampleRate, 1);
}

/**
 * Wrap raw PCM in a canonical 44-byte RIFF/WAVE header.
 *
 * @param {Buffer} pcm - 16-bit little-endian samples.
 * @param {number} sampleRate
 * @param {number} channels
 * @returns {Buffer}
 */
export function wrapWav(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
