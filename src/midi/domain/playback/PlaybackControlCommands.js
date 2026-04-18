// src/midi/domain/playback/PlaybackControlCommands.js
// Extracted from PlaybackCommands.js — playback control handlers (P0-1.1).
import { ValidationError, ConfigurationError } from '../../../core/errors/index.js';

async function playbackStart(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  app.logger.info(`Loading file ${data.fileId} for playback...`);
  const fileInfo = await app.midiPlayer.loadFile(data.fileId);

  let loadedRoutings = 0;
  try {
    const savedRoutings = app.routingRepository.findByFileId(data.fileId);
    if (savedRoutings.length > 0) {
      app.midiPlayer.clearChannelRouting();

      const routingsByChannel = new Map();
      for (const routing of savedRoutings) {
        if (routing.channel === null || routing.channel === undefined || !routing.device_id) continue;
        if (!routingsByChannel.has(routing.channel)) routingsByChannel.set(routing.channel, []);
        routingsByChannel.get(routing.channel).push(routing);
      }

      for (const [channel, channelRoutings] of routingsByChannel) {
        const hasSplit = channelRoutings.length > 1 && channelRoutings.some(r => r.split_mode);

        if (hasSplit) {
          const segments = channelRoutings.map(r => ({
            device_id: r.device_id,
            target_channel: r.target_channel !== undefined ? r.target_channel : channel,
            split_note_min: r.split_note_min ?? 0,
            split_note_max: r.split_note_max ?? 127,
            split_polyphony_share: r.split_polyphony_share ?? null,
            overlap_strategy: r.overlap_strategy || 'first'
          }));
          app.midiPlayer.setChannelSplitRouting(channel, segments);
          loadedRoutings += channelRoutings.length;
          app.logger.info(`Auto-loaded split routing for channel ${channel + 1} with ${segments.length} segments`);
        } else {
          const routing = channelRoutings[0];
          const targetChannel = routing.target_channel !== undefined ? routing.target_channel : channel;
          app.midiPlayer.setChannelRouting(channel, routing.device_id, targetChannel);
          loadedRoutings++;
        }
      }

      app.logger.info(`Auto-loaded ${loadedRoutings} channel routings from database for file ${data.fileId}`);
    }
  } catch (routingError) {
    app.logger.warn(`Failed to auto-load routings: ${routingError.message}`);
  }

  let outputDevice = data.outputDevice;

  if (!outputDevice) {
    const devices = app.deviceManager.getDeviceList();
    const outputDevices = devices.filter(d => d.output && d.enabled);

    if (outputDevices.length === 0) {
      throw new ConfigurationError('No output devices available');
    }

    outputDevice = outputDevices[0].id;
    app.logger.info(`No output specified, using: ${outputDevice}`);
  }

  app.midiPlayer.start(outputDevice);

  return {
    success: true,
    fileInfo: fileInfo,
    outputDevice: outputDevice,
    loadedRoutings: loadedRoutings
  };
}

async function playbackStop(app) {
  app.midiPlayer.stop();
  return { success: true };
}

async function playbackPause(app) {
  app.midiPlayer.pause();
  return { success: true };
}

async function playbackResume(app) {
  app.midiPlayer.resume();
  return { success: true };
}

async function playbackSeek(app, data) {
  app.midiPlayer.seek(data.position);
  return { success: true };
}

async function playbackStatus(app) {
  return app.midiPlayer.getStatus();
}

async function playbackSetLoop(app, data) {
  app.midiPlayer.setLoop(data.enabled);
  return { success: true };
}

async function playbackSetTempo(_app, _data) {
  return { success: true };
}

async function playbackTranspose(_app, _data) {
  return { success: true };
}

async function playbackSetVolume(_app, _data) {
  return { success: true };
}

export function register(registry, app) {
  registry.register('playback_start', (data) => playbackStart(app, data));
  registry.register('playback_stop', () => playbackStop(app));
  registry.register('playback_pause', () => playbackPause(app));
  registry.register('playback_resume', () => playbackResume(app));
  registry.register('playback_seek', (data) => playbackSeek(app, data));
  registry.register('playback_status', () => playbackStatus(app));
  registry.register('playback_set_loop', (data) => playbackSetLoop(app, data));
  registry.register('playback_set_tempo', (data) => playbackSetTempo(app, data));
  registry.register('playback_transpose', (data) => playbackTranspose(app, data));
  registry.register('playback_set_volume', (data) => playbackSetVolume(app, data));
}
