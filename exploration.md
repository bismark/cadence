# EPUB3 Media Overlay Solution

**Date:** 2026-01-22
**Source:** [chat.openai.com](https://chatgpt.com/c/69718513-8628-832f-b5ae-95006304059a)

---

### **You**

We explored this once before but I want to build an epub with media overlays reader for very low powered android  eink tablets, namely the Supernote manta. That means performance MUST be paramount, ie audio sync plus read along highlighting must match. Given it’s a single device, maybe you could get by with pre-rendering a book? How would you approach this problem? I want to work with a coding agent so the ultimate goal is to make a doc to work from

---

### **ChatGPT**

Below is how I’d approach an EPUB3 Media Overlays (SMIL) read-along reader optimized for a single, very low-powered Android e-ink device (Supernote Manta). The core idea: treat this like a “playback appliance” more than a general EPUB renderer. You’ll get reliability and speed by (1) narrowing what EPUB/CSS you support, and (2) precomputing everything you can into a device-specific “compiled book” bundle so runtime does almost no parsing/layout.

Design doc to work from (for a coding agent)
1) Goals
Must-have

Audio playback + text highlighting (“read along”) are tightly synced and stable.

Page turns and highlight updates feel instant on slow CPU / e-ink refresh.

Works offline.

Nice-to-have

Resume position (audio time + text location).

Speed control (0.8x–1.5x) without desync.

Minimal battery drain.

Non-goals (for v1)

Full EPUB CSS/JS support.

Arbitrary fonts, dynamic reflow settings, complex layouts, tables, vertical writing, math, etc.

2) Key assumption that unlocks performance
Because it’s a single target device, you can “compile” each book into a format that’s already:

Paginated for that exact screen size

Laid out with fixed typography rules

Mapped from audio times → text spans → highlight rectangles

This eliminates heavyweight runtime work (HTML/CSS layout + DOM queries + SMIL parsing loops).

3) Proposed architecture overview
A) Offline “Book Compiler” (desktop tool)
Input: .epub (EPUB3) containing Media Overlays: XHTML + SMIL + audio files
Output: a compiled book bundle (zip folder) containing:

normalized text content (chapters)

device-specific pagination info

time→text span index

per-page highlight geometry (rects)

audio assets (as-is or optionally repackaged)

B) On-device “Playback Reader” (Android app)
Runtime does:

open compiled bundle

render one page at a time using precomputed layout model

play audio (native player)

update highlight by drawing rectangles for the currently active segment

minimal state machine for next/prev segment, page changes, resume

4) Data model: what you precompute
You want three coordinate systems that all map cleanly:

Audio time (ms)

Text span id (a stable integer range within a chapter)

Page geometry (rectangles to highlight)

A very effective model:
“Span” definition
A span is the smallest highlight unit you want (usually a word or phrase).

span_id (int)

chapter_id

char_start, char_end in chapter plain text

t_start_ms, t_end_ms (from SMIL audio clipBegin/clipEnd)

“Page” definition
A page is a list of text runs plus highlightable rects:

page_id

chapter_id

text_runs: list of (text, x, y, font_id, size, flags)

span_rects: mapping span_id -> [Rect] (often 1–N rects due to line wraps)

next_page_id, prev_page_id

first_span_id, last_span_id

At runtime you do:

current_time_ms -> active_span_id via binary search in span list

draw the page text (or cached bitmap) + draw highlight rects for that span

5) EPUB/Media Overlay parsing strategy (compiler side)
Reality check: EPUB Media Overlays can be messy:

SMIL points to XHTML fragments via textref and to audio clips via src#t=... or clipBegin/clipEnd.

XHTML fragments can be nested, styled, and segmented differently than SMIL expects.

Compiler job:

Parse EPUB container (OPF spine order, manifest).

Load each XHTML file in spine order.

Extract “readable text” in a controlled way:

Define supported tags: p, h1-h3, li, blockquote, em, strong etc.

Convert to a normalized internal markup (e.g., paragraphs + inline styles).

Keep IDs/anchors so SMIL references can resolve.

Parse SMIL files:

