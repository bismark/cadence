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
});
