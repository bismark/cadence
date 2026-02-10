/**
 * Sentence range extraction and interpolation for forced alignment.
 *
 * MIT License
 * Copyright (c) 2023 Shane Friedman (original)
 * Copyright (c) 2026 Ryan Johnson (modifications)
 * From: https://gitlab.com/storyteller-platform/storyteller
 */

import { getTrackDuration } from './audio.js';
import { findNearestMatch } from './fuzzy.js';
import { tokenizeSentences } from './nlp.js';

export type WordTimelineEntry = {
  text?: string;
  startTime: number;
  endTime: number;
  startOffsetUtf16?: number;
  endOffsetUtf16?: number;
  audiofile: string;
};

export type Transcription = {
  transcript: string;
  wordTimeline: WordTimelineEntry[];
};

export type SentenceRange = {
  id: number;
  start: number;
  end: number;
  audiofile: string;
};

function getSentencesWithOffsets(text: string) {
  const sentences = tokenizeSentences(text);
  const sentencesWithOffsets: string[] = [];
  let lastSentenceEnd = 0;
  for (const sentence of sentences) {
    const sentenceStart = text.indexOf(sentence, lastSentenceEnd);
    if (sentenceStart > lastSentenceEnd) {
      sentencesWithOffsets.push(text.slice(lastSentenceEnd, sentenceStart));
    }

    sentencesWithOffsets.push(sentence);
    lastSentenceEnd = sentenceStart + sentence.length;
  }

  if (text.length > lastSentenceEnd) {
    sentencesWithOffsets.push(text.slice(lastSentenceEnd));
  }

  return sentencesWithOffsets;
}

function findStartTimestamp(matchStartIndex: number, transcription: Transcription) {
  const entry = transcription.wordTimeline.find(
    (entry) => (entry.endOffsetUtf16 ?? 0) > matchStartIndex,
  );
  if (!entry) return null;
  return {
    start: entry.startTime,
    end: entry.endTime,
    audiofile: entry.audiofile,
  };
}

function findEndTimestampEntry(matchEndIndex: number, transcription: Transcription) {
  return (
    transcription.wordTimeline.findLast((entry) => (entry.startOffsetUtf16 ?? 0) < matchEndIndex) ??
    null
  );
}

function findEndTimestampForAudiofile(
  matchEndIndex: number,
  audiofile: string,
  transcription: Transcription,
) {
  return (
    transcription.wordTimeline.findLast(
      (entry) => entry.audiofile === audiofile && (entry.startOffsetUtf16 ?? 0) < matchEndIndex,
    ) ?? null
  );
}

export function findEndTimestamp(matchEndIndex: number, transcription: Transcription) {
  return findEndTimestampEntry(matchEndIndex, transcription)?.endTime ?? null;
}

function getWindowIndexFromOffset(window: string[], offset: number) {
  let index = 0;
  while (index < window.length - 1 && offset >= window[index]?.length) {
    offset -= window[index]?.length;
    index += 1;
  }
  return { index, offset };
}

function collapseWhitespace(input: string) {
  return input.replaceAll(/\s+/g, ' ');
}

