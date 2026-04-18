/**
 * @file src/api/commands/PlaybackCommands.js
 * @description Aggregator that wires every `playback_*` WebSocket
 * command into the {@link CommandRegistry}. Actual handlers live under
 * `src/midi/domain/playback/` since P0-1.7 (physical displacement) and
 * are split by concern: control / analysis / assignment / routing.
 */
import { register as registerPlaybackControl } from '../../midi/domain/playback/PlaybackControlCommands.js';
import { register as registerPlaybackAnalysis } from '../../midi/domain/playback/PlaybackAnalysisCommands.js';
import { register as registerPlaybackAssignment } from '../../midi/domain/playback/PlaybackAssignmentCommands.js';
import { register as registerPlaybackRouting } from '../../midi/domain/playback/PlaybackRoutingCommands.js';

/**
 * Register every `playback_*` command on the registry by delegating to
 * the four domain sub-modules.
 *
 * @param {import('../CommandRegistry.js').default} registry
 * @param {Object} app - Application facade.
 * @returns {void}
 */
export function register(registry, app) {
  registerPlaybackControl(registry, app);
  registerPlaybackAnalysis(registry, app);
  registerPlaybackAssignment(registry, app);
  registerPlaybackRouting(registry, app);
}
