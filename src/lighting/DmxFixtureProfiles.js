// src/lighting/DmxFixtureProfiles.js
// Library of common DMX fixture profiles for ArtNet and sACN drivers
// Each profile describes the channel layout of a DMX fixture

const DMX_PROFILES = {
  // ==================== GENERIC ====================
  'generic_rgb': {
    name: 'Generic RGB',
    channels: 3,
    map: { r: 0, g: 1, b: 2 }
  },
  'generic_rgbw': {
    name: 'Generic RGBW',
    channels: 4,
    map: { r: 0, g: 1, b: 2, w: 3 }
  },
  'generic_rgbwa': {
    name: 'Generic RGBWA',
    channels: 5,
    map: { r: 0, g: 1, b: 2, w: 3, a: 4 }
  },
  'generic_rgbwau': {
    name: 'Generic RGBWAUV',
    channels: 6,
    map: { r: 0, g: 1, b: 2, w: 3, a: 4, uv: 5 }
  },
  'generic_dimmer': {
    name: 'Generic Dimmer',
    channels: 1,
    map: { dimmer: 0 }
  },

  // ==================== PAR CANS ====================
  'par_rgb_7ch': {
    name: 'LED PAR RGB 7ch',
    channels: 7,
    map: { dimmer: 0, r: 1, g: 2, b: 3, strobe: 4, mode: 5, speed: 6 }
  },
  'par_rgbw_8ch': {
    name: 'LED PAR RGBW 8ch',
    channels: 8,
    map: { dimmer: 0, r: 1, g: 2, b: 3, w: 4, strobe: 5, mode: 6, speed: 7 }
  },

  // ==================== WASH LIGHTS ====================
  'wash_rgbw_6ch': {
    name: 'LED Wash RGBW 6ch',
    channels: 6,
    map: { pan: 0, tilt: 1, dimmer: 2, r: 3, g: 4, b: 5 }
  },

  // ==================== MOVING HEADS ====================
  'movinghead_basic_16ch': {
    name: 'Moving Head 16ch',
    channels: 16,
    map: {
      pan: 0, pan_fine: 1, tilt: 2, tilt_fine: 3,
      speed: 4, dimmer: 5, strobe: 6,
      r: 7, g: 8, b: 9, w: 10,
      color_macro: 11, gobo: 12, gobo_rotation: 13,
      prism: 14, focus: 15
    }
  },

  // ==================== LED BARS ====================
  'led_bar_rgb_3ch': {
    name: 'LED Bar RGB 3ch',
    channels: 3,
    map: { r: 0, g: 1, b: 2 }
  },
  'led_bar_rgb_4ch': {
    name: 'LED Bar RGB+Dimmer 4ch',
    channels: 4,
    map: { dimmer: 0, r: 1, g: 2, b: 3 }
  },

  // ==================== LASER ====================
  'laser_basic_3ch': {
    name: 'Laser Basic 3ch',
    channels: 3,
    map: { mode: 0, pattern: 1, speed: 2 }
  },

  // ==================== FOG / HAZE ====================
  'fog_basic_2ch': {
    name: 'Fog Machine 2ch',
    channels: 2,
    map: { output: 0, fan: 1 }
  },

  // ==================== STROBE ====================
  'strobe_basic_2ch': {
    name: 'Strobe 2ch',
    channels: 2,
    map: { dimmer: 0, speed: 1 }
  },
  'strobe_rgb_5ch': {
    name: 'RGB Strobe 5ch',
    channels: 5,
    map: { dimmer: 0, speed: 1, r: 2, g: 3, b: 4 }
  }
};

/**
 * Get a fixture profile by name
 */
export function getProfile(name) {
  return DMX_PROFILES[name] || null;
}

/**
 * Get all available profiles
 */
export function listProfiles() {
  return Object.entries(DMX_PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    channels: profile.channels
  }));
}

/**
 * Map RGB color to a fixture profile's channels
 * @returns Array of [channel_offset, value] pairs
 */
export function mapColorToFixture(profileName, r, g, b, brightness = 255, extra = {}) {
  const profile = DMX_PROFILES[profileName];
  if (!profile) return [];

  const result = [];
  const map = profile.map;

  if (map.r !== undefined) result.push([map.r, r]);
  if (map.g !== undefined) result.push([map.g, g]);
  if (map.b !== undefined) result.push([map.b, b]);
  if (map.dimmer !== undefined) result.push([map.dimmer, brightness]);
  if (map.w !== undefined) result.push([map.w, extra.white || 0]);
  if (map.a !== undefined) result.push([map.a, extra.amber || 0]);
  if (map.uv !== undefined) result.push([map.uv, extra.uv || 0]);
  if (map.strobe !== undefined) result.push([map.strobe, extra.strobe || 0]);
  if (map.pan !== undefined) result.push([map.pan, extra.pan || 128]);
  if (map.tilt !== undefined) result.push([map.tilt, extra.tilt || 128]);

  return result;
}

export default DMX_PROFILES;
