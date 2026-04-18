// src/midi/domain/playback/PlaybackAnalysisCommands.js
// Extracted from PlaybackCommands.js — analysis/suggestions handlers (P0-1.2).
import ScoringConfig from '../../../midi/ScoringConfig.js';
import { ValidationError, NotFoundError, MidiError } from '../../../core/errors/index.js';
import { getMidiConverter } from './midiConverterCache.js';

async function analyzeChannel(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }
  if (data.channel === undefined) {
    throw new ValidationError('channel is required', 'channel');
  }

  const file = app.fileRepository.findById(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  const analysis = app.adaptationService.analyzeChannel(midiData, data.channel, data.fileId);

  return {
    success: true,
    channel: data.channel,
    analysis
  };
}

function applyScoringOverrides(overrides) {
  const original = JSON.parse(JSON.stringify({
    weights: ScoringConfig.weights,
    scoreThresholds: ScoringConfig.scoreThresholds,
    penalties: ScoringConfig.penalties,
    bonuses: ScoringConfig.bonuses,
    percussion: ScoringConfig.percussion,
    splitting: ScoringConfig.splitting,
    routing: ScoringConfig.routing
  }));

  if (overrides.weights) {
    const w = overrides.weights;
    const keys = ['noteRange', 'programMatch', 'instrumentType', 'polyphony', 'ccSupport'];
    for (const k of keys) {
      if (w[k] !== undefined) {
        ScoringConfig.weights[k] = Math.max(0, Math.min(100, Math.round(Number(w[k]))));
      }
    }
    ScoringConfig.bonuses.perfectNoteRange = ScoringConfig.weights.noteRange;
    ScoringConfig.bonuses.perfectProgramMatch = ScoringConfig.weights.programMatch;
  }

  if (overrides.scoreThresholds) {
    const t = overrides.scoreThresholds;
    if (t.acceptable !== undefined) ScoringConfig.scoreThresholds.acceptable = Math.max(0, Math.min(100, Number(t.acceptable)));
    if (t.minimum !== undefined) ScoringConfig.scoreThresholds.minimum = Math.max(0, Math.min(100, Number(t.minimum)));
  }

  if (overrides.penalties) {
    const p = overrides.penalties;
    if (p.transpositionPerOctave !== undefined) ScoringConfig.penalties.transpositionPerOctave = Math.max(0, Math.min(20, Number(p.transpositionPerOctave)));
    if (p.maxTranspositionOctaves !== undefined) ScoringConfig.penalties.maxTranspositionOctaves = Math.max(1, Math.min(6, Number(p.maxTranspositionOctaves)));
  }

  if (overrides.bonuses) {
    const b = overrides.bonuses;
    if (b.sameCategoryMatch !== undefined) ScoringConfig.bonuses.sameCategoryMatch = Math.max(0, Math.min(30, Number(b.sameCategoryMatch)));
    if (b.sameFamilyMatch !== undefined) ScoringConfig.bonuses.sameFamilyMatch = Math.max(0, Math.min(25, Number(b.sameFamilyMatch)));
    if (b.exactTypeMatch !== undefined) ScoringConfig.bonuses.exactTypeMatch = Math.max(0, Math.min(30, Number(b.exactTypeMatch)));
  }

  if (overrides.percussion) {
    const perc = overrides.percussion;
    if (perc.drumChannelDrumBonus !== undefined) ScoringConfig.percussion.drumChannelDrumBonus = Math.max(0, Math.min(30, Number(perc.drumChannelDrumBonus)));
    if (perc.drumChannelNonDrumPenalty !== undefined) ScoringConfig.percussion.drumChannelNonDrumPenalty = Math.max(-100, Math.min(0, Number(perc.drumChannelNonDrumPenalty)));
    if (perc.nonDrumChannelDrumPenalty !== undefined) ScoringConfig.percussion.nonDrumChannelDrumPenalty = Math.max(-100, Math.min(0, Number(perc.nonDrumChannelDrumPenalty)));
    if (perc.drumChannelWeights) {
      const dw = perc.drumChannelWeights;
      for (const k of ['noteRange', 'programMatch', 'instrumentType', 'polyphony', 'ccSupport']) {
        if (dw[k] !== undefined) ScoringConfig.percussion.drumChannelWeights[k] = Math.max(0, Math.min(100, Math.round(Number(dw[k]))));
      }
    }
  }

  if (overrides.splitting) {
    const s = overrides.splitting;
    if (s.minQuality !== undefined) ScoringConfig.splitting.minQuality = Math.max(0, Math.min(100, Number(s.minQuality)));
    if (s.maxInstruments !== undefined) ScoringConfig.splitting.maxInstruments = Math.max(2, Math.min(8, Number(s.maxInstruments)));
    if (s.triggerBelowScore !== undefined) ScoringConfig.splitting.triggerBelowScore = Math.max(0, Math.min(100, Number(s.triggerBelowScore)));
  }

  if (overrides.routing) {
    const r = overrides.routing;
    if (r.allowInstrumentReuse !== undefined) ScoringConfig.routing.allowInstrumentReuse = !!r.allowInstrumentReuse;
    if (r.sharedInstrumentPenalty !== undefined) ScoringConfig.routing.sharedInstrumentPenalty = Math.max(0, Math.min(30, Math.round(Number(r.sharedInstrumentPenalty))));
    if (r.autoSplitAvoidTransposition !== undefined) ScoringConfig.routing.autoSplitAvoidTransposition = !!r.autoSplitAvoidTransposition;
    if (r.preferSingleInstrument !== undefined) ScoringConfig.routing.preferSingleInstrument = !!r.preferSingleInstrument;
    if (r.preferSimilarGMType !== undefined) ScoringConfig.routing.preferSimilarGMType = !!r.preferSimilarGMType;
    if (r.drumFallback && typeof r.drumFallback === 'object') {
      ScoringConfig.routing.drumFallback = { ...r.drumFallback };
    }
  }

  return original;
}

