import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEPUB } from '../src/epub/container.js';
import { getSpineXHTMLFiles, parseOPF } from '../src/epub/opf.js';
import { buildTocEntries } from '../src/epub/toc.js';

const fixturesDir = join(__dirname, 'fixtures');

describe('EPUB ToC parsing', () => {
  it('parses nav and ncx paths from OPF metadata', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      expect(opf.navPath).toBe('OEBPS/toc.xhtml');
      expect(opf.ncxPath).toBe('OEBPS/toc.ncx');
    } finally {
      await container.close();
    }
  });

  it('uses EPUB3 nav titles and hierarchy when available', async () => {
    const epubPath = join(fixturesDir, 'Advanced-Accessibility-Tests-Media-Overlays-v1.0.0.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);
      const pages = spineFiles.map((chapter, pageIndex) => ({
        chapterId: chapter.id,
        pageIndex,
      }));

      const toc = await buildTocEntries(container, opf, spineFiles, pages);

      const basicTestsRoot = toc.find((entry) => entry.title === 'Basic Tests');
      const basicTestsChild = toc.find((entry) => entry.title === 'Media Overlays Playback');
      const basicTestsPageIndex = pages.find((page) => page.chapterId === 'tobi_spine_3')?.pageIndex;

      expect(toc.length).toBeGreaterThan(3);
      expect(basicTestsRoot).toBeDefined();
      expect(basicTestsRoot?.level).toBe(0);

      expect(basicTestsChild).toBeDefined();
      expect(basicTestsChild?.level).toBe(1);
      expect(basicTestsChild?.pageIndex).toBe(basicTestsPageIndex);
    } finally {
      await container.close();
    }
  });

  it('falls back to NCX titles when nav is unavailable', async () => {
    const epubPath = join(fixturesDir, 'moby-dick.epub');
    const container = await openEPUB(epubPath);

    try {
      const opf = await parseOPF(container);
      const spineFiles = getSpineXHTMLFiles(opf);
      const pages = spineFiles.map((chapter, pageIndex) => ({
        chapterId: chapter.id,
        pageIndex,
      }));

      const toc = await buildTocEntries(container, { ...opf, navPath: undefined }, spineFiles, pages);

      expect(toc.length).toBeGreaterThan(20);
      expect(toc.some((entry) => entry.title.includes('CHAPTER 1. Loomings.'))).toBe(true);
      expect(toc[0]?.title).not.toBe(spineFiles[0]?.id);
    } finally {
      await container.close();
    }
  });
});
