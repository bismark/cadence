package com.cadence.player.data

import kotlinx.serialization.Serializable

/**
 * Bundle metadata from meta.json
 */
@Serializable
data class BundleMeta(
    val bundleVersion: String,
    val bundleId: String? = null,  // Stable identifier (from dc:identifier or hash)
    val profile: String,
    val title: String,
    val pages: Int,
    val spans: Int
)

/**
 * A span entry from spans.jsonl
 * Note: clipBeginMs/clipEndMs are global timestamps in the single audio.opus file
 */
@Serializable
data class SpanEntry(
    val id: String,
    val clipBeginMs: Double,
    val clipEndMs: Double,
    val pageIndex: Int
)

/**
 * Table of contents entry
 */
@Serializable
data class TocEntry(
    val title: String,
    val pageIndex: Int
)

/**
 * Text styling information
 */
@Serializable
data class TextStyle(
    val fontFamily: String,
    val fontSize: Float,
    val fontWeight: Int,
    val fontStyle: String,  // "normal" or "italic"
    val color: String
)

/**
 * A positioned text run on a page
 */
@Serializable
data class TextRun(
    val text: String,
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
    val spanId: String? = null,
    val style: TextStyle
)

/**
 * A rectangle for highlighting
 */
@Serializable
data class Rect(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int
)

/**
 * Span rectangles on a page
 */
@Serializable
data class PageSpanRect(
    val spanId: String,
    val rects: List<Rect>
)

/**
 * A page with text runs and span rectangles
 */
@Serializable
data class Page(
    val pageId: String,
    val chapterId: String,
    val pageIndex: Int,
    val width: Int,
    val height: Int,
    val textRuns: List<TextRun>,
    val spanRects: List<PageSpanRect>,
    val firstSpanId: String,
    val lastSpanId: String
)

/**
 * A loaded Cadence bundle
 */
data class CadenceBundle(
    val meta: BundleMeta,
    val spans: List<SpanEntry>,
    val pages: List<Page>,  // Ordered by pageIndex
    val toc: List<TocEntry>,
    val basePath: String  // Path to bundle directory
) {
    /**
     * Path to the single audio file
     */
    val audioPath: String get() = "$basePath/audio.opus"

    private val timedSpans: List<SpanEntry> by lazy {
        spans
            .filter { it.clipBeginMs >= 0 && it.clipEndMs > it.clipBeginMs }
            .sortedBy { it.clipBeginMs }
    }

    /**
     * Find the span active at a given timestamp using binary search.
     * Timestamps are global offsets into the single audio.opus file.
     * Uses only spans with valid timing.
     */
    fun findSpanAtTime(timestampMs: Double): SpanEntry? {
        if (timedSpans.isEmpty()) return null

        val index = timedSpans.binarySearchBy(timestampMs) { it.clipBeginMs }
        val spanIndex = if (index >= 0) index else -(index + 1) - 1
        if (spanIndex < 0) return null

        val span = timedSpans[spanIndex]
        return if (timestampMs < span.clipEndMs) span else null
    }

    /**
     * Find the next span starting at or after the given timestamp.
     */
    fun findNextSpanAfter(timestampMs: Double): SpanEntry? {
        if (timedSpans.isEmpty()) return null

        val index = timedSpans.binarySearchBy(timestampMs) { it.clipBeginMs }
        val insertionIndex = if (index >= 0) index else -(index + 1)
        return timedSpans.getOrNull(insertionIndex)
    }

    /**
     * Get the last span with valid timing.
     */
    fun getLastTimedSpan(): SpanEntry? = timedSpans.lastOrNull()

    /**
     * Get page by index
     */
    fun getPage(index: Int): Page? = pages.getOrNull(index)

    /**
     * Lazy index for O(1) span lookups by ID
     */
    private val spanIndex: Map<String, SpanEntry> by lazy {
        spans.associateBy { it.id }
    }

    /**
     * Get span by ID in O(1) time
     */
    fun getSpanById(id: String): SpanEntry? = spanIndex[id]
}
