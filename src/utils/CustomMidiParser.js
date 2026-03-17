/**
 * Custom MIDI Parser - Fallback parser if midi-file has issues
 * Focuses on correctly reading channel information
 */

class CustomMidiParser {
  constructor() {
    this.logger = console;
  }

  /**
   * Parse MIDI buffer
   * @param {Buffer} buffer - MIDI file buffer
   * @returns {Object} Parsed MIDI data
   */
  parse(buffer) {
    let offset = 0;

    // Read header
    const header = this.readHeader(buffer, offset);
    offset += 14;

    if (header.chunkId !== 'MThd') {
      throw new Error('Invalid MIDI file: Missing MThd header');
    }

    this.logger.info(`Parsing MIDI: format=${header.format}, tracks=${header.numTracks}, division=${header.division}`);

    // Read tracks
    const tracks = [];
    for (let i = 0; i < header.numTracks; i++) {
      const track = this.readTrack(buffer, offset);
      tracks.push(track);
      offset += track.chunkSize + 8; // chunk header (8) + data
    }

    return {
      header: {
        format: header.format,
        numTracks: header.numTracks,
        ticksPerBeat: header.division
      },
      tracks: tracks
    };
  }

  /**
   * Read MIDI header
   */
  readHeader(buffer, offset) {
    return {
      chunkId: buffer.toString('ascii', offset, offset + 4),
      chunkSize: buffer.readUInt32BE(offset + 4),
      format: buffer.readUInt16BE(offset + 8),
      numTracks: buffer.readUInt16BE(offset + 10),
      division: buffer.readUInt16BE(offset + 12)
    };
  }

  /**
   * Read MIDI track
   */
  readTrack(buffer, offset) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32BE(offset + 4);

    if (chunkId !== 'MTrk') {
      throw new Error(`Invalid track chunk: expected "MTrk", got "${chunkId}"`);
    }

    const trackEnd = offset + 8 + chunkSize;
    offset += 8; // Skip chunk header

    const events = [];
    let runningStatus = null;
    let currentTime = 0;

    while (offset < trackEnd) {
      // Read delta time (variable length)
      const deltaTime = this.readVariableLength(buffer, offset);
      offset += deltaTime.bytesRead;
      currentTime += deltaTime.value;

      // Read event
      const eventResult = this.readEvent(buffer, offset, currentTime, runningStatus);
      offset += eventResult.bytesRead;

      if (eventResult.event) {
        events.push(eventResult.event);
      }

      // Update running status
      if (eventResult.status) {
        runningStatus = eventResult.status;
      }
    }

