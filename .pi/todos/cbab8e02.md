{
  "id": "cbab8e02",
  "title": "Investigate parakeet-mlx output format and word timestamps",
  "tags": [
    "research",
    "stt",
    "parakeet"
  ],
  "status": "closed",
  "created_at": "2026-02-01T07:24:53.853Z"
}

# Research: parakeet-mlx Word Timestamps - CONFIRMED

✅ `parakeet-mlx --highlight-words` provides word-level timestamps!

https://github.com/senstella/parakeet-mlx

## Next Step
Create adapter (TODO-b415e185) to:
1. Call parakeet-mlx CLI with `--highlight-words`
2. Parse output into our `Transcription` format:
```typescript
type Transcription = {
  transcript: string;
  wordTimeline: Array<{
    text?: string;
    startTime: number;
    endTime: number;
    startOffsetUtf16: number;
    endOffsetUtf16: number;
    audiofile: string;
  }>;
};
```
