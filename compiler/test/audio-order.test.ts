import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getAudioFiles, getAudioFilesInFirstSpanUseOrder } from '../src/epub/opf.js';
import type { ManifestItem, OPFPackage } from '../src/types.js';

interface AudioSpanFixture {
  audioSrc: string;
  clipBeginMs: number;
  clipEndMs: number;
}

interface MisleadingManifestFixture {
  manifestAudioOrder: string[];
  spans: AudioSpanFixture[];
}

function loadFixture(): MisleadingManifestFixture {
  const fixturePath = join(__dirname, 'fixtures', 'misleading-manifest-audio-order.json');
  return JSON.parse(readFileSync(fixturePath, 'utf-8')) as MisleadingManifestFixture;
}

function createOpf(manifestAudioOrder: string[]): OPFPackage {
  const manifest = new Map<string, ManifestItem>();

  for (let i = 0; i < manifestAudioOrder.length; i++) {
    const href = manifestAudioOrder[i]!;
    manifest.set(`audio-${i}`, {
      id: `audio-${i}`,
      href,
      mediaType: 'audio/mpeg',
    });
  }

  // Non-audio noise to assert filtering still behaves as expected.
  manifest.set('chapter-1', {
    id: 'chapter-1',
    href: 'OPS/chapter-1.xhtml',
    mediaType: 'application/xhtml+xml',
  });

  return {
    title: 'Misleading manifest audio order fixture',
    manifest,
    spine: [],
    mediaOverlays: new Map(),
  };
}

describe('EPUB audio file ordering', () => {
  it('derives concatenation order from first timed span-use, not manifest order', () => {
    const fixture = loadFixture();
    const opf = createOpf(fixture.manifestAudioOrder);

    expect(getAudioFiles(opf)).toEqual([
      'OPS/audio/chapter-2.mp3',
      'OPS/audio/unused-stinger.mp3',
      'OPS/audio/chapter-1.mp3',
      'OPS/audio/chapter-3.mp3',
    ]);

    const ordered = getAudioFilesInFirstSpanUseOrder(opf, fixture.spans);

    expect(ordered).toEqual([
      'OPS/audio/chapter-1.mp3',
      'OPS/audio/chapter-2.mp3',
      'OPS/audio/chapter-3.mp3',
      'OPS/audio/unused-stinger.mp3',
    ]);
  });

  it('falls back to deterministic manifest order when no timed spans are present', () => {
    const fixture = loadFixture();
    const opf = createOpf(fixture.manifestAudioOrder);

    const untimedOnly = fixture.spans.map((span) => ({
      ...span,
      clipEndMs: span.clipBeginMs,
    }));

    const ordered = getAudioFilesInFirstSpanUseOrder(opf, untimedOnly);

    expect(ordered).toEqual(fixture.manifestAudioOrder);
  });
});
