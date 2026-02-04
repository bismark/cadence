{
  "id": "e3a92efa",
  "title": "Design standalone forced alignment CLI architecture",
  "tags": [
    "design",
    "architecture"
  ],
  "status": "closed",
  "created_at": "2026-02-01T07:23:55.090Z"
}

# Forced Alignment CLI Extraction from Storyteller

## Status: COMPLETE

Design implemented with one deviation: outputs Cadence bundle directly instead of EPUB+SMIL (simpler, avoids intermediate format).

## Completed:
- ✅ Core sync files extracted to `compiler/src/align/`
- ✅ wink-nlp + wink-eng-lite-web-model for sentence tokenization
- ✅ parakeet-mlx adapter (`parakeet.ts`)
- ✅ CLI `align` command
- ✅ Test suite (17 tests) with Moby Dick fixtures

## Remaining work tracked separately:
- TODO-61920a46: Reconcile audio handling (multiple files vs concatenated)
