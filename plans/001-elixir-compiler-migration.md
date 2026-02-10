# Cadence Compiler → Elixir Migration Plan (Chrome Sidecar Approach)

## Goal

Rebuild the Cadence compiler in Elixir while **retaining headless Chrome** for layout/pagination geometry extraction, and preserve bundle/output compatibility with the current TypeScript implementation.

## Constraints and Assumptions

- Keep Chromium-based pagination logic (DOM/CSS/`Range.getClientRects`) to avoid layout drift.
- Preserve bundle format compatibility (`meta.json`, `toc.json`, `spans.jsonl`, `pages/*.json`, `audio.opus`).
- Continue using FFmpeg/FFprobe and Parakeet CLI via subprocesses.
- Migrate in phases with golden tests so we can stop at a stable hybrid if needed.

## Scope

### In scope
- `compile` pipeline port to Elixir first.
- Sidecar interface for pagination (Node/Playwright process).
- Optional sidecar retention for alignment during early phases.
- CLI parity for `compile`, then `inspect`, then `align`, then `preview`.

### Out of scope (initially)
- Replacing Chrome with a non-browser layout engine.
- Perfect byte-for-byte parity on page JSON ordering/float formatting (semantic parity is sufficient).

---

## Target Architecture

## 1) Elixir Orchestrator (primary app)
Responsible for:
- CLI command parsing and pipeline orchestration
- EPUB ZIP and XML parsing
- SMIL extraction and clip time normalization
- XHTML normalization/tagging orchestration
- Span/page post-processing (`split-spans-across-pages`, validation)
- Bundle writing and audio concatenation orchestration

## 2) Pagination Sidecar (Node + Playwright)
Responsible for:
- Receiving normalized chapter HTML + profile
- Running existing CSS columns + geometry extraction logic
- Returning structured page payloads (`textRuns`, `spanRects`, page metadata)

This sidecar should initially reuse existing `compiler/src/layout/paginate.ts` logic as directly as possible.

## 3) Optional Alignment Sidecar (phase-gated)
Two options:
- **Option A (recommended initially):** keep alignment in TS sidecar until compile path is production-ready.
- **Option B:** port align logic to Elixir once baseline compile parity is stable.

---

## Module Mapping (Current TS → Proposed Elixir)

| Current TS module | Proposed Elixir module | Notes |
|---|---|---|
| `epub/container.ts` | `Cadence.Compiler.Epub.Container` | ZIP entry index + file reads |
| `epub/opf.ts` | `Cadence.Compiler.Epub.Opf` | OPF parsing + spine/media overlays |
| `epub/smil.ts` | `Cadence.Compiler.Epub.Smil` | SMIL parse + clip parsing |
| `epub/xhtml.ts` | `Cadence.Compiler.Epub.Xhtml` | Normalize + span tagging hooks |
| `layout/paginate.ts` | sidecar (`cadence-paginator`) + `Cadence.Compiler.Layout.Client` | JSON contract boundary |
| `layout/split-spans-across-pages.ts` | `Cadence.Compiler.Layout.SplitSpans` | pure Elixir |
| `audio/concat.ts` | `Cadence.Compiler.Audio.Concat` | FFmpeg/FFprobe via `System.cmd/3` or Port |
| `bundle/writer.ts` | `Cadence.Compiler.Bundle.Writer` | zip/uncompressed writing |
| `validation.ts` | `Cadence.Compiler.Validation` | same checks |
| `index.ts` | `Cadence.Compiler.CLI` | command layer |
| `align/*` | `Cadence.Compiler.Align.*` (later) or sidecar | phase-gated |

---

## Migration Phases

## Phase 0 — Baseline + Golden Harness (1 week)

### Deliverables
- Freeze known-good TS outputs for fixtures:
  - `Advanced-Accessibility-Tests...epub`
  - `moby-dick.epub`
- Golden comparator tool (JSON semantic compare + tolerances for geometry ordering where needed).
- CI job that runs TS compiler and records baseline artifacts.

### Exit criteria
- We can detect regressions in spans/pages/toc/meta quickly and reliably.

## Phase 1 — Elixir Project Skeleton + Shared Types (1 week)

### Deliverables
- New OTP app (or umbrella if preferred): `cadence_compiler`.
- Structs mirroring current core types (`Span`, `Page`, `TextRun`, etc.).
- CLI scaffold (`mix escript.build` or release command).
- Device profile definitions.

### Exit criteria
- `cadence compile --help` works from Elixir entrypoint.

## Phase 2 — EPUB/OPF/SMIL/XHTML Port (1–2 weeks)

### Deliverables
- Port of EPUB container reading and path resolution.
- OPF manifest/spine/media overlay extraction.
- SMIL parsing + clip time conversion logic parity.
- XHTML normalization + data-span-id wiring with equivalent behavior.

### Exit criteria
- Elixir can emit chapter-level intermediate outputs equivalent to TS for fixtures.

## Phase 3 — Pagination Sidecar Contract + Integration (1–2 weeks)

