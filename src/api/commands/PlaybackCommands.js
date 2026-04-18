/**
 * @file src/api/commands/PlaybackCommands.js
 * @description Aggregator that wires every `playback_*` WebSocket
 * command into the {@link CommandRegistry}. Actual handlers live under
 * `src/midi/playback/commands/` and are split by concern:
 * control / analysis / assignment / routing.
 */
import { register as registerPlaybackControl } from '../../midi/playback/commands/PlaybackControlCommands.js';
import { register as registerPlaybackAnalysis } from '../../midi/playback/commands/PlaybackAnalysisCommands.js';
import { register as registerPlaybackAssignment } from '../../midi/playback/commands/PlaybackAssignmentCommands.js';
import { register as registerPlaybackRouting } from '../../midi/playback/commands/PlaybackRoutingCommands.js';

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
