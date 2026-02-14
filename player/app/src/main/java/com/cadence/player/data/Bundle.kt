package com.cadence.player.data

import kotlinx.serialization.Serializable
import java.io.File

/**
 * Bundle metadata from meta.json
 */
@Serializable
data class BundleMeta(
    val bundleVersion: String,
    val bundleId: String? = null,  // Stable identifier (from dc:identifier or hash)
    val profile: String,
    val title: String,
    val audioFile: String,
    val pages: Int,
    val spans: Int
)

/**
 * A span entry from spans.jsonl
 * Note: clipBeginMs/clipEndMs are global timestamps in the single bundle audio file
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
    val inkGray: Int  // 0=black, 255=white
)

/**
 * A positioned text run on a page
 */
@Serializable
data class TextRun(
    val text: String,
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float,
    val baselineY: Float,
    val spanId: String? = null,
    val style: TextStyle
)

/**
 * A rectangle for highlighting
 */
@Serializable
data class Rect(
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float
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
    val contentX: Float,
    val contentY: Float,
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
     * Path to the single bundle audio file
     */
    val audioPath: String = resolveBundleAudioPath(basePath, meta.audioFile)

    private val timedSpans: List<SpanEntry> by lazy {
        spans
            .filter { it.clipBeginMs >= 0 && it.clipEndMs > it.clipBeginMs }
            .sortedBy { it.clipBeginMs }
    }

    /**
     * Find the span active at a given timestamp using binary search.
     * Timestamps are global offsets into the single bundle audio file.
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

    private fun resolveBundleAudioPath(basePath: String, audioFile: String): String {
        val value = audioFile.trim()
        require(value.isNotEmpty()) { "Invalid meta.audioFile: value is empty" }

        val isUnixAbsolute = value.startsWith("/") || value.startsWith("\\")
        require(!isUnixAbsolute && !WINDOWS_ABSOLUTE_PATH_REGEX.matches(value)) {
            "Invalid meta.audioFile \"$audioFile\": absolute paths are not allowed"
        }

        val baseDir = File(basePath).canonicalFile
        val resolvedPath = File(baseDir, value).canonicalFile

        require(resolvedPath.toPath().startsWith(baseDir.toPath())) {
            "Invalid meta.audioFile \"$audioFile\": path escapes bundle directory"
        }

        require(resolvedPath.exists() && resolvedPath.isFile) {
            "Audio file referenced by meta.audioFile was not found: $audioFile"
        }

        return resolvedPath.absolutePath
    }

    private companion object {
        private val WINDOWS_ABSOLUTE_PATH_REGEX = Regex("^[a-zA-Z]:([/\\\\].*|$)")
    }
}
