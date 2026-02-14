import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openEPUB } from '../src/epub/container.js';
import { getSpineXHTMLFiles, parseOPF } from '../src/epub/opf.js';
import { buildTocEntries } from '../src/epub/toc.js';
import type { EPUBContainer, OPFPackage } from '../src/types.js';

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
      const basicTestsPageIndex = pages.find(
        (page) => page.chapterId === 'tobi_spine_3',
      )?.pageIndex;

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

      const toc = await buildTocEntries(
        container,
        { ...opf, navPath: undefined },
        spineFiles,
        pages,
      );

      expect(toc.length).toBeGreaterThan(20);
      expect(toc.some((entry) => entry.title.includes('CHAPTER 1. Loomings.'))).toBe(true);
      expect(toc[0]?.title).not.toBe(spineFiles[0]?.id);
    } finally {
      await container.close();
    }
  });

  it('parses wrapped root nav list structures without fallback', async () => {
    const navPath = 'OPS/nav.xhtml';
    const container = createInMemoryContainer({
      [navPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body>
            <nav epub:type="toc">
              <div class="toc-wrapper">
                <ol>
                  <li><a href="ch1.xhtml">Chapter One</a></li>
                  <li><a href="ch2.xhtml">Chapter Two</a></li>
                </ol>
              </div>
            </nav>
          </body>
        </html>
      `,
    });

    const opf = createOpfWithNav(navPath);
    const spineFiles = [
      { id: 'chapter-1', href: 'OPS/ch1.xhtml' },
      { id: 'chapter-2', href: 'OPS/ch2.xhtml' },
    ];
    const pages = [
      { chapterId: 'chapter-1', pageIndex: 0 },
      { chapterId: 'chapter-2', pageIndex: 10 },
    ];

    const toc = await buildTocEntries(container, opf, spineFiles, pages);

    expect(toc).toEqual([
      { title: 'Chapter One', pageIndex: 0, level: 0 },
      { title: 'Chapter Two', pageIndex: 10, level: 0 },
    ]);
  });

  it('parses wrapped child nav lists and preserves hierarchy', async () => {
    const navPath = 'OPS/nav.xhtml';
    const container = createInMemoryContainer({
      [navPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
          <body>
            <nav epub:type="toc">
              <section>
                <ol>
                  <li>
                    <div>
                      <a href="ch1.xhtml">Part I</a>
                      <ol>
                        <li>
                          <div>
                            <a href="ch2.xhtml">Chapter 2</a>
                          </div>
                        </li>
                      </ol>
                    </div>
                  </li>
                </ol>
              </section>
            </nav>
          </body>
        </html>
      `,
    });

    const opf = createOpfWithNav(navPath);
    const spineFiles = [
      { id: 'chapter-1', href: 'OPS/ch1.xhtml' },
      { id: 'chapter-2', href: 'OPS/ch2.xhtml' },
    ];
    const pages = [
      { chapterId: 'chapter-1', pageIndex: 2 },
      { chapterId: 'chapter-2', pageIndex: 6 },
    ];

    const toc = await buildTocEntries(container, opf, spineFiles, pages);

    expect(toc).toEqual([
      { title: 'Part I', pageIndex: 2, level: 0 },
      { title: 'Chapter 2', pageIndex: 6, level: 1 },
    ]);
  });
});

function createInMemoryContainer(files: Record<string, string>): EPUBContainer {
  return {
    opfPath: 'OPS/content.opf',
    async readFile(path: string): Promise<Buffer> {
      const file = files[path];
      if (file === undefined) {
        throw new Error(`Missing file: ${path}`);
      }

      return Buffer.from(file, 'utf-8');
    },
    async listFiles(): Promise<string[]> {
      return Object.keys(files);
    },
    async close(): Promise<void> {
      // no-op
    },
  };
}

function createOpfWithNav(navPath: string): OPFPackage {
  return {
    title: 'Test Book',
    manifest: new Map(),
    spine: [],
    mediaOverlays: new Map(),
    navPath,
  };
}
