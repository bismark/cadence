package com.cadence.player.ui

import android.content.Context
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import com.cadence.player.data.Page
import com.cadence.player.data.TextRun
import com.cadence.player.data.TextStyle
import com.cadence.player.perf.PerfLog
import com.cadence.player.perf.RollingTimingStats

/**
 * Cached Noto Serif typefaces loaded from assets
 */
private class NotoSerifFonts(context: Context) {
    val regular: Typeface = Typeface.createFromAsset(context.assets, "fonts/NotoSerif-Regular.ttf")
    val bold: Typeface = Typeface.createFromAsset(context.assets, "fonts/NotoSerif-Bold.ttf")
    val italic: Typeface = Typeface.createFromAsset(context.assets, "fonts/NotoSerif-Italic.ttf")
    val boldItalic: Typeface = Typeface.createFromAsset(context.assets, "fonts/NotoSerif-BoldItalic.ttf")

    fun get(fontWeight: Int, fontStyle: String): Typeface {
        return when {
            fontWeight >= 700 && fontStyle == "italic" -> boldItalic
            fontWeight >= 700 -> bold
            fontStyle == "italic" -> italic
            else -> regular
        }
    }
}

private data class PaintKey(
    val fontFamily: String,
    val fontSize: Float,
    val fontWeight: Int,
    val fontStyle: String,
    val inkGray: Int
)

/**
 * Reuses android.graphics.Paint objects to avoid allocating one per text run per frame.
 */
private class TextPaintCache(private val serifFonts: NotoSerifFonts) {
    private val cache = mutableMapOf<PaintKey, android.graphics.Paint>()

    fun get(style: TextStyle): android.graphics.Paint {
        val inkGray = style.inkGray.coerceIn(0, 255)
        val normalizedFamily = style.fontFamily.trim().lowercase()

        val key = PaintKey(
            fontFamily = normalizedFamily,
            fontSize = style.fontSize,
            fontWeight = style.fontWeight,
            fontStyle = style.fontStyle,
            inkGray = inkGray
        )

        return cache.getOrPut(key) {
            android.graphics.Paint().apply {
                color = android.graphics.Color.rgb(inkGray, inkGray, inkGray)
                textSize = style.fontSize
                typeface = resolveTypeface(style, normalizedFamily)
                isAntiAlias = true
                isSubpixelText = true
                isLinearText = true
            }
        }
    }

    private fun resolveTypeface(style: TextStyle, normalizedFamily: String): Typeface {
        val isBold = style.fontWeight >= 700
        val isItalic = style.fontStyle == "italic"
        val androidStyle = when {
            isBold && isItalic -> Typeface.BOLD_ITALIC
            isBold -> Typeface.BOLD
            isItalic -> Typeface.ITALIC
            else -> Typeface.NORMAL
        }

        return when {
            normalizedFamily.contains("mono") -> Typeface.create(Typeface.MONOSPACE, androidStyle)
            normalizedFamily.contains("sans") -> Typeface.create(Typeface.SANS_SERIF, androidStyle)
            normalizedFamily.contains("noto serif") || normalizedFamily.contains("serif") ->
                serifFonts.get(style.fontWeight, style.fontStyle)

            else -> Typeface.create(Typeface.SERIF, androidStyle)
        }
    }
}

/**
 * Renders a page using Compose Canvas
 * Designed for e-ink grayscale rendering
 *
 * Coordinates from bundle are in pixels, matching the device profile.
 * Run/rect coordinates are page-local and anchored by bundle-provided content origin.
 *
 * @param debugMode When true, renders bounding boxes and baselines for debugging
 * @param onSpanTap Called when user taps on a span, with the span ID
 * @param onBackgroundTap Called when user taps outside any span
 */