For each <par>: resolve text src="chapter.xhtml#frag" to a text node range.

Extract audio file + clipBegin/clipEnd → ms.

Build alignment:

Produce ordered spans that match SMIL reading order.

If SMIL points at a whole element (a sentence), decide whether to highlight element-level or split to words.

For v1: element-level highlighting is simpler and more robust.

For better UX: allow optional word splitting if you have word-level timings (often you don’t).

Emit span list + time ranges.

Recommendation for v1: highlight at the granularity SMIL gives you (often sentence/phrase), because trying to infer word timings without them causes mismatch.

6) Pagination and layout (compiler side)
This is the biggest performance lever.
Option 1 (best for performance): fixed typography + pre-layout
Pick fixed:

font family (or a small set)

font sizes

line spacing

margins

hyphenation policy (maybe none)

justification policy (left align to reduce layout complexity)

no floats, no complex CSS

Then paginate for:

exact screen width/height in px

exact DPI assumptions

Output pages with:

exact positions of runs

highlight rects per span

Runtime rendering becomes trivial.
Option 2 (more flexible): limited runtime reflow
If you allow font size changes, you can still keep it fast by compiling multiple “profiles”:

small/medium/large font bundles

or compile on first open and cache (but that’s riskier on slow devices)

Given your “performance MUST be paramount,” I’d do Option 1 for Manta.

7) Rendering approach on Android (runtime)
Two good choices:
Approach A: draw text yourself on Canvas (recommended)

Render page using StaticLayout / TextLayout equivalents (depending on API level) only if you must.

But since you precomputed runs + positions, you can draw runs directly:

canvas.drawText(run.text, run.x, run.y, paintForFont(run.font_id))

Highlight:

Draw highlight rect(s) behind text:

canvas.drawRect(rect, highlightPaint)

On e-ink: update at a limited cadence (e.g., 8–12 Hz), or only at span boundaries.

This avoids WebView entirely.
Approach B: WebView (not recommended here)
Even if you heavily optimize, WebView + JS timers + DOM operations on e-ink low CPU is where sync and jank go to die.

8) Audio playback + sync
Use a native player (e.g., ExoPlayer) and a tight, simple sync loop:

Maintain active_span_id

Poll current position:

either via a periodic tick (e.g., every 80–120ms)

or via scheduled callbacks at known t_start_ms boundaries

Better: schedule by span boundaries:

You already have t_start_ms / t_end_ms

You can compute the next transition time and set a handler to wake then

You still might poll occasionally to recover from drift / seeks

On transition:

if the next span is on the same page: redraw highlight only

if it crosses into next page: page swap + highlight

Seek handling:

User taps a span → seek audio to t_start_ms

User scrubs audio → binary search span by time

Playback speed:

If player supports time scaling, currentPosition remains in media time; span times stay valid.

9) E-ink specific tactics

Minimize full-screen refreshes.

Redraw only highlight region if device supports partial refresh (you can implement “dirty rect” invalidation).

Highlight updates only on span changes (not per syllable).

Cache rendered pages:

Cache previous/current/next page bitmaps if memory allows.

But careful: if highlight is drawn over bitmap, you can keep a “base page bitmap” and overlay highlight separately.

Avoid animations. No smooth scrolling; page turns are discrete.

10) File format for compiled bundle (simple + fast)
A practical bundle structure:

```
bashbook.bundle.zip
  /meta.json
  /chapters/0.txt
  /chapters/0.spans.jsonl
  /pages/0_0001.pagebin
  /pages/0_0002.pagebin
  /audio/001.mp3
  /audio/002.mp3
```

Where:

meta.json includes:

device profile (w/h, margins, font ids)

total pages

mapping audio files to chapters

spans.jsonl (or binary) stores spans sorted by time

pagebin is a compact binary page representation (faster than JSON to parse)

For v1, JSON is okay if you keep it small, but binary will be noticeably snappier on weak CPUs.

11) Testing and correctness strategy (non-negotiable for sync)
Add a “sync validation” mode in the compiler:

For each span:

confirm referenced XHTML fragment resolves to non-empty text

