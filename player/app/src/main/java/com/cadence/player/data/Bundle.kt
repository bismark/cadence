package com.cadence.player.data

import kotlinx.serialization.Serializable

/**
 * Bundle metadata from meta.json
 */
@Serializable
data class BundleMeta(
    val bundleVersion: String,
    val profile: String,
    val title: String,
    val pages: Int,
    val spans: Int
)

/**
 * A span entry from spans.jsonl
 */
@Serializable
data class SpanEntry(
    val id: String,
    val audioSrc: String,
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
    val basePath: String  // Path to bundle directory for audio files
) {
    /**
     * Find the span active at a given timestamp
     */
    fun findSpanAtTime(timestampMs: Double): SpanEntry? {
        return spans.find { span ->
            timestampMs >= span.clipBeginMs &&
            timestampMs < span.clipEndMs
        }
    }

    /**
     * Get page by index
     */
    fun getPage(index: Int): Page? = pages.getOrNull(index)

    /**
     * Get audio file path for a span
     */
    fun getAudioPath(span: SpanEntry): String {
        return "$basePath/audio/${span.audioSrc.substringAfterLast('/')}"
    }
}
