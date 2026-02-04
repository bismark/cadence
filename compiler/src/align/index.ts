/**
 * Forced alignment module for synchronizing EPUB text with audio.
 *
 * MIT License
 * Copyright (c) 2023 Shane Friedman (original Storyteller algorithm)
 * Copyright (c) 2026 Ryan Johnson (modifications)
 * https://gitlab.com/storyteller-platform/storyteller
 */

export {
  AUDIO_EXTENSIONS,
  type AudioTrack,
  type ChapterInfo,
  extractChapters,
  getChapters,
  getTrackDuration,
  getTracksFromDirectory,
  isAudioFile,
  prepareAudioTracks,
  splitTrack,
} from './audio.js';
export { findNearestMatch } from './fuzzy.js';
export {
  expandEmptySentenceRanges,
  findEndTimestamp,
  getChapterDuration,
  getSentenceRanges,
  interpolateSentenceRanges,
  type SentenceRange,
  type Transcription,
  type WordTimelineEntry,
} from './getSentenceRanges.js';
export { tokenizeSentences } from './nlp.js';
export { transcribe, transcribeMultiple } from './parakeet.js';
export { BLOCKS, CONTENT_SECTIONING, TABLE_PARTS, TEXT_CONTENT } from './semantics.js';
export {
  extractSentences,
  extractSentencesFromBody,
  tagSentencesInXhtml,
} from './sentences.js';
