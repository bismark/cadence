package com.cadence.player.data

import android.content.Context
import com.cadence.player.perf.PerfLog
import kotlinx.serialization.json.Json
import java.io.File
import java.util.zip.ZipFile

/**
 * Loads Cadence bundles from disk
 */
object BundleLoader {

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    /**
     * Load a bundle from a directory or ZIP path
     */
    fun loadBundle(context: Context, bundlePath: String): CadenceBundle {
        val loadStartNs = if (PerfLog.enabled) System.nanoTime() else 0L

        val resolveStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
        val bundleDir = resolveBundleDir(context, bundlePath)
        val resolveNs = if (PerfLog.enabled) System.nanoTime() - resolveStartNs else 0L

        // Load metadata
        val metaStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
        val metaFile = File(bundleDir, "meta.json")
        require(metaFile.exists()) { "meta.json not found in bundle" }
        val meta = json.decodeFromString<BundleMeta>(metaFile.readText())
        val metaNs = if (PerfLog.enabled) System.nanoTime() - metaStartNs else 0L

        // Load spans
        val spansStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
        val spansFile = File(bundleDir, "spans.jsonl")
        require(spansFile.exists()) { "spans.jsonl not found in bundle" }
        val spans = spansFile.readLines()
            .filter { it.isNotBlank() }
            .map { json.decodeFromString<SpanEntry>(it) }
        val spansNs = if (PerfLog.enabled) System.nanoTime() - spansStartNs else 0L

        // Load pages
        val pagesStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
        val pagesDir = File(bundleDir, "pages")
        require(pagesDir.exists() && pagesDir.isDirectory) { "pages directory not found in bundle" }

        val pages = pagesDir.listFiles()
            ?.filter { it.extension == "json" }
            ?.map { json.decodeFromString<Page>(it.readText()) }
            ?.sortedBy { it.pageIndex }
            ?: emptyList()
        val pagesNs = if (PerfLog.enabled) System.nanoTime() - pagesStartNs else 0L

        // Load table of contents
        val tocStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
        val tocFile = File(bundleDir, "toc.json")
        val toc = if (tocFile.exists()) {
            json.decodeFromString<List<TocEntry>>(tocFile.readText())
        } else {
            emptyList()
        }
        val tocNs = if (PerfLog.enabled) System.nanoTime() - tocStartNs else 0L

        val bundle = CadenceBundle(
            meta = meta,
            spans = spans,
            pages = pages,
            toc = toc,
            basePath = bundleDir.absolutePath
        )

        if (PerfLog.enabled) {
            val totalNs = System.nanoTime() - loadStartNs
            PerfLog.d(
                "bundle load pages=${pages.size} spans=${spans.size} resolve=${PerfLog.formatNs(resolveNs)}ms meta=${PerfLog.formatNs(metaNs)}ms spans=${PerfLog.formatNs(spansNs)}ms pages=${PerfLog.formatNs(pagesNs)}ms toc=${PerfLog.formatNs(tocNs)}ms total=${PerfLog.formatNs(totalNs)}ms"
            )
        }

        return bundle
    }

    private fun resolveBundleDir(context: Context, bundlePath: String): File {
        val bundleFile = File(bundlePath)
        require(bundleFile.exists()) { "Bundle path does not exist: $bundlePath" }

        if (bundleFile.isDirectory) {
            return bundleFile
        }

        if (bundleFile.isFile && bundleFile.extension.lowercase() == "zip") {
            return extractBundleZip(context, bundleFile)
        }

        throw IllegalArgumentException("Bundle path is not a directory or zip file: $bundlePath")
    }

    private fun extractBundleZip(context: Context, bundleFile: File): File {
        val extractStartNs = if (PerfLog.enabled) System.nanoTime() else 0L

        val cacheRoot = File(context.cacheDir, "bundles")
        val extractDir = File(cacheRoot, bundleFile.nameWithoutExtension)
        val markerFile = File(extractDir, ".source")
        val sourceStamp = bundleFile.lastModified().toString()

        if (extractDir.exists() && markerFile.exists() && markerFile.readText() == sourceStamp) {
            if (PerfLog.enabled) {
                PerfLog.d(
                    "bundle zip cache-hit file=${bundleFile.name} in=${PerfLog.formatNs(System.nanoTime() - extractStartNs)}ms"
                )
            }
            return extractDir
        }

        if (extractDir.exists()) {
            extractDir.deleteRecursively()
        }
        extractDir.mkdirs()
        cacheRoot.mkdirs()

        val targetRoot = extractDir.canonicalFile.toPath()
        var extractedEntries = 0

        ZipFile(bundleFile).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                extractedEntries++

                val outFile = File(extractDir, entry.name)
                val outPath = outFile.canonicalFile.toPath()

                if (!outPath.startsWith(targetRoot)) {
                    throw IllegalArgumentException("Zip entry escapes bundle dir: ${entry.name}")
                }

                if (entry.isDirectory) {
                    outFile.mkdirs()
                } else {
                    outFile.parentFile?.mkdirs()
                    zip.getInputStream(entry).use { input ->
                        outFile.outputStream().use { output ->
                            input.copyTo(output)
                        }
                    }
                }
            }
        }

        markerFile.writeText(sourceStamp)

        if (PerfLog.enabled) {
            PerfLog.d(
                "bundle zip extract file=${bundleFile.name} entries=$extractedEntries total=${PerfLog.formatNs(System.nanoTime() - extractStartNs)}ms"
            )
        }

        return extractDir
    }
}
