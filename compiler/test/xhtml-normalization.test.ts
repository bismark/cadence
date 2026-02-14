import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProfile } from '../src/device-profiles/profiles.js';
import { openEPUB } from '../src/epub/container.js';
import { getSpineXHTMLFiles, parseOPF } from '../src/epub/opf.js';
import { parseChapterSMIL } from '../src/epub/smil.js';
import { normalizeXHTML } from '../src/epub/xhtml.js';
import type { EPUBContainer, Span } from '../src/types.js';

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

  it('maps spans when textRef uses URI-encoded chapter path segments', async () => {
    const chapterPath = 'OPS/chapter 1.xhtml';
    const container = createInMemoryContainer({
      [chapterPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head></head>
          <body>
            <p id="frag1">Hello world</p>
          </body>
        </html>
      `,
    });

    const spans: Span[] = [
      {
        id: 'encoded-path-span',
        chapterId: 'chapter-1',
        textRef: 'OPS/chapter%201.xhtml#frag1',
        audioSrc: 'audio.mp3',
        clipBeginMs: 0,
        clipEndMs: 1000,
      },
    ];

    const normalized = await normalizeXHTML(
      container,
      chapterPath,
      'chapter-1',
      spans,
      defaultProfile,
    );

    expect(normalized.html).toContain('data-span-id="encoded-path-span"');
  });

  it('maps fragment-only textRef targets to the current chapter', async () => {
    const chapterPath = 'OPS/chapter-1.xhtml';
    const container = createInMemoryContainer({
      [chapterPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head></head>
          <body>
            <p id="frag1">Hello world</p>
          </body>
        </html>
      `,
    });

    const spans: Span[] = [
      {
        id: 'fragment-only-span',
        chapterId: 'chapter-1',
        textRef: '#frag1',
        audioSrc: 'audio.mp3',
        clipBeginMs: 0,
        clipEndMs: 1000,
      },
    ];

    const normalized = await normalizeXHTML(
      container,
      chapterPath,
      'chapter-1',
      spans,
      defaultProfile,
    );

    expect(normalized.html).toContain('data-span-id="fragment-only-span"');
  });

  it('preserves source order for interleaved publisher <link>/<style> nodes', async () => {
    const chapterPath = 'OPS/chapter-1.xhtml';
    const container = createInMemoryContainer({
      [chapterPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head>
            <link rel="stylesheet" href="styles/a.css" />
            <style>.inline-b { color: #111; }</style>
            <link rel="stylesheet" href="styles/c.css" />
            <style>
              @import url("https://evil.example.com/remote.css");
              .inline-d { color: #222; }
            </style>
          </head>
          <body>
            <p id="frag1">Hello world</p>
          </body>
        </html>
      `,
    });

    const spans: Span[] = [
      {
        id: 'span-1',
        chapterId: 'chapter-1',
        textRef: `${chapterPath}#frag1`,
        audioSrc: 'audio.mp3',
        clipBeginMs: 0,
        clipEndMs: 1000,
      },
    ];

    const normalized = await normalizeXHTML(
      container,
      chapterPath,
      'chapter-1',
      spans,
      defaultProfile,
    );

    const linkAIndex = normalized.html.indexOf('href="styles/a.css"');
    const inlineBIndex = normalized.html.indexOf('.inline-b { color: #111; }');
    const linkCIndex = normalized.html.indexOf('href="styles/c.css"');
    const inlineDIndex = normalized.html.indexOf('.inline-d { color: #222; }');

    expect(linkAIndex).toBeGreaterThan(-1);
    expect(inlineBIndex).toBeGreaterThan(linkAIndex);
    expect(linkCIndex).toBeGreaterThan(inlineBIndex);
    expect(inlineDIndex).toBeGreaterThan(linkCIndex);

    expect(normalized.html).not.toContain('https://evil.example.com/remote.css');
    expect(normalized.html).toContain('.inline-d { color: #222; }');
  });

  it('ignores fake <style> tags inside script text while still extracting real inline styles', async () => {
    const chapterPath = 'OPS/chapter-1.xhtml';
    const container = createInMemoryContainer({
      [chapterPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head>
            <style>
              .real-inline { color: #222; }
            </style>
          </head>
          <body>
            <script>
              const fake = '<style>.fake-from-script { color: #f00; }</style>';
            </script>
            <p id="frag1">Hello world</p>
          </body>
        </html>
      `,
    });

    const spans: Span[] = [
      {
        id: 'span-1',
        chapterId: 'chapter-1',
        textRef: `${chapterPath}#frag1`,
        audioSrc: 'audio.mp3',
        clipBeginMs: 0,
        clipEndMs: 1000,
      },
    ];

    const normalized = await normalizeXHTML(
      container,
      chapterPath,
      'chapter-1',
      spans,
      defaultProfile,
    );

    expect(normalized.html).toContain('.real-inline { color: #222; }');
    expect(normalized.html).not.toContain('.fake-from-script { color: #f00; }');
  });

  it('sanitizes unsafe publisher CSS constructs while keeping local styling', async () => {
    const chapterPath = 'OPS/chapter-1.xhtml';
    const container = createInMemoryContainer({
      [chapterPath]: `
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head>
            <link rel="stylesheet" href="styles/base.css" />
            <link rel="stylesheet" href="https://evil.example.com/theme.css" />
            <style>
              @import url("https://evil.example.com/remote.css");
              @import url("styles/local.css");
              .safe { color: #222; }
              .unsafe-bg { background-image: url('https://evil.example.com/pixel.png'); }
            </style>
          </head>
          <body>
            <p id="frag1" onclick="alert('x')" style="background-image:url(https://evil.example.com/img.png); color: #111;">
              Hello world
            </p>
            <a href="javascript:alert('x')">bad link</a>
          </body>
        </html>
      `,
    });

    const spans: Span[] = [
      {
        id: 'span-1',
        chapterId: 'chapter-1',
        textRef: `${chapterPath}#frag1`,
        audioSrc: 'audio.mp3',
        clipBeginMs: 0,
        clipEndMs: 1000,
      },
    ];

    const normalized = await normalizeXHTML(
      container,
      chapterPath,
      'chapter-1',
      spans,
      defaultProfile,
    );

    expect(normalized.html).toContain('<link rel="stylesheet" href="styles/base.css">');
    expect(normalized.html).not.toContain('https://evil.example.com/theme.css');
    expect(normalized.html).toContain('@import url("styles/local.css");');
    expect(normalized.html).not.toContain('@import url("https://evil.example.com/remote.css");');
    expect(normalized.html).not.toContain('https://evil.example.com/pixel.png');
    expect(normalized.html).toContain('url("")');

    expect(normalized.html).not.toContain('onclick=');
    expect(normalized.html).not.toContain('href="javascript:');
    expect(normalized.html).toContain('color: #111');
    expect(normalized.html).toContain('data-span-id="span-1"');

    const inlineStyleIndex = normalized.html.indexOf('.safe { color: #222; }');
    const profileStyleIndex = normalized.html.lastIndexOf('<style>');
    expect(inlineStyleIndex).toBeGreaterThan(-1);
    expect(profileStyleIndex).toBeGreaterThan(inlineStyleIndex);
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