export async function getSentenceRanges(
  startSentence: number,
  transcription: Transcription,
  sentences: string[],
  chapterOffset: number,
  lastSentenceRange: SentenceRange | null,
) {
  const sentenceRanges: SentenceRange[] = [];
  const fullTranscriptionText = transcription.transcript;
  const transcriptionText = fullTranscriptionText.slice(chapterOffset);
  const transcriptionSentences = getSentencesWithOffsets(transcriptionText).map((sentence) =>
    sentence.toLowerCase(),
  );

  let startSentenceEntry = startSentence;

  const sentenceEntries = sentences
    .map((sentence, index) => [index, sentence] as const)
    .filter(([index, sentence]) => {
      if (sentence.replaceAll(/[.-_()[\],/?!@#$%^^&*`~;:='"<>+ˌˈ]/g, '').length <= 3) {
        // We have to adjust the start sentence, since we're going to
        // be iterating over the filtered sentenceEntries
        if (index < startSentence) startSentenceEntry--;
        return false;
      }
      return true;
    });

  let transcriptionWindowIndex = 0;
  let transcriptionWindowOffset = 0;
  let lastGoodTranscriptionWindow = 0;
  let notFound = 0;
  let sentenceIndex = startSentenceEntry;
  let lastMatchEnd = chapterOffset;

  while (sentenceIndex < sentenceEntries.length) {
    const [sentenceId, sentence] = sentenceEntries[sentenceIndex]!;

    const transcriptionWindowList = transcriptionSentences.slice(
      transcriptionWindowIndex,
      transcriptionWindowIndex + 10,
    );
    const transcriptionWindow = transcriptionWindowList.join('').slice(transcriptionWindowOffset);

    const query = collapseWhitespace(sentence.trim()).toLowerCase();

    const firstMatch = findNearestMatch(
      query,
      transcriptionWindow,
      Math.max(Math.floor(0.25 * query.length), 1),
    );

    if (!firstMatch) {
      sentenceIndex += 1;
      notFound += 1;
      if (notFound === 3 || sentenceIndex === sentenceEntries.length) {
        transcriptionWindowIndex += 1;
        if (transcriptionWindowIndex === lastGoodTranscriptionWindow + 30) {
          transcriptionWindowIndex = lastGoodTranscriptionWindow;
          notFound = 0;
          continue;
        }
        sentenceIndex -= notFound;
        notFound = 0;
      }
      continue;
    }

    const transcriptionOffset = transcriptionSentences
      .slice(0, transcriptionWindowIndex)
      .join('').length;

    const startResult = findStartTimestamp(
      firstMatch.index + transcriptionOffset + transcriptionWindowOffset + chapterOffset,
      transcription,
    );
    if (!startResult) {
      sentenceIndex += 1;
      continue;
    }
    const start = startResult.start;
    const audiofile = startResult.audiofile;

    const matchEndIndex =
      firstMatch.index +
      firstMatch.match.length +
      transcriptionOffset +
      transcriptionWindowOffset +
      chapterOffset;

    const endEntry = findEndTimestampEntry(matchEndIndex, transcription);
    let end = endEntry?.endTime ?? startResult.end;

    if (endEntry && endEntry.audiofile !== audiofile) {
      const fallbackEntry = findEndTimestampForAudiofile(matchEndIndex, audiofile, transcription);
      end = fallbackEntry?.endTime ?? startResult.end;
    }

    // Adjust previous sentence's end time to align with current sentence's start
    // Note: We preserve actual STT timestamps (don't force start=0) because we
    // concatenate audio and apply offsets later. This handles audio with intros.
    if (sentenceRanges.length > 0) {
      const previousSentenceRange = sentenceRanges[sentenceRanges.length - 1]!;
      const previousAudiofile = previousSentenceRange.audiofile;

      if (audiofile === previousAudiofile) {
        if (previousSentenceRange.id === sentenceId - 1) {
          previousSentenceRange.end = start;
        }
      } else {
        // Audio file changed - cap previous sentence at track end
        if (previousSentenceRange.id === sentenceId - 1) {
          const lastTrackDuration = await getTrackDuration(previousAudiofile);
          previousSentenceRange.end = lastTrackDuration;
        }
      }
    } else if (lastSentenceRange !== null) {
      if (audiofile === lastSentenceRange.audiofile) {
        if (sentenceId === 0) {
          lastSentenceRange.end = start;
        }
      } else {
        const lastTrackDuration = await getTrackDuration(lastSentenceRange.audiofile);
        lastSentenceRange.end = lastTrackDuration;
      }
    }

    sentenceRanges.push({
      id: sentenceId,
      start,
      end,
      audiofile,
    });

    notFound = 0;
    lastMatchEnd =
      firstMatch.index +
      firstMatch.match.length +
      transcriptionOffset +
      transcriptionWindowOffset +
      chapterOffset;

    const windowIndexResult = getWindowIndexFromOffset(
      transcriptionWindowList,
      firstMatch.index + firstMatch.match.length + transcriptionWindowOffset,
    );

    transcriptionWindowIndex += windowIndexResult.index;
    transcriptionWindowOffset = windowIndexResult.offset;

    lastGoodTranscriptionWindow = transcriptionWindowIndex;
    sentenceIndex += 1;
  }

  return {
    sentenceRanges,
    transcriptionOffset: lastMatchEnd,
  };
}

export async function interpolateSentenceRanges(
  sentenceRanges: SentenceRange[],
  _lastSentenceRange: SentenceRange | null,
) {
  const interpolated: SentenceRange[] = [];
  const [first, ...rest] = sentenceRanges;
  if (!first) return interpolated;

  if (first.id !== 0) {
    for (let i = 0; i < first.id; i++) {
      interpolated.push({
        id: i,
        start: -1,
        end: -1,
        audiofile: first.audiofile,
      });
    }
  }

  interpolated.push(first);

  for (const sentenceRange of rest) {
    const lastSentenceRange = interpolated[interpolated.length - 1]!;
    const count = sentenceRange.id - lastSentenceRange.id - 1;

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        interpolated.push({
          id: lastSentenceRange.id + i + 1,
          start: -1,
          end: -1,
          audiofile: sentenceRange.audiofile,
        });
      }
    }

    interpolated.push(sentenceRange);
  }

  return interpolated;
}

/**
 * STT sometimes provides words with no time information,
 * or start and end timestamps that are equal. This nudges them
 * out a bit to make sure that they're not truly equal.
 */
export function expandEmptySentenceRanges(sentenceRanges: SentenceRange[]) {
  const expandedRanges: SentenceRange[] = [];
  for (const sentenceRange of sentenceRanges) {
    const previousSentenceRange = expandedRanges[expandedRanges.length - 1];
    if (!previousSentenceRange) {
      expandedRanges.push(sentenceRange);
      continue;
    }

    const nudged =
      previousSentenceRange.end > sentenceRange.start &&
      previousSentenceRange.audiofile === sentenceRange.audiofile
        ? { ...sentenceRange, start: previousSentenceRange.end }
        : sentenceRange;

    if (nudged.start < 0 || nudged.end < 0) {
      expandedRanges.push(nudged);
      continue;
    }

    const expanded = nudged.end <= nudged.start ? { ...nudged, end: nudged.start + 0.001 } : nudged;

    expandedRanges.push(expanded);
  }
  return expandedRanges;
}

export function getChapterDuration(sentenceRanges: SentenceRange[]) {
  let i = 0;
  let duration = 0;
  let audiofile: string | null = null;
  let start = 0;
  let end = 0;
  while (i < sentenceRanges.length) {
    const sentenceRange = sentenceRanges[i]!;
    if (sentenceRange.audiofile !== audiofile) {
      duration += end - start;
      start = sentenceRange.start;
      audiofile = sentenceRange.audiofile;
    }
    end = sentenceRange.end;
    i++;
  }
  duration += end - start;
  return duration;
}
