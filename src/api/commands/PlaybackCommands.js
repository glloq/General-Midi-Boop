// src/api/commands/PlaybackCommands.js
// Orchestrator — delegates to 4 sub-modules after P0-1.1→P0-1.4 extraction.
import { register as registerPlaybackControl } from './playback/PlaybackControlCommands.js';
import { register as registerPlaybackAnalysis } from './playback/PlaybackAnalysisCommands.js';
import { register as registerPlaybackAssignment } from './playback/PlaybackAssignmentCommands.js';
import { register as registerPlaybackRouting } from './playback/PlaybackRoutingCommands.js';

export function register(registry, app) {
  registerPlaybackControl(registry, app);
  registerPlaybackAnalysis(registry, app);
  registerPlaybackAssignment(registry, app);
  registerPlaybackRouting(registry, app);
}
