{
  "id": "70aca6db",
  "title": "Limit ffprobe concurrency when probing audio durations",
  "tags": [
    "compiler",
    "performance",
    "P2"
  ],
  "status": "closed",
  "created_at": "2026-02-04T07:21:47.014Z"
}

Added bounded concurrency for ffprobe duration probes with a small worker pool (mapWithConcurrency + PROBE_CONCURRENCY) in compiler/src/audio/concat.ts for both concatenateAudio and concatenateAudioFiles.