function restoreScoringConfig(original) {
  Object.assign(ScoringConfig.weights, original.weights);
  Object.assign(ScoringConfig.scoreThresholds, original.scoreThresholds);
  Object.assign(ScoringConfig.penalties, original.penalties);
  Object.assign(ScoringConfig.bonuses, original.bonuses);
  Object.assign(ScoringConfig.percussion, original.percussion);
  if (ScoringConfig.percussion.drumChannelWeights && original.percussion.drumChannelWeights) {
    Object.assign(ScoringConfig.percussion.drumChannelWeights, original.percussion.drumChannelWeights);
  }
  Object.assign(ScoringConfig.splitting, original.splitting);
}

async function generateAssignmentSuggestions(app, data) {
  if (!data.fileId) {
    throw new ValidationError('fileId is required', 'fileId');
  }

  const options = {
    topN: data.topN || 5,
    minScore: data.minScore || 30,
    excludeVirtual: data.excludeVirtual || false,
    includeMatrix: data.includeMatrix || false
  };

  const file = app.fileRepository.findById(data.fileId);
  if (!file) {
    throw new NotFoundError('File', data.fileId);
  }

  let midiData;
  try {
    const midiConverter = getMidiConverter(app);
    const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'base64');
    midiData = midiConverter.midiToJson(buffer);
  } catch (error) {
    throw new MidiError(`Failed to parse MIDI file: ${error.message}`);
  }

  let originalConfig = null;
  if (data.scoringOverrides) {
    originalConfig = applyScoringOverrides(data.scoringOverrides);
    app.logger.info('Scoring overrides applied for this request');
  }

  let result;
  try {
    result = await app.adaptationService.generateSuggestions(midiData, options);
  } finally {
    if (originalConfig) {
      restoreScoringConfig(originalConfig);
    }
  }

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      suggestions: {},
      autoSelection: {}
    };
  }

  const response = {
    success: true,
    suggestions: result.suggestions,
    lowScoreSuggestions: result.lowScoreSuggestions || {},
    autoSelection: result.autoSelection,
    splitProposals: result.splitProposals || {},
    channelAnalyses: result.channelAnalyses,
    confidenceScore: result.confidenceScore,
    allInstruments: result.allInstruments || [],
    stats: result.stats
  };

  if (result.matrixScores) {
    response.matrixScores = result.matrixScores;
    response.instrumentList = result.instrumentList;
  }

  return response;
}

export function register(registry, app) {
  registry.register('analyze_channel', (data) => analyzeChannel(app, data));
  registry.register('generate_assignment_suggestions', (data) => generateAssignmentSuggestions(app, data));
}