@Composable
fun PageRenderer(
    page: Page,
    activeSpanId: String?,
    modifier: Modifier = Modifier,
    debugMode: Boolean = false,
    onSpanTap: (String) -> Unit = {},
    onBackgroundTap: () -> Unit = {}
) {
    val contentOriginX = page.contentX
    val contentOriginY = page.contentY

    // Load Noto Serif fonts from assets (cached per composition)
    val context = LocalContext.current
    val fonts = remember { NotoSerifFonts(context) }
    val paintCache = remember(fonts) { TextPaintCache(fonts) }
    val spanRectsById = remember(page.pageId) { page.spanRects.associateBy { it.spanId } }

    // Debug-only instrumentation
    val drawStats = remember(page.pageId) {
        RollingTimingStats("page-draw[p${page.pageIndex}]", reportEvery = 90, slowThresholdMs = 12.0)
    }
    val tapHitTestStats = remember(page.pageId) {
        RollingTimingStats("tap-hit-test[p${page.pageIndex}]", reportEvery = 30, slowThresholdMs = 2.5)
    }
    val recompositionCount = remember(page.pageId) { mutableIntStateOf(0) }

    SideEffect {
        if (PerfLog.enabled) {
            recompositionCount.intValue += 1
            if (recompositionCount.intValue % 100 == 0) {
                PerfLog.d(
                    "page renderer recomposed page=${page.pageIndex} count=${recompositionCount.intValue} activeSpan=${activeSpanId != null}"
                )
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.White)
            .pointerInput(page.pageId) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val startPosition = down.position
                    val startTimeMs = down.uptimeMillis

                    // Stricter-than-default tap detection to avoid swipe/drag false positives.
                    val maxTapMovementPx = viewConfiguration.touchSlop * 0.5f
                    val maxTapDurationMs = 220L
                    var rejected = false

                    while (true) {
                        val event = awaitPointerEvent()
                        if (event.changes.any { it.id != down.id && it.pressed }) {
                            rejected = true
                        }

                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        val movedDistancePx = (change.position - startPosition).getDistance()

                        if (movedDistancePx > maxTapMovementPx) {
                            rejected = true
                        }

                        if (change.uptimeMillis - startTimeMs > maxTapDurationMs) {
                            rejected = true
                        }

                        if (change.changedToUpIgnoreConsumed()) {
                            if (!rejected) {
                                val offset = change.position

                                // Convert tap position to content-local coordinates.
                                val contentX = offset.x - contentOriginX
                                val contentY = offset.y - contentOriginY

                                // Find if tap is within any span rectangle
                                val tappedSpanId = tapHitTestStats.measure {
                                    page.spanRects.find { spanRect ->
                                        spanRect.rects.any { rect ->
                                            contentX >= rect.x && contentX <= rect.x + rect.width &&
                                                contentY >= rect.y && contentY <= rect.y + rect.height
                                        }
                                    }?.spanId
                                }

                                if (tappedSpanId != null) {
                                    onSpanTap(tappedSpanId)
                                } else {
                                    onBackgroundTap()
                                }
                            }
                            break
                        }

                        if (!change.pressed) {
                            break
                        }
                    }
                }
            }
    ) {
        Canvas(
            modifier = Modifier.fillMaxSize()
        ) {
            val drawStartNs = if (PerfLog.enabled) System.nanoTime() else 0L

            // Debug: draw content area bounds
            if (debugMode) {
                drawRect(
                    color = Color.LightGray,
                    topLeft = Offset(contentOriginX, contentOriginY),
                    size = Size(page.width.toFloat(), page.height.toFloat()),
                    style = Stroke(width = 2f)
                )
            }

            // Draw highlight rectangles for active span FIRST (behind text)
            // Using light gray for e-ink visibility
            activeSpanId
                ?.let { spanRectsById[it] }
                ?.rects
                ?.forEach { rect ->
                    drawRect(
                        color = Color(0xFFD0D0D0),
                        topLeft = Offset(rect.x + contentOriginX, rect.y + contentOriginY),
                        size = Size(rect.width.toFloat(), rect.height.toFloat())
                    )
                }

            // Debug: draw all span rect outlines (green)
            if (debugMode) {
                for (spanRect in page.spanRects) {
                    for (rect in spanRect.rects) {
                        drawRect(
                            color = Color(0xFF00AA00),
                            topLeft = Offset(rect.x + contentOriginX, rect.y + contentOriginY),
                            size = Size(rect.width.toFloat(), rect.height.toFloat()),
                            style = Stroke(width = 1f)
                        )
                    }
                }
            }

            // Draw all text runs (black on white/gray)
            for (textRun in page.textRuns) {
                // Debug: draw text run bounding box (red) and baseline (blue)
                if (debugMode) {
                    // Bounding box
                    drawRect(
                        color = Color.Red,
                        topLeft = Offset(textRun.x + contentOriginX, textRun.y + contentOriginY),
                        size = Size(textRun.width.toFloat(), textRun.height.toFloat()),
                        style = Stroke(width = 1f)
                    )
                    // Baseline
                    val baseline = textRun.baselineY + contentOriginY
                    drawLine(
                        color = Color.Blue,
                        start = Offset(textRun.x + contentOriginX, baseline),
                        end = Offset(textRun.x + contentOriginX + textRun.width, baseline),
                        strokeWidth = 1f
                    )
                }

                drawTextRun(textRun, contentOriginX, contentOriginY, paintCache)
            }

            if (PerfLog.enabled) {
                drawStats.record(System.nanoTime() - drawStartNs)
            }
        }
    }
}

/**
 * Draw a single text run
 * E-ink optimized: grayscale text from compiler-provided style.
 */
private fun DrawScope.drawTextRun(
    textRun: TextRun,
    contentOriginX: Float,
    contentOriginY: Float,
    paintCache: TextPaintCache
) {
    val paint = paintCache.get(textRun.style)

    drawContext.canvas.nativeCanvas.drawText(
        textRun.text,
        textRun.x + contentOriginX,
        textRun.baselineY + contentOriginY,
        paint
    )
}