confirm times are monotonic and non-overlapping (or handle overlaps explicitly)

Emit warnings when:

SMIL references missing anchors

clipBegin/clipEnd missing or malformed

time gaps exceed some threshold (optional)

On device, add a debug overlay:

show active_span_id, t_start/t_end, current_time

tap to jump span forward/back

log drift incidents (e.g., if current time is beyond t_end but span didn’t advance)

12) Implementation plan (agent-friendly tasks)
Phase 1: “Happy path” prototype

Compiler:

Load EPUB, read OPF spine

Parse one XHTML + one SMIL

Build span list with element-level highlights

Hardcode a simple paginator (fixed font, fixed width)

Emit a few pages with span rects (rects can be approximate first)

Android app:

Load compiled bundle from storage

Render pages

Play audio

Advance highlight on span boundary timers

Phase 2: Robustify

Support multi-file spine, multiple SMILs

Proper rect computation (line wraps, multi-rect spans)

Seeking + resume

Page caching + partial redraw

Add validations and fallback behavior

Phase 3: Packaging and UX

Library view (list compiled books)

Book progress saving

Speed control

Tap on text to jump

13) Hard tradeoffs to decide up front
These choices affect everything, so decide early:

Do you allow font size changes?

If yes, you either compile multiple bundles or compute layout on device once.

If no, you get maximum speed and simplest syncing.

Highlight granularity

Element/sentence: robust, simpler, usually matches SMIL.

Word-level: only if timing data exists. Don’t guess.

What EPUB features you support

v1 should be a strict subset. Publish the “supported EPUB profile” you expect.

My recommended approach for Manta
Compile-to-device-bundle + Canvas text renderer + span-boundary scheduling.
That combination gives you:

predictable layout (no WebView surprises)

extremely low CPU during playback

highlight correctness because geometry is precomputed

easy handling of page turns at exact span boundaries

If you want, I can turn the above into a more formal spec (with proposed binary schemas, state machines, and pseudo-code for the compiler + Android runtime loop) in the exact format you’d hand to a coding agent (milestones, file layout, interfaces, and acceptance tests).

---

### **You**

What tech stack should we be looking at for the compiler?

---

### **ChatGPT**

For the compiler (EPUB → “compiled bundle”), I’d pick a stack that’s great at: ZIP/EPUB parsing, XML/HTML parsing, and deterministic text layout/pagination. Since your runtime is a single device and performance is paramount, the compiler can be heavier—as long as its output is deterministic and easy to consume on Android.
Here are the stacks I’d seriously consider, in order.
Recommended: Node.js/TypeScript + a real layout engine
Why

Great ecosystem for EPUB/ZIP + XML/HTML parsing.

Easy to build a CLI + tests.

Can call out to a deterministic layout engine for pagination/rects.

Core libs

EPUB container: yauzl / adm-zip (ZIP), plus OPF parsing

XML/SMIL/OPF: fast-xml-parser (fast) or xmldom

XHTML parsing: parse5 (HTML) or jsdom (heavier)

For layout/pagination (critical choice)

Option A (best for correctness): headless Chromium + “print layout”

Use playwright to load your normalized HTML, set fixed viewport, and compute:

page breaks

element bounding boxes

rects for spans (using Range.getClientRects())

Pros: handles wrapping/kerning/fallback fonts like a browser → your rects match reality.

Cons: heavier dependency, but that’s fine for a compiler.

Option B (lighter, more deterministic): Pango/HarfBuzz via native binding

Harder in JS, but possible via a small Rust/C++ helper binary.

Pros: very deterministic and fast.

Cons: more engineering.

When Node+Playwright is ideal

You’ll accept “compiled books” created on a desktop/CI.

You want “what you see is what you highlight” accuracy without building a text shaper yourself.

Strong alternative: Rust (CLI) + Skia/Pango for layout
Why

Fast, single static binary.

Excellent for binary output formats.

Great if you want a long-lived, robust compiler and you care about determinism.

Pieces

EPUB/ZIP: zip crate

XML: quick-xml

HTML5 parse: html5ever (or convert XHTML as XML where possible)

