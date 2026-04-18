/**
 * @file src/midi/domain/playback/PlaybackControlCommands.js
 * @description Playback control handlers extracted from
 * `PlaybackCommands.js` (P0-1.1).
 *
 * Registered commands:
 *   - `playback_start`        — load file, auto-restore routings, start
 *   - `playback_stop`         — stop and reset to position 0
 *   - `playback_pause` / `_resume`
 *   - `playback_seek`         — move to absolute position (seconds)
 *   - `playback_status`       — snapshot of player state
 *   - `playback_set_loop`     — toggle loop-on-end behaviour
 *   - `playback_set_tempo` / `_transpose` / `_set_volume` — placeholders
 */
import { ValidationError, ConfigurationError } from '../../../core/errors/index.js';

/**
 * Load a file, restore any persisted per-channel routings (with
 * split-routing support), pick a default output device when none was
 * supplied, and start playback.
 *
 * @param {Object} app
 * @param {{fileId:(string|number), outputDevice?:string}} data
 * @returns {Promise<{success:true, fileInfo:Object, outputDevice:string,
 *   loadedRoutings:number}>}
 * @throws {ValidationError|ConfigurationError}
 */
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

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function playbackStop(app) {
  app.midiPlayer.stop();
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function playbackPause(app) {
  app.midiPlayer.pause();
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<{success:true}>}
 */
async function playbackResume(app) {
  app.midiPlayer.resume();
  return { success: true };
}

/**
 * @param {Object} app
 * @param {{position:number}} data - Position in seconds.
 * @returns {Promise<{success:true}>}
 */
async function playbackSeek(app, data) {
  app.midiPlayer.seek(data.position);
  return { success: true };
}

/**
 * @param {Object} app
 * @returns {Promise<Object>}
 */
async function playbackStatus(app) {
  return app.midiPlayer.getStatus();
}

/**
 * @param {Object} app
 * @param {{enabled:boolean}} data
 * @returns {Promise<{success:true}>}
 */
async function playbackSetLoop(app, data) {
  app.midiPlayer.setLoop(data.enabled);
  return { success: true };
}

/**
 * Change the playback tempo in BPM. Delegates to
 * {@link MidiPlayer#setPlaybackTempo}: applies a rate multiplier to the
 * scheduler so playback speeds up or slows down proportionally and
 * forwards the new tempo to the MIDI Clock generator so synced external
 * gear follows. The resulting rate is clamped to [0.25×, 4×].
 *
 * Accepts `bpm` (preferred) or `tempo` as the payload key for backward
 * compatibility with older clients.
 *
 * @param {Object} app
 * @param {{bpm?:number, tempo?:number}} data
 * @returns {Promise<{success:boolean, bpm:number, playbackRate:number,
 *   originalTempo:?number}>}
 */
async function playbackSetTempo(app, data) {
  const bpm = Number(data?.bpm ?? data?.tempo);
  return app.midiPlayer.setPlaybackTempo(bpm);
}

/**
 * Placeholder.
 * TODO: implement using {@link MidiAdaptationService#transposeChannels}.
 *
 * @returns {Promise<{success:true}>}
 */
async function playbackTranspose(_app, _data) {
  return { success: true };
}

/**
 * Master volume broadcast. Sends CC #7 (Channel Volume) with the given
 * value on every MIDI channel of every currently-connected output
 * device. Value range is the standard MIDI 0..127; out-of-range values
 * are clamped so a stray slider position cannot corrupt the bus.
 *
 * @param {Object} app
 * @param {{volume:(number|string)}} data
 * @returns {Promise<{success:boolean, volume:number, targets:number}>}
 *   `targets` is the number of devices actually reached.
 */
async function playbackSetVolume(app, data) {
  let value = Number(data?.volume);
  if (!Number.isFinite(value)) value = 100;
  value = Math.max(0, Math.min(127, Math.round(value)));

  const devices = app.deviceManager?.getDeviceList?.() || [];
  let targets = 0;
  for (const device of devices) {
    if (!device.output || device.enabled === false) continue;
    let sentAny = false;
    for (let channel = 0; channel < 16; channel++) {
      if (app.deviceManager.sendMessage(device.id, 'cc', { channel, controller: 7, value })) {
        sentAny = true;
      }
    }
    if (sentAny) targets++;
  }

  return { success: true, volume: value, targets };
}

/**
 * @param {import('../../../api/CommandRegistry.js').default} registry
 * @param {Object} app
 * @returns {void}
 */
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
