/**
 * @file src/midi/playback/state/PlaybackStateMachine.js
 * @description Finite state machine for MIDI playback lifecycle.
 *
 * Prevents invalid transitions (e.g. seeking while stopped, double-stop)
 * that would otherwise be silently ignored or cause stale state in MidiPlayer.
 *
 * States:
 *   stopped  — no file loaded or playback fully ended.
 *   loading  — file is being fetched / parsed before first play.
 *   playing  — events are being scheduled and sent to devices.
 *   paused   — position is frozen; scheduler is stopped but state preserved.
 *   seeking  — position is changing (can happen from playing or paused).
 *
 * Valid transitions:
 *   stopped  → loading, playing
 *   loading  → stopped, playing
 *   playing  → paused, stopped, seeking
 *   paused   → playing, stopped, seeking
 *   seeking  → playing, paused, stopped
 */

const VALID_TRANSITIONS = Object.freeze({
  stopped: ['loading', 'playing'],
  loading: ['stopped', 'playing'],
  playing: ['paused', 'stopped', 'seeking'],
  paused:  ['playing', 'stopped', 'seeking'],
  seeking: ['playing', 'paused', 'stopped'],
});

export class PlaybackStateMachine {
  /**
   * @param {string} [initial='stopped']
   */
  constructor(initial = 'stopped') {
    if (!VALID_TRANSITIONS[initial]) {
      throw new Error(`PlaybackStateMachine: unknown initial state '${initial}'`);
    }
    this.state = initial;
  }

  /**
   * Transition to the next state.
   * @param {string} next - Target state.
   * @returns {string} The previous state.
   * @throws {Error} When the transition is not allowed.
   */
  transition(next) {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(next)) {
      throw new Error(
        `PlaybackStateMachine: invalid transition '${this.state}' → '${next}'. ` +
        `Allowed from '${this.state}': [${allowed?.join(', ') ?? 'none'}]`
      );
    }
    const prev = this.state;
    this.state = next;
    return prev;
  }

  /**
   * Attempt a transition without throwing. Returns true on success.
   * @param {string} next
   * @returns {boolean}
   */
  tryTransition(next) {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(next)) return false;
    this.transition(next);
    return true;
  }

  /**
   * @param {string} s
   * @returns {boolean}
   */
  is(s) {
    return this.state === s;
  }

  /**
   * @param {string} s
   * @returns {boolean}
   */
  can(s) {
    return VALID_TRANSITIONS[this.state]?.includes(s) ?? false;
  }

  /** @returns {string[]} Valid next states from current state. */
  allowedTransitions() {
    return VALID_TRANSITIONS[this.state] ?? [];
  }
}

/** Convenience state name constants — avoids inline string literals. */
export const PLAYBACK_STATES = Object.freeze({
  STOPPED: 'stopped',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED:  'paused',
  SEEKING: 'seeking',
});