CSS subset: you implement a tiny style system (recommended anyway)

Layout

Pango + HarfBuzz (text shaping + layout)

Or Skia paragraph (SkParagraph) for high-quality text layout

Pros

Very deterministic if you pin fonts and shaping libraries.

Output a tight binary format easily.

Cons

More work up front than Node+browser for pagination/rects.

Pragmatic “single language” option: Python
I’d only pick Python if speed/time-to-build is the only thing that matters and you’re okay with a messier layout story.
Parsing

ebooklib for EPUB (okay)

lxml for XHTML/SMIL

Layout

Either shell out to headless Chromium anyway

Or use reportlab/text layout (but it won’t match browser wrapping and shaping)

Risk

Pagination/highlight rect correctness is where projects die. Python doesn’t buy you much there unless you still use Chromium.

What I’d choose for your constraints
If you want fastest path to a working, correct pipeline:
Node.js/TypeScript + Playwright (Chromium)

Use the browser only for pagination + rect measurement, not for runtime.

You’ll get accurate line wrapping and rectangles with minimal effort.

Then output a minimal binary/JSON bundle your Android app reads.

If you want the “forever” solution and you don’t mind upfront investment:
Rust + Pango/HarfBuzz (or Skia)

More code, but very clean and deterministic long term.

Tiny but important detail: “determinism” knobs
No matter the stack, to avoid highlight drift you should:

Bundle + pin the exact fonts used for compilation

Lock viewport size and DPI assumptions

Disable hyphenation (or implement it consistently)

Use left alignment (avoid justification spacing differences)

Normalize whitespace and HTML entities before span mapping

A concrete stack proposal (that a coding agent can execute)
Compiler

TypeScript CLI

fast-xml-parser for OPF/SMIL

parse5 for XHTML into a normalized internal model

playwright to:

render normalized chapter HTML in a fixed viewport matching Manta

compute page breaks (via CSS columns or manual pagination container)

compute Range.getClientRects() per span id for highlight rects

Emit:

meta.json

spans.bin (or JSONL initially)

pages.bin

copy audio assets

Why this works well

You outsource the hardest part—accurate text measurement—to a mature engine.

Runtime becomes dead simple and fast.

If you tell me whether you want the compiler to run on Mac only, cross-platform CI, or on the device itself (probably not), I can narrow to the exact toolchain choices (packaging, font handling, output format) without changing the overall approach.

---

### **You**

It will not be device. Linux or macOS Server?

---

### **ChatGPT**

If the compiler runs on a Linux server or macOS server (not on-device), you’ve got a lot of freedom. I’d pick based on one question: do you want to rely on a browser engine for layout, or own the layout stack?
Best “get it right fast”: Linux + Node/TS + Playwright (Chromium)
This is my top pick for your use case because the hardest part of Media Overlays is geometry that matches line wrapping. Headless Chromium gives you:

correct shaping/wrapping

Range.getClientRects() for per-span highlight rectangles

consistent pagination if you lock fonts + viewport

Why Linux server is ideal

Headless Chromium is well-supported and easiest to containerize.

You can pin exact versions (Node + Playwright) for reproducibility.

Deploy shape

A Docker image that contains:

Node runtime

Playwright + Chromium

your pinned fonts (copied into the image)

Run as a CLI job: compile book.epub -> book.bundle.zip

When macOS server is fine

Also works, but I’d still recommend Docker or at least pinning Playwright/Chromium versions. Linux tends to be less surprising for headless.

Big “determinism” knobs

Pin Chromium version (Playwright does this nicely)

Bundle fonts and force them via CSS (@font-face, font-family)

Fix viewport to the Manta’s exact px size

Disable hyphenation, avoid justification

Best “long-term appliance”: Rust CLI + Pango/HarfBuzz (no browser)
If you want a smaller, dependency-light compiler with fewer moving parts at runtime (and you’re willing to build more):

Rust CLI parses EPUB/SMIL/XHTML

Pango/HarfBuzz shapes and lays out text

You compute line breaks and rects directly

Output is extremely stable and fast

Why this is harder

You’re effectively building your own mini layout engine (even if you keep CSS support tiny).

