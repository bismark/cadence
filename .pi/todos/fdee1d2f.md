{
  "id": "fdee1d2f",
  "title": "Add span ID index map for O(1) lookups",
  "tags": [
    "player",
    "performance",
    "P3"
  ],
  "status": "closed",
  "created_at": "2026-02-01T06:41:38.002Z"
}

## Fixed

Added lazy `spanIndex` map and `getSpanById()` method to CadenceBundle:

```kotlin
private val spanIndex: Map<String, SpanEntry> by lazy {
    spans.associateBy { it.id }
}

fun getSpanById(id: String): SpanEntry? = spanIndex[id]
```

Updated 3 call sites in PlayerScreen.kt to use `getSpanById()` instead of `spans.find`.

O(n) → O(1) for span ID lookups.

## Files
- `player/app/src/main/java/com/cadence/player/data/Bundle.kt`
- `player/app/src/main/java/com/cadence/player/ui/PlayerScreen.kt`