### Deliverables
- Define stable JSON schema for paginator requests/responses.
- Extract current `paginate.ts` into sidecar command/API:
  - input: normalized chapters + profile
  - output: paginated pages with textRuns/spanRects
- Elixir `Layout.Client` implementation with retries/timeouts.

### Exit criteria
- Elixir compile pipeline can produce pages through sidecar end-to-end.

## Phase 4 — Post-Processing + Bundle Writer + Audio Concat (1 week)

### Deliverables
- Port `split-spans-across-pages` exactly.
- Port span→page assignment + ToC generation.
- Port bundle writer (zip and uncompressed).
- Port audio concatenation + offset application.

### Exit criteria
- `compile` command from Elixir produces a complete bundle for fixtures.

## Phase 5 — Validation + Parity Hardening (1–2 weeks)

### Deliverables
- Port validation checks.
- Golden diff tooling integrated with CI.
- Fix parity drift in:
  - span counts/IDs
  - page counts/indexing
  - timing continuity
  - toc/page start mapping

### Exit criteria
- Elixir compile path passes fixture parity gates.

## Phase 6 — Align Command Strategy (2–4 weeks, parallelizable)

### Option A (recommended first)
- Keep TS align implementation as sidecar callable from Elixir.
- Ship Elixir compile first, align as delegated command.

### Option B (full port)
- Port sentence extraction/tokenization/fuzzy matching/parakeet adapters.
- Reconcile tokenization differences with language model/library differences.

### Exit criteria
- `align` command passes acceptance tests for timing quality and structure.

## Phase 7 — Inspect + Preview + Cutover (1 week)

### Deliverables
- Port `inspect` and `preview` commands.
- Performance test run and memory profiling.
- Documentation update + deprecation path for TS compiler.

### Exit criteria
- Elixir CLI can replace TS CLI in normal developer workflow.

---

## Data Contract: Elixir ↔ Paginator Sidecar

## Request shape (conceptual)
- `profile`: viewport, margins, typography
- `chapters[]`:
  - `chapterId`
  - `html` (already normalized)

## Response shape (conceptual)
- `pages[]`:
  - `pageId`, `chapterId`, `pageIndex`
  - `width`, `height`
  - `textRuns[]`
  - `spanRects[]`
  - `firstSpanId`, `lastSpanId`

### Contract requirements
- Stable schema version field
- Deterministic sort behavior
- Explicit error payloads (not just process exit code)

---

## Testing Strategy

## 1) Golden fixture tests
- Compare Elixir output to TS baseline for:
  - meta fields
  - span count + id set + timing monotonicity
  - page count + page index continuity
  - toc entry count and page mapping

## 2) Property/invariant tests
- No duplicate span IDs
- All timed spans have `clipEndMs > clipBeginMs`
- Page rects have positive dimensions
- Span-to-page lookup coverage thresholds

## 3) Sidecar contract tests
- Schema validation on both sides
- Timeout and restart behavior
- Broken HTML / malformed inputs handling

## 4) End-to-end smoke tests
- Compile fixture and push bundle to emulator/device
- Manual read-through spot-checks for highlighting sync

---

## Risks and Mitigations

1. **Parser behavior drift (XHTML/XML)**
   - Mitigation: preserve normalization semantics; add chapter-level intermediate goldens.

2. **Layout drift across environments**
   - Mitigation: pin Chromium/Playwright versions in sidecar; containerize sidecar runtime.

3. **Alignment quality drift**
   - Mitigation: delay full align port; keep sidecar alignment until metrics are acceptable.

4. **Subprocess reliability (ffmpeg/parakeet/paginator)**
   - Mitigation: explicit retries, structured stderr capture, timeout + cleanup, health checks.

5. **Migration fatigue from big-bang rewrite**
   - Mitigation: phased delivery with production-usable checkpoints.

---

## Suggested Milestones

- **M1:** Elixir compile pipeline works with sidecar pagination for one fixture.
- **M2:** Fixture parity (compile) at acceptance threshold.
- **M3:** `inspect` and `preview` parity.
- **M4:** `align` delegated or fully ported.
- **M5:** TS compiler optional/deprecated.

---

## First 10 Tasks I Would Execute

1. Create `cadence_compiler` Elixir app with type structs and CLI shell.
2. Add fixture baseline generation script from current TS compiler.
3. Build semantic diff tool for bundle outputs.
4. Port EPUB container + OPF parser.
5. Port SMIL parser + `parseClipTime` tests.
6. Port XHTML normalization and span tagging glue.
7. Extract paginator sidecar from existing `paginate.ts` with contract v1.
8. Implement Elixir sidecar client with robust error handling.
9. Port split-spans + span→page assignment + ToC.
10. Port bundle writer + audio concat/offset application.

---

## Recommendation

Use a **hybrid-first migration**: Elixir orchestrator + Node/Playwright pagination sidecar (and optionally alignment sidecar). This gives the best chance of preserving rendering/timing behavior while still moving the compiler core into Elixir quickly and safely.