Browser engines already solve edge cases you’ll otherwise rediscover.

What I’d choose for “Linux or macOS server?”
Recommendation
Linux server + Node/TypeScript + Playwright in Docker for v1–v2.
It’s the most reliable way to ensure highlight rects exactly match rendered text while keeping the on-device reader simple and fast.
A practical path

Start with Node/TS + Playwright, output JSON (easy to debug).

Once it’s correct, switch the output to compact binary (performance).

If later you want to remove Chromium, you can migrate the layout step to Rust/Pango—but only after you’ve nailed behavior.

“Server stack” specifics I’d standardize

Linux: Debian/Ubuntu base image

Node: LTS

Playwright: pinned version (committed in lockfile)

Fonts: checked into repo or stored in artifact bucket; installed into image

CI: compile known EPUB fixtures and snapshot expected spans/pages/rects

If you want, I can write the “Compiler Tech Stack” section for the doc you’ll hand to a coding agent: repo structure, Dockerfile outline, CLI contract, and the exact responsibilities split between “EPUB parse” and “layout/rect extraction.”

---

### **ChatGPT**

Below is a drop-in “Compiler Tech Stack” section you can hand to a coding agent. It assumes: Linux server primary, macOS dev, Dockerized build, Node/TypeScript + Playwright for deterministic pagination + highlight geometry.

Compiler Tech Stack
Summary
We will build a server-side EPUB3 Media Overlays compiler that transforms an input .epub into a device-targeted compiled bundle optimized for extremely fast playback + read-along highlighting on a low-powered Android e-ink device.
The compiler runs on Linux (production) and macOS (development), and is packaged in Docker for reproducibility. The hardest problem—exact text layout + highlight rectangle extraction—is solved by using Playwright/Chromium headless with pinned versions and bundled fonts.

Language + Runtime

Node.js (LTS) + TypeScript

TypeScript for maintainability and strict typing of book models.

Node for strong tooling and ecosystem (ZIP/XML/HTML parsing, CLI packaging).

Package manager

pnpm (preferred) or npm (acceptable). Use lockfiles to pin exact versions.

Key Dependencies
EPUB container + file access

Read .epub as ZIP:

Preferred: yauzl (streaming ZIP reader; low memory)

Alternative: adm-zip (simpler, but loads more into memory)

XML parsing (OPF/NCX/SMIL)

fast-xml-parser

Fast, low overhead, good enough for SMIL/OPF.

XHTML parsing / normalization

parse5

HTML5 parser, stable for messy XHTML-ish markup.

We do not aim for full DOM fidelity; we normalize to an internal model.

Layout + geometry extraction

playwright (Chromium)

Use Chromium to compute:

line wrapping

page boundaries

Range.getClientRects() for highlight rectangles per span

This avoids writing a text shaper/layout engine.

Validation & logging

zod for schema validation on compiler config and outputs (JSON)

pino for structured logging

Testing

vitest (or jest) for unit tests

Golden snapshot tests (file-based) for:

span timing list

pagination results

rect extraction stability

Reproducibility and Determinism
The compiled output must be deterministic for a given input EPUB + device profile.
We enforce determinism by:

Pinning Chromium

Playwright pins browser binaries; lock Playwright version in lockfile.

Bundling fonts

Ship fonts inside the Docker image (or in a versioned artifact bundle).

Force CSS to use these fonts only.

Fixed viewport

Set viewport to exact pixel dimensions of the target device page.

Disable variability in layout

Avoid justification (use left align)

Disable hyphenation

Normalize whitespace rules

Stable locale

Set LANG, LC_ALL in container to a fixed value (e.g., C.UTF-8).

Responsibilities Split: Parse vs Layout
Stage A: EPUB Parse + Normalize (pure TS, no browser)
Inputs: .epub
Outputs (intermediate in-memory structures):

Spine-ordered chapters

Normalized chapter content (limited supported markup)

Media overlay mapping:

ordered spans with { chapterId, anchorRef, textRange?, audioFile, tStartMs, tEndMs }

What we support (v1 constraints)

