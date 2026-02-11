import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '../src/device-profiles/profiles.js';
import { openEPUB } from '../src/epub/container.js';
import { getSpineXHTMLFiles, parseOPF } from '../src/epub/opf.js';
import { parseChapterSMIL } from '../src/epub/smil.js';
import { normalizeXHTML } from '../src/epub/xhtml.js';

describe('XHTML normalization', () => {
  it('preserves stylesheet links and source XHTML path for chapters', async () => {
    const epubPath = join(
      __dirname,
      'fixtures',
      'Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub',
    );

    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const chapters = getSpineXHTMLFiles(opf).filter((chapter) => chapter.smilHref);
      const chapter = chapters[0];

      if (!chapter?.smilHref) {
        throw new Error('Expected fixture chapter with SMIL reference');
      }

      const chapterSpans = await parseChapterSMIL(container, chapter.smilHref, chapter.id);
      const normalized = await normalizeXHTML(
        container,
        chapter.href,
        chapter.id,
        chapterSpans,
        defaultProfile,
      );

      expect(normalized.xhtmlPath).toBe(chapter.href);
      expect(normalized.html).toMatch(
        /<head>[\s\S]*<link[^>]+href="\.\.\/css\/base\.css"[\s\S]*<\/head>/,
      );
      expect(normalized.html).toContain('data-span-id="');
    } finally {
      await container.close();
    }
  });

  it('only maps spans whose textRef path matches the chapter XHTML path', async () => {
    const epubPath = join(
      __dirname,
      'fixtures',
      'Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub',
    );

    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const chapters = getSpineXHTMLFiles(opf).filter((chapter) => chapter.smilHref);
      const chapter = chapters[0];
      const otherChapter = chapters.find((candidate) => candidate.href !== chapter?.href);

      if (!chapter?.smilHref || !otherChapter) {
        throw new Error('Expected fixture chapters with distinct SMIL XHTML paths');
      }

      const chapterSpans = await parseChapterSMIL(container, chapter.smilHref, chapter.id);
      const firstSpan = chapterSpans[0];
      const hashIndex = firstSpan?.textRef.indexOf('#') ?? -1;

      if (!firstSpan || hashIndex < 0) {
        throw new Error('Expected SMIL span with a fragment textRef target');
      }

      const fragment = firstSpan.textRef.slice(hashIndex + 1);
      const mismatchedPathSpan = {
        ...firstSpan,
        id: 'mismatched-path-span',
        textRef: `${otherChapter.href}#${fragment}`,
      };

      const normalized = await normalizeXHTML(
        container,
        chapter.href,
        chapter.id,
        [...chapterSpans, mismatchedPathSpan],
        defaultProfile,
      );

      expect(normalized.html).toContain(`data-span-id="${firstSpan.id}"`);
      expect(normalized.html).not.toContain('data-span-id="mismatched-path-span"');
    } finally {
      await container.close();
    }
  });
});