    return {
      chunkSize,
      events
    };
  }

  /**
   * Read variable length quantity
   */
  readVariableLength(buffer, offset) {
    let value = 0;
    let bytesRead = 0;
    const maxBytes = 4; // Variable length quantities are at most 4 bytes in MIDI

    while (bytesRead < maxBytes) {
      if (offset + bytesRead >= buffer.length) {
        break; // Prevent buffer over-read
      }
      const byte = buffer.readUInt8(offset + bytesRead);
      bytesRead++;

      value = (value << 7) | (byte & 0x7F);

      if ((byte & 0x80) === 0) {
        break;
      }
    }

    return { value, bytesRead };
  }

  /**
   * Read MIDI event
   */
  readEvent(buffer, offset, time, runningStatus) {
    if (offset >= buffer.length) {
      return { bytesRead: 1, status: null, event: null };
    }
    let statusByte = buffer.readUInt8(offset);
    let bytesRead = 1;
    let actualStatus = statusByte;

    // Check for running status
    if (statusByte < 0x80) {
      // Running status - reuse previous status
      actualStatus = runningStatus;
      bytesRead = 0; // Don't consume the byte
    }

    // Meta event (0xFF)
    if (actualStatus === 0xFF) {
      const type = buffer.readUInt8(offset + bytesRead);
      bytesRead++;

      const length = this.readVariableLength(buffer, offset + bytesRead);
      bytesRead += length.bytesRead;

      const data = [];
      for (let i = 0; i < length.value; i++) {
        data.push(buffer.readUInt8(offset + bytesRead + i));
      }
      bytesRead += length.value;

      return {
        bytesRead,
        status: null, // Meta events don't affect running status
        event: this.parseMetaEvent(type, data, time)
      };
    }

    // SysEx event (0xF0 or 0xF7)
    if (actualStatus === 0xF0 || actualStatus === 0xF7) {
      const length = this.readVariableLength(buffer, offset + bytesRead);
      bytesRead += length.bytesRead + length.value;

      return {
        bytesRead,
        status: null,
        event: {
          deltaTime: 0,
          type: 'sysex',
          time
        }
      };
    }

    // Channel event (0x80 - 0xEF)
    if (actualStatus >= 0x80 && actualStatus <= 0xEF) {
      const eventType = actualStatus & 0xF0;
      const channel = actualStatus & 0x0F; // ✅ CRITICAL: Extract channel

      let data1, data2;

      // Determine how many data bytes to read
      if (eventType === 0xC0 || eventType === 0xD0) {
        // Program change or channel aftertouch - 1 data byte
        data1 = buffer.readUInt8(offset + bytesRead);
        bytesRead++;
      } else {
        // Note on/off, CC, pitch bend, poly aftertouch - 2 data bytes
        data1 = buffer.readUInt8(offset + bytesRead);
        data2 = buffer.readUInt8(offset + bytesRead + 1);
        bytesRead += 2;
      }

      return {
        bytesRead,
        status: actualStatus,
        event: this.parseChannelEvent(eventType, channel, data1, data2, time)
      };
    }

    // Unknown event
    this.logger.warn(`Unknown MIDI event: 0x${actualStatus != null ? actualStatus.toString(16) : 'null'}`);
    return {
      bytesRead: 1,
      status: null,
      event: null
    };
  }

  /**
   * Parse channel event
   */
  parseChannelEvent(eventType, channel, data1, data2, time) {
    const event = {
      deltaTime: 0,
      time,
      channel // ✅ ALWAYS include channel
    };

    switch (eventType) {
      case 0x80: // Note off
        event.type = 'noteOff';
        event.noteNumber = data1;
        event.velocity = data2;
        break;

      case 0x90: // Note on
        event.type = 'noteOn';
        event.noteNumber = data1;
        event.velocity = data2;
        break;

      case 0xA0: // Polyphonic aftertouch
        event.type = 'polyAftertouch';
        event.noteNumber = data1;
        event.pressure = data2;
        break;

      case 0xB0: // Control change
        event.type = 'controller';
        event.controllerType = data1;
        event.value = data2;
        break;

      case 0xC0: // Program change
        event.type = 'programChange';
        event.programNumber = data1;
        break;

      case 0xD0: // Channel aftertouch
        event.type = 'channelAftertouch';
        event.amount = data1;
        break;

      case 0xE0: // Pitch bend
        event.type = 'pitchBend';
        // Combine 2 bytes into 14-bit value (-8192 to 8191)
        event.value = ((data2 << 7) | data1) - 8192;
        break;

      default:
        event.type = 'unknown';
    }

    return event;
  }

  /**
   * Parse meta event
   */
  parseMetaEvent(type, data, time) {
    const event = {
      deltaTime: 0,
      type: 'meta',
      time
    };

    switch (type) {
      case 0x00:
        event.metaType = 'sequenceNumber';
        break;

      case 0x01:
        event.metaType = 'text';
        event.text = String.fromCharCode(...data);
        break;

      case 0x02:
        event.metaType = 'copyright';
        event.text = String.fromCharCode(...data);
        break;

      case 0x03:
        event.metaType = 'trackName';
        event.text = String.fromCharCode(...data);
        break;

      case 0x04:
        event.metaType = 'instrumentName';
        event.text = String.fromCharCode(...data);
        break;

      case 0x2F:
        event.metaType = 'endOfTrack';
        break;

      case 0x51: // Set tempo
        event.metaType = 'setTempo';
        event.microsecondsPerBeat = (data[0] << 16) | (data[1] << 8) | data[2];
        break;

      case 0x58: // Time signature
        event.metaType = 'timeSignature';
        event.numerator = data[0];
        event.denominator = Math.pow(2, data[1]);
        event.metronome = data[2];
        event.thirtyseconds = data[3];
        break;

      case 0x59: // Key signature
        event.metaType = 'keySignature';
        event.key = data[0];
        event.scale = data[1];
        break;

      default:
        event.metaType = 'unknown';
    }

    return event;
  }
}

export default CustomMidiParser;