Supported tags: p, h1-h3, li, blockquote, em, strong, span

Ignore scripts, forms, floats, tables, SVG, MathML

Minimal CSS interpretation:

font weight/style

maybe smallcaps/underline (optional)

no complex layout

SMIL mapping rules

Map each <par> to a highlightable “span unit”

v1 highlights at SMIL granularity (sentence/phrase), not word-level unless timing is word-level.

Stage B: Pagination + Rect Extraction (Playwright)
Inputs:

Normalized chapter HTML generated from Stage A

Span identifiers injected into DOM as stable markers

Device profile: { viewportW, viewportH, margins, fontName, fontSize, lineHeight }

Outputs:

Pages with positioned text (optional) and span rects per page

Page navigation info: prev/next, firstSpanId/lastSpanId

Key mechanism

For each span, wrap its DOM range with an element (or markers) like:

<span data-span-id="123">...</span>

Use DOM APIs:

element.getClientRects() or Range.getClientRects() to capture rect(s)

Convert CSS pixel rects → page-local rects (subtract page origin).

Output Bundle Contract (v1)
A compiled bundle is a ZIP with the following structure:

```
cppbook.bundle.zip
  meta.json
  toc.json
  spans.jsonl
  pages/
    ch0_p0001.json
    ch0_p0002.json
    ...
  audio/
    ...
  fonts/
    ... (optional if runtime needs them; likely no)
```

meta.json

bundleVersion

bookId (hash of input EPUB + compiler version + device profile)

deviceProfile (viewport, margins, typography)

counts: chapters/pages/spans

audio manifest

spans.jsonl
Each line:

spanId, chapterId

tStartMs, tEndMs

audioHref

pageId (optional but helpful for runtime)

optionally textPreview for debugging

