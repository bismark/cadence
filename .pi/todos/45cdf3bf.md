{
  "id": "45cdf3bf",
  "title": "Use binary search in findSpanAtTime() for 20Hz polling loop",
  "tags": [
    "player",
    "performance",
    "P2"
  ],
  "status": "closed",
  "created_at": "2026-02-01T06:41:25.217Z"
}

## Fixed

Replaced O(n) linear search with O(log n) binary search using Kotlin's `binarySearchBy`.

```kotlin
fun findSpanAtTime(timestampMs: Double): SpanEntry? {
    if (spans.isEmpty()) return null
    val index = spans.binarySearchBy(timestampMs) { it.clipBeginMs }
    val spanIndex = if (index >= 0) index else -(index + 1) - 1
    if (spanIndex < 0) return null
    val span = spans[spanIndex]
    return if (timestampMs < span.clipEndMs) span else null
}
```

For 1000 spans: ~10 comparisons instead of ~500 average.

## File
`player/app/src/main/java/com/cadence/player/data/Bundle.kt`
