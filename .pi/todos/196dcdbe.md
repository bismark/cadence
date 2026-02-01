{
  "id": "196dcdbe",
  "title": "Add TTS mode: generate Media Overlays from plain EPUB via forced alignment",
  "tags": [
    "compiler",
    "feature",
    "wishlist",
    "tts"
  ],
  "status": "open",
  "created_at": "2026-02-01T06:48:42.347Z"
}

## Goal
Allow compiling plain EPUBs (no audio) by generating synchronized audio via TTS and forced alignment.

## Pipeline
1. Extract text from EPUB chapters
2. Generate audio via TTS (e.g., OpenAI TTS, Coqui, Piper)
3. Run forced alignment (e.g., Aeneas, Whisper-based) to get word/sentence timestamps
4. Generate SMIL-equivalent timing data
5. Continue with normal bundle compilation

## Considerations
- TTS voice selection
- Sentence vs word-level alignment
- Cost if using cloud TTS APIs
- Quality of alignment on complex text
- Caching generated audio for re-compilation

## Dependencies
- TTS engine integration
- Forced alignment tool (Aeneas, Whisper, etc.)