pages/*.json
Per page:

pageId, chapterId, pageIndex

textRuns (optional in v1 if runtime will render differently; if runtime draws itself, include runs)

spanRects: { [spanId]: [ {x,y,w,h}, ... ] }

firstSpanId, lastSpanId

prevPageId, nextPageId

Note: Start with JSON for debuggability. Once stable, switch to binary (.bin) to reduce parse overhead on-device.

CLI Contract
Command

```
cssepub-mo-compile compile \\
  --input /path/book.epub \\
  --output /path/book.bundle.zip \\
  --profile manta \\
  --config /path/config.json
```

Exit codes

0: success

2: validation error (bad config, missing SMIL refs)

3: compilation failure (unexpected exception)

4: nondeterminism detected (optional mode)

Useful flags

--debug-dump /path/dir writes intermediate HTML, extracted rects, and logs

--validate-only parses and validates EPUB + overlays without pagination

--stats prints timings, counts, and max rect counts per span

--strict fails on any missing anchor/time anomalies

Docker & Deployment
Docker image goals

Fully deterministic environment:

Node + dependencies

Playwright Chromium

bundled fonts

locale and timezone pinned

Dockerfile outline (high-level)

Base: mcr.microsoft.com/playwright:<version>-jammy (recommended)

This already includes the browser deps.

Copy fonts into /usr/local/share/fonts and run fc-cache -f

Set:

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

Install dependencies using lockfile

Entrypoint: epub-mo-compile

Server usage

Run as a one-shot job (Kubernetes job / ECS task / systemd timer / CI worker)

Input from:

uploaded EPUB

or S3/GCS

Output to:

object storage (recommended)

or local disk artifact store

Repository Structure

```
bash/compiler
  /src
    /cli
    /epub
      container.ts
      opf.ts
      xhtml_normalize.ts
      smil_parse.ts
      overlay_align.ts
    /layout
      render_chapter_html.ts
      playwright_paginate.ts
      rect_extract.ts
    /bundle
      bundle_writer.ts
      schemas.ts
    /device_profiles
      manta.json
  /test
    fixtures/
      simple_mo.epub
      ...
    golden/
      manta_simple_spans.jsonl
      manta_simple_pages/
  Dockerfile
  package.json
  tsconfig.json
```

Acceptance Tests (compiler-level)

Overlay resolution

Every SMIL <par> resolves to a text location; missing anchors are warnings or errors per --strict.

Time monotonicity

Span times are non-decreasing; overlaps are either normalized or rejected (configurable).

Rect coverage

For each span on each page: at least one rect, rects are within page bounds.

Determinism

Compile the same EPUB twice → byte-identical bundle (or identical JSON after stable ordering).

If byte-identical is too strict for v1, compare normalized JSON.

Notes for the coding agent

Don’t try to support general EPUB/CSS. Support a strict subset and document it.

Do treat Playwright as a “layout oracle.” Keep its responsibilities narrow:

given normalized HTML + spans → return pages + rects

Keep runtime in mind: output should be optimized for fast parsing and simple lookups.

If you want, next I can write the complementary doc sections that will make an agent productive immediately:

“Device profile: Supernote Manta assumptions” (viewport size, margins, refresh policy)

“Normalization rules” (exact tag handling + whitespace rules)

“Playwright pagination algorithm” (how to force deterministic paging: CSS columns vs manual splitting)

---

### **You**

help me come up with a good project name

---

### **ChatGPT**

Nice problem 😄 — this feels like something that wants a name that signals precision, alignment, and reading as playback, without sounding like a generic ebook app.
I’ll group ideas by vibe, then give a few top recommendations I think fit your constraints best.

Top-tier recommendations (my strongest picks)
1. Cadence
Why it works

Literally means rhythm / timing

Strong association with audio + pacing

Short, serious, and technical enough for an internal compiler + runtime

Works well with subcomponents:

cadence-compiler

cadence-reader

cadence-bundle

This is my #1 pick for your problem.

2. Luma
Why it works

Implies clarity and readability (light)

Feels calm and focused—good for e-ink

Modern, minimal, not tied to EPUB specifically

Works well for a “rendered book” concept

Downside: common name, harder to namespace.

3. Syncra
(sync + era)

Why it works

Explicitly about synchronization

Feels engineered rather than literary

Good for a system where correctness matters more than flair

4. Folio
Why it works

Classic publishing term

Suggests a compiled, paginated artifact

Very natural naming for bundles:

folio build

folio bundle

Downside: widely used, but still strong.

5. Glyph
Why it works

Text-centric

Suggests rendering and layout

Short, sharp, technical

Names that emphasize precision / alignment
These lean into the “this must match exactly” constraint.

Tactus – Latin for beat / touch (used in music timing)

Meter – Rhythm + measurement (also ties to pagination)

Axis – Alignment and reference frames

Phase – Time-based progression

Lockstep – Strong sync implication (maybe too literal)

Names that feel bookish but technical

Scriptum – Latin “written”

Codex – Bound manuscript; very on-theme

Palimpsest – Literary, but maybe too abstract

Leaf – Page metaphor, simple

Verso – Publishing term (page sides)

Names that feel quiet / e-ink appropriate
Good for a focused reading appliance.

Still

Hush

Calm

Mono

Plain

These are aesthetically nice but less descriptive.

System-style names (great for an internal platform)
If this is more “infrastructure” than “product”:

Readline (great pun, but conflicts in dev contexts)

Playback

Narrate

Align

Spine (EPUB spine 👀 — very good internal name)

My recommended short list (ranked)

Cadence ⭐⭐⭐⭐⭐

Best balance of meaning, seriousness, and extensibility

Codex ⭐⭐⭐⭐

Excellent literary + compiled artifact connotation

Spine ⭐⭐⭐⭐

Perfect internal EPUB reference; very engineer-y

Tactus ⭐⭐⭐⭐

Deeply correct for audio-timed reading

Glyph ⭐⭐⭐

Strong, minimal, layout-oriented

How I’d name the pieces (example with Cadence)

Project: Cadence

Compiler: cadence-compile

Runtime: cadence-reader

Artifact: cadence.bundle

Spec: Cadence Bundle Format v1

This reads extremely clean in docs and code.

If you want, tell me:

internal vs public?

more literary or more engineered?

one-word only vs compound allowed?

I can narrow it to a single final recommendation and even sanity-check naming collisions in common OSS ecosystems.

---
