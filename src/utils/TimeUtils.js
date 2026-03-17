// src/utils/TimeUtils.js

class TimeUtils {
  /**
   * Convert MIDI ticks to milliseconds
   * @param {number} ticks - MIDI ticks
   * @param {number} ppq - Pulses per quarter note
   * @param {number} bpm - Beats per minute
   * @returns {number} Milliseconds
   */
  static ticksToMs(ticks, ppq, bpm) {
    if (!ppq || !bpm) return 0;
    const beatsPerSecond = bpm / 60;
    const ticksPerSecond = beatsPerSecond * ppq;
    return (ticks / ticksPerSecond) * 1000;
  }

  /**
   * Convert MIDI ticks to seconds
   * @param {number} ticks - MIDI ticks
   * @param {number} ppq - Pulses per quarter note
   * @param {number} bpm - Beats per minute
   * @returns {number} Seconds
   */
  static ticksToSeconds(ticks, ppq, bpm) {
    if (!ppq || !bpm) return 0;
    const beatsPerSecond = bpm / 60;
    const ticksPerSecond = beatsPerSecond * ppq;
    return ticks / ticksPerSecond;
  }

  /**
   * Convert milliseconds to MIDI ticks
   * @param {number} ms - Milliseconds
   * @param {number} ppq - Pulses per quarter note
   * @param {number} bpm - Beats per minute
   * @returns {number} MIDI ticks
   */
  static msToTicks(ms, ppq, bpm) {
    if (!ppq || !bpm) return 0;
    const beatsPerSecond = bpm / 60;
    const ticksPerSecond = beatsPerSecond * ppq;
    return Math.round((ms / 1000) * ticksPerSecond);
  }

  /**
   * Convert seconds to MIDI ticks
   * @param {number} seconds - Seconds
   * @param {number} ppq - Pulses per quarter note
   * @param {number} bpm - Beats per minute
   * @returns {number} MIDI ticks
   */
  static secondsToTicks(seconds, ppq, bpm) {
    if (!ppq || !bpm) return 0;
    const beatsPerSecond = bpm / 60;
    const ticksPerSecond = beatsPerSecond * ppq;
    return Math.round(seconds * ticksPerSecond);
  }

  /**
   * Convert microseconds per beat to BPM
   * @param {number} microsecondsPerBeat - Microseconds per quarter note
   * @returns {number} BPM
   */
  static microsecondsPerBeatToBPM(microsecondsPerBeat) {
    if (!microsecondsPerBeat) return 120;
    return 60000000 / microsecondsPerBeat;
  }

  /**
   * Convert BPM to microseconds per beat
   * @param {number} bpm - Beats per minute
   * @returns {number} Microseconds per quarter note
   */
  static bpmToMicrosecondsPerBeat(bpm) {
    if (!bpm) return 500000; // 120 BPM default
    return Math.round(60000000 / bpm);
  }

  /**
   * Format milliseconds as MM:SS.mmm
   * @param {number} ms - Milliseconds
   * @returns {string} Formatted time
   */
  static formatMs(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = Math.floor(ms % 1000);
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  }

  /**
   * Format seconds as MM:SS
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  static formatSeconds(seconds) {
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Format seconds as HH:MM:SS
   * @param {number} seconds - Seconds
   * @returns {string} Formatted time
   */
  static formatSecondsLong(seconds) {
    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get current timestamp in milliseconds
   * @returns {number} Current timestamp
   */
  static now() {
    return Date.now();
  }

  /**
   * Get high-resolution timestamp in nanoseconds
   * @returns {bigint} High-resolution timestamp
   */
  static nowHiRes() {
    return process.hrtime.bigint();
  }

  /**
   * Calculate elapsed time in milliseconds from high-resolution start time
   * @param {bigint} startTime - Start time from process.hrtime.bigint()
   * @returns {number} Elapsed milliseconds
   */
  static elapsedMs(startTime) {
    const elapsed = process.hrtime.bigint() - startTime;
    return Number(elapsed) / 1000000; // ns to ms
  }

  /**
   * Calculate elapsed time in microseconds from high-resolution start time
   * @param {bigint} startTime - Start time from process.hrtime.bigint()
   * @returns {number} Elapsed microseconds
   */
  static elapsedUs(startTime) {
    const elapsed = process.hrtime.bigint() - startTime;
    return Number(elapsed) / 1000; // ns to us
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} Promise that resolves after delay
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Convert ISO timestamp to Unix timestamp
   * @param {string} isoString - ISO 8601 timestamp
   * @returns {number} Unix timestamp in milliseconds
   */
  static isoToTimestamp(isoString) {
    return new Date(isoString).getTime();
  }

  /**
   * Convert Unix timestamp to ISO string
   * @param {number} timestamp - Unix timestamp in milliseconds
   * @returns {string} ISO 8601 timestamp
   */
  static timestampToISO(timestamp) {
    return new Date(timestamp).toISOString();
  }

  /**
   * Calculate synchronization offset between two timestamps
   * @param {number} localTime - Local timestamp
   * @param {number} remoteTime - Remote timestamp
   * @returns {number} Offset in milliseconds
   */
  static calculateOffset(localTime, remoteTime) {
    return remoteTime - localTime;
  }

  /**
   * Apply offset to timestamp
   * @param {number} timestamp - Original timestamp
   * @param {number} offset - Offset to apply
   * @returns {number} Adjusted timestamp
   */
  static applyOffset(timestamp, offset) {
    return timestamp + offset;
  }
}

export default TimeUtils;