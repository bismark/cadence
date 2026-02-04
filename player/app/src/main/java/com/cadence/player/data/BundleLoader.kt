package com.cadence.player.data

import android.content.Context
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
        val bundleDir = resolveBundleDir(context, bundlePath)

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
            basePath = bundleDir.absolutePath
        )
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
        val cacheRoot = File(context.cacheDir, "bundles")
        val extractDir = File(cacheRoot, bundleFile.nameWithoutExtension)
        val markerFile = File(extractDir, ".source")
        val sourceStamp = bundleFile.lastModified().toString()

        if (extractDir.exists() && markerFile.exists() && markerFile.readText() == sourceStamp) {
            return extractDir
        }

        if (extractDir.exists()) {
            extractDir.deleteRecursively()
        }
        extractDir.mkdirs()
        cacheRoot.mkdirs()

        val targetRoot = extractDir.canonicalFile.toPath()

        ZipFile(bundleFile).use { zip ->
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
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
        return extractDir
    }
}
