// src/api/commands/playback/PlaybackRoutingCommands.js
// Extracted from PlaybackCommands.js — routing validation + channel control (P0-1.4).
import { ValidationError, NotFoundError, MidiError } from '../../../core/errors/index.js';
import { getMidiConverter } from './midiConverterCache.js';

async function playbackGetChannels(app) {
  return {
    channels: app.midiPlayer.getChannelRouting()
  };
}

async function playbackSetChannelRouting(app, data) {
  if (data.channel === undefined || data.channel === null) {
    throw new ValidationError('channel is required', 'channel');
  }
  if (!data.deviceId) {
    throw new ValidationError('deviceId is required', 'deviceId');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('channel must be between 0 and 15', 'channel');
  }

  const targetChannel = data.targetChannel !== undefined ? parseInt(data.targetChannel) : channel;
  if (isNaN(targetChannel) || targetChannel < 0 || targetChannel > 15) {
    throw new ValidationError('targetChannel must be between 0 and 15', 'channel');
  }

  app.midiPlayer.setChannelRouting(channel, data.deviceId, targetChannel);

  return {
    success: true,
    channel: data.channel,
    channelDisplay: data.channel + 1,
    deviceId: data.deviceId,
    targetChannel: targetChannel
  };
}

async function playbackClearChannelRouting(app) {
  app.midiPlayer.clearChannelRouting();
  return { success: true };
}

async function playbackMuteChannel(app, data) {
  if (data.channel === undefined) {
    throw new ValidationError('Missing channel parameter', 'channel');
  }

  const channel = parseInt(data.channel);
  if (isNaN(channel) || channel < 0 || channel > 15) {
    throw new ValidationError('Invalid channel (must be 0-15)', 'channel');
  }

  if (data.muted) {
    app.midiPlayer.muteChannel(channel);
  } else {
    app.midiPlayer.unmuteChannel(channel);
  }

  return {
    success: true,
    channel: channel,
    channelDisplay: channel + 1,
    muted: data.muted
  };
}

async function playbackValidateRouting(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const file = app.database.getFile(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  const midiConverter = getMidiConverter(app);
  let midiData;
  try {
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  const activeChannels = new Set();
  if (midiData && midiData.tracks) {
    for (const track of midiData.tracks) {
      const events = track.events || track;
      for (const event of events) {
        if ((event.type === 'noteOn' || event.type === 'noteOff') && event.channel !== undefined) {
          activeChannels.add(event.channel);
        }
      }
    }
  }

  const savedRoutings = app.database.getRoutingsByFile(data.fileId);
  const routingMap = new Map();
  for (const r of savedRoutings) {
    if (r.channel !== null && r.channel !== undefined) {
      routingMap.set(r.channel, r);
    }
  }

  const deviceList = app.deviceManager?.getDeviceList?.() || [];
  const connectedDevices = new Set(deviceList.filter(d => d.output).map(d => d.id));

  const channels = [];
  const warnings = [];
  let allRouted = true;
  let allOnline = true;

  for (const channel of [...activeChannels].sort((a, b) => a - b)) {
    const routing = routingMap.get(channel);
    if (!routing || !routing.device_id) {
      channels.push({ channel, channelDisplay: channel + 1, status: 'unrouted' });
      warnings.push(`Channel ${channel + 1} has no routing`);
      allRouted = false;
      allOnline = false;
    } else {
      const deviceOnline = connectedDevices.has(routing.device_id);
      channels.push({
        channel,
        channelDisplay: channel + 1,
        status: 'routed',
        deviceId: routing.device_id,
        instrumentName: routing.instrument_name,
        deviceOnline
      });
      if (!deviceOnline) {
        warnings.push(`Channel ${channel + 1}: device "${routing.instrument_name || routing.device_id}" is offline`);
        allOnline = false;
      }
    }
  }

  return {
    success: true,
    fileId: data.fileId,
    channels,
    allRouted,
    allOnline,
    warnings
  };
}

async function playbackSetDisconnectPolicy(app, data) {
  const validPolicies = ['skip', 'pause', 'mute'];
  if (!data.policy || !validPolicies.includes(data.policy)) {
    throw new ValidationError(`Invalid policy. Must be one of: ${validPolicies.join(', ')}`, 'policy');
  }
  app.midiPlayer.disconnectedPolicy = data.policy;
  app.logger.info(`Disconnect policy set to: ${data.policy}`);
  return { success: true, policy: data.policy };
}

export function register(registry, app) {
  registry.register('playback_get_channels', () => playbackGetChannels(app));
  registry.register('playback_set_channel_routing', (data) => playbackSetChannelRouting(app, data));
  registry.register('playback_clear_channel_routing', () => playbackClearChannelRouting(app));
  registry.register('playback_mute_channel', (data) => playbackMuteChannel(app, data));
  registry.register('playback_validate_routing', (data) => playbackValidateRouting(app, data));
  registry.register('playback_set_disconnect_policy', (data) => playbackSetDisconnectPolicy(app, data));
}
