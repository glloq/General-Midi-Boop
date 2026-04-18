// src/api/commands/PlaybackCommands.js
// Orchestrator — delegates to 4 sub-modules now living in
// src/midi/domain/playback/ (P0-1.7 physical displacement).
import { register as registerPlaybackControl } from '../../midi/domain/playback/PlaybackControlCommands.js';
import { register as registerPlaybackAnalysis } from '../../midi/domain/playback/PlaybackAnalysisCommands.js';
import { register as registerPlaybackAssignment } from '../../midi/domain/playback/PlaybackAssignmentCommands.js';
import { register as registerPlaybackRouting } from '../../midi/domain/playback/PlaybackRoutingCommands.js';

export function register(registry, app) {
  registerPlaybackControl(registry, app);
  registerPlaybackAnalysis(registry, app);
  registerPlaybackAssignment(registry, app);
  registerPlaybackRouting(registry, app);
}
