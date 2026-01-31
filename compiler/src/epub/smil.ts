import { XMLParser } from 'fast-xml-parser';
import type { EPUBContainer, Span } from '../types.js';
import { resolvePath } from './container.js';

/**
 * Parse a SMIL file and extract timing information
 */
export async function parseSMIL(
  container: EPUBContainer,
  smilPath: string,
  chapterId: string
): Promise<Span[]> {
  const content = await container.readFile(smilPath);
  const xml = content.toString('utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['par', 'seq', 'text', 'audio'].includes(name),
  });

  const parsed = parser.parse(xml);
  const spans: Span[] = [];

  // SMIL structure: smil > body > seq (or par elements directly)
  const body = parsed.smil?.body;
  if (!body) {
    console.warn(`SMIL file ${smilPath} has no body element`);
    return spans;
  }

  // Extract par elements recursively
  extractParElements(body, smilPath, chapterId, spans);

  return spans;
}

/**
 * Recursively extract par elements from SMIL structure
 */
function extractParElements(
  node: Record<string, unknown>,
  smilPath: string,
  chapterId: string,
  spans: Span[]
): void {
  // Process par elements at this level
  const parElements = node.par;
  if (Array.isArray(parElements)) {
    for (const par of parElements) {
      const span = parseParElement(par as Record<string, unknown>, smilPath, chapterId, spans.length);
      if (span) {
        spans.push(span);
      }
    }
  }

  // Process nested seq elements
  const seqElements = node.seq;
  if (Array.isArray(seqElements)) {
    for (const seq of seqElements) {
      extractParElements(seq as Record<string, unknown>, smilPath, chapterId, spans);
    }
  } else if (seqElements && typeof seqElements === 'object') {
    extractParElements(seqElements as Record<string, unknown>, smilPath, chapterId, spans);
  }
}

/**
 * Parse a single par element into a Span
 */
function parseParElement(
  par: Record<string, unknown>,
  smilPath: string,
  chapterId: string,
  index: number
): Span | null {
  // Get the par ID or generate one
  const parId = (par['@_id'] as string) || `span_${chapterId}_${index}`;

  // Find text element
  const textElements = par.text;
  const textEl = Array.isArray(textElements) ? textElements[0] : textElements;
  if (!textEl) {
    return null;
  }

  const textSrc = (textEl as Record<string, string>)['@_src'];
  if (!textSrc) {
    return null;
  }

  // Find audio element
  const audioElements = par.audio;
  const audioEl = Array.isArray(audioElements) ? audioElements[0] : audioElements;

  let audioSrc = '';
  let clipBeginMs = 0;
  let clipEndMs = 0;

  if (audioEl) {
    const audioObj = audioEl as Record<string, string>;
    audioSrc = audioObj['@_src'] || '';
    clipBeginMs = parseClipTime(audioObj['@_clipBegin'] || '0');
    clipEndMs = parseClipTime(audioObj['@_clipEnd'] || '0');
  }

  // Resolve paths relative to SMIL file
  const resolvedTextRef = resolvePath(smilPath, textSrc);
  const resolvedAudioSrc = audioSrc ? resolvePath(smilPath, audioSrc) : '';

  return {
    id: parId,
    chapterId,
    textRef: resolvedTextRef,
    audioSrc: resolvedAudioSrc,
    clipBeginMs,
    clipEndMs,
  };
}

/**
 * Parse SMIL clip time to milliseconds
 * Supports formats: "1.5s", "1500ms", "00:01:30.500" (SMPTE), or plain seconds
 */
export function parseClipTime(time: string): number {
  if (!time) return 0;

  const trimmed = time.trim();

  // Handle milliseconds: "1500ms"
  if (trimmed.endsWith('ms')) {
    return parseFloat(trimmed.slice(0, -2));
  }

  // Handle seconds: "1.5s"
  if (trimmed.endsWith('s')) {
    return parseFloat(trimmed.slice(0, -1)) * 1000;
  }

  // Handle SMPTE format: "00:01:30.500" or "01:30.500"
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    let seconds = 0;

    if (parts.length === 3) {
      // HH:MM:SS.mmm
      seconds = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      // MM:SS.mmm
      seconds = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }

    return seconds * 1000;
  }

  // Assume plain seconds
  return parseFloat(trimmed) * 1000;
}

/**
 * Parse all SMIL files for a chapter and combine spans
 */
export async function parseChapterSMIL(
  container: EPUBContainer,
  smilPath: string,
  chapterId: string
): Promise<Span[]> {
  return parseSMIL(container, smilPath, chapterId);
}
