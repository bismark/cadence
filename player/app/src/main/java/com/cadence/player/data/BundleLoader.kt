package com.cadence.player.data

import kotlinx.serialization.json.Json
import java.io.File

/**
 * Loads Cadence bundles from disk
 */
object BundleLoader {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /**
     * Load a bundle from a directory path
     */
    fun loadBundle(bundlePath: String): CadenceBundle {
        val bundleDir = File(bundlePath)
        require(bundleDir.exists() && bundleDir.isDirectory) {
            "Bundle path does not exist or is not a directory: $bundlePath"
        }

        // Load metadata
        val metaFile = File(bundleDir, "meta.json")
        require(metaFile.exists()) { "meta.json not found in bundle" }
        val meta = json.decodeFromString<BundleMeta>(metaFile.readText())

        // Load spans
        val spansFile = File(bundleDir, "spans.jsonl")
        require(spansFile.exists()) { "spans.jsonl not found in bundle" }
        val spans = spansFile.readLines()
            .filter { it.isNotBlank() }
            .map { json.decodeFromString<SpanEntry>(it) }

        // Load pages
        val pagesDir = File(bundleDir, "pages")
        require(pagesDir.exists() && pagesDir.isDirectory) { "pages directory not found in bundle" }

        val pages = pagesDir.listFiles()
            ?.filter { it.extension == "json" }
            ?.map { json.decodeFromString<Page>(it.readText()) }
            ?.sortedBy { it.pageIndex }
            ?: emptyList()

        // Load table of contents
        val tocFile = File(bundleDir, "toc.json")
        val toc = if (tocFile.exists()) {
            json.decodeFromString<List<TocEntry>>(tocFile.readText())
        } else {
            emptyList()
        }

        return CadenceBundle(
            meta = meta,
            spans = spans,
            pages = pages,
            toc = toc,
            basePath = bundlePath
        )
    }
}
