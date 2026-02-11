package com.cadence.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.cadence.player.audio.AudioPlayer
import com.cadence.player.data.CadenceBundle
import com.cadence.player.data.PlaybackPreferences
import com.cadence.player.data.SpanEntry
import com.cadence.player.perf.PerfLog
import com.cadence.player.perf.RollingTimingStats
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.math.abs

/**
 * Main player screen - simplified with single audio file
 */
@Composable
fun PlayerScreen(
    bundle: CadenceBundle,
    initialPageIndex: Int = 0,
    preferInitialPage: Boolean = false,
    jumpToPageRequests: Flow<Int> = emptyFlow()
) {
    val context = LocalContext.current
    val audioPlayer = remember { AudioPlayer(context) }
    val playbackPrefs = remember { PlaybackPreferences(context) }

    // Use bundleId from meta.json, fallback to path hash for old bundles
    val bookId = remember { bundle.meta.bundleId ?: bundle.basePath.hashCode().toString() }

    val totalPages = bundle.pages.size
    val normalizedInitialPageIndex =
        if (totalPages > 0) initialPageIndex.coerceIn(0, totalPages - 1) else 0

    // State
    var currentPageIndex by remember { mutableIntStateOf(normalizedInitialPageIndex) }
    var activeSpan by remember { mutableStateOf<SpanEntry?>(null) }
    var isPlaying by remember { mutableStateOf(false) }
    var positionMs by remember { mutableLongStateOf(0L) }
    var debugMode by remember { mutableStateOf(false) }

    fun updatePlaybackCursor(span: SpanEntry?, pageIndex: Int) {
        Snapshot.withMutableSnapshot {
            activeSpan = span
            currentPageIndex = pageIndex
        }
    }

    // Debug-only instrumentation
    val pollLoopStats = remember { RollingTimingStats("poll-loop", reportEvery = 200, slowThresholdMs = 6.0) }
    val spanLookupStats = remember { RollingTimingStats("span-lookup", reportEvery = 200, slowThresholdMs = 1.5) }
    val savePositionStats = remember { RollingTimingStats("save-position", reportEvery = 20, slowThresholdMs = 2.0) }

    val currentPage = bundle.getPage(currentPageIndex)

    // Load audio and restore saved position on startup
    LaunchedEffect(Unit) {
        val startupStartNs = if (PerfLog.enabled) System.nanoTime() else 0L

        audioPlayer.loadFile(bundle.audioPath)

        if (preferInitialPage && totalPages > 0) {
            val targetPageIndex = initialPageIndex.coerceIn(0, totalPages - 1)

            val targetSpan = bundle
                .getPage(targetPageIndex)
                ?.spanRects
                ?.asSequence()
                ?.mapNotNull { spanRect -> bundle.getSpanById(spanRect.spanId) }
                ?.firstOrNull { span -> span.clipBeginMs >= 0 && span.clipEndMs > span.clipBeginMs }

            if (targetSpan != null) {
                val targetPositionMs = targetSpan.clipBeginMs.toLong() + 1L
                updatePlaybackCursor(span = targetSpan, pageIndex = targetPageIndex)
                audioPlayer.seekTo(targetPositionMs)
                positionMs = targetPositionMs
            } else {
                updatePlaybackCursor(span = null, pageIndex = targetPageIndex)
            }

            if (PerfLog.enabled) {
                PerfLog.d(
                    "player startup jump pageIndex=$targetPageIndex requestedInitial=$initialPageIndex"
                )
            }
        } else {
            // Restore saved position
            val savedPosition = playbackPrefs.getPosition(bookId)
            if (savedPosition > 0) {
                audioPlayer.seekTo(savedPosition)
                positionMs = savedPosition
                // Find and set the active span for the restored position
                bundle.findSpanAtTime(savedPosition.toDouble())?.let { span ->
                    updatePlaybackCursor(span = span, pageIndex = span.pageIndex)
                }
            }

            if (PerfLog.enabled) {
                PerfLog.d(
                    "player startup restore=${PerfLog.formatNs(System.nanoTime() - startupStartNs)}ms savedPositionMs=$savedPosition"
                )
            }
        }
    }

    // Position update loop - simple polling
    var saveCounter by remember { mutableIntStateOf(0) }
    LaunchedEffect(isPlaying) {
        var loopsSinceLog = 0
        var lookupsSinceLog = 0
        var spanSwitchesSinceLog = 0
        var pageSwitchesSinceLog = 0
        var uiPositionTicks = 0

        while (isPlaying) {
            val pollStartNs = if (PerfLog.enabled) System.nanoTime() else 0L
            val polledPositionMs = audioPlayer.getCurrentPositionMs()

            // Throttle UI time updates to ~1Hz to avoid triggering full-screen recomposition at 20Hz.
            // Span/page sync still runs at 20Hz based on polledPositionMs.
            uiPositionTicks++
            var pendingUiPositionMs: Long? = null
            if (uiPositionTicks >= 20 || abs(polledPositionMs - positionMs) >= 1000L) {
                pendingUiPositionMs = polledPositionMs
                uiPositionTicks = 0
            }

            var pendingSpanUpdate: SpanEntry? = null
            var pendingPageIndex: Int? = null

            // Only update activeSpan when position leaves current span's range.
            // Apply page + span together so old highlight removal and new highlight draw
            // happen in a single UI refresh on e-ink.
            val currentSpan = activeSpan
            if (currentSpan == null ||
                polledPositionMs < currentSpan.clipBeginMs ||
                polledPositionMs >= currentSpan.clipEndMs) {
                lookupsSinceLog++
                val resolvedSpan = spanLookupStats.measure {
                    bundle.findSpanAtTime(polledPositionMs.toDouble())
                }

                resolvedSpan?.let { span ->
                    val spanChanged = currentSpan?.id != span.id
                    val pageChanged = span.pageIndex != currentPageIndex
                    if (spanChanged || pageChanged) {
                        if (spanChanged) {
                            spanSwitchesSinceLog++
                        }
                        if (pageChanged) {
                            pageSwitchesSinceLog++
                        }
                        pendingSpanUpdate = span
                        pendingPageIndex = span.pageIndex
                    }
                }
            }

            if (pendingUiPositionMs != null || pendingSpanUpdate != null) {
                Snapshot.withMutableSnapshot {
                    pendingUiPositionMs?.let { updatedPositionMs ->
                        positionMs = updatedPositionMs
                    }
                    pendingSpanUpdate?.let { updatedSpan ->
                        activeSpan = updatedSpan
                        currentPageIndex = pendingPageIndex ?: updatedSpan.pageIndex
                    }
                }
            }

            // Save position every ~5 seconds (100 iterations * 50ms)
            saveCounter++
            if (saveCounter >= 100) {
                savePositionStats.measure {
                    playbackPrefs.savePosition(bookId, polledPositionMs)
                }
                saveCounter = 0
            }

            if (PerfLog.enabled) {
                pollLoopStats.record(System.nanoTime() - pollStartNs)
                loopsSinceLog++
                if (loopsSinceLog >= 200) {
                    PerfLog.d(
                        "poll summary loops=$loopsSinceLog lookups=$lookupsSinceLog spanSwitches=$spanSwitchesSinceLog pageSwitches=$pageSwitchesSinceLog posMs=$polledPositionMs"
                    )
                    loopsSinceLog = 0
                    lookupsSinceLog = 0
                    spanSwitchesSinceLog = 0
                    pageSwitchesSinceLog = 0
                }
            }

            delay(50)  // Update at ~20Hz
        }
    }

    // Save position when leaving the screen
    DisposableEffect(Unit) {
        onDispose {
            savePositionStats.measure {
                playbackPrefs.savePosition(bookId, audioPlayer.getCurrentPositionMs())
            }
            audioPlayer.release()
        }
    }

    // Collect player state
    LaunchedEffect(Unit) {
        audioPlayer.isPlaying.collect { playing ->
            if (PerfLog.enabled && isPlaying != playing) {
                PerfLog.d("isPlaying changed=$playing posMs=$positionMs")
            }
            isPlaying = playing

            // Snap displayed time when playback stops (poll loop throttles to ~1Hz).
            if (!playing) {
                positionMs = audioPlayer.getCurrentPositionMs()
            }
        }
    }

    // Handle playback ending (reached end of audio)
    LaunchedEffect(Unit) {
        audioPlayer.playbackEnded.collect { ended ->
            if (ended) {
                if (PerfLog.enabled) {
                    PerfLog.d("playback ended at posMs=$positionMs")
                }

                // Go to last page and last span when playback completes
                val lastPage = bundle.pages.lastOrNull()
                if (lastPage != null) {
                    updatePlaybackCursor(
                        span = bundle.getLastTimedSpan() ?: activeSpan,
                        pageIndex = lastPage.pageIndex
                    )
                }
            }
        }
    }

    fun SpanEntry.hasValidTiming(): Boolean = clipBeginMs >= 0 && clipEndMs > clipBeginMs

    fun seekToSpan(span: SpanEntry, play: Boolean, overridePageIndex: Int? = null) {
        val targetPageIndex = overridePageIndex ?: span.pageIndex
        updatePlaybackCursor(span = span, pageIndex = targetPageIndex)

        audioPlayer.seekTo(span.clipBeginMs.toLong() + 1)
        if (play) {
            audioPlayer.play()
        }
    }

    fun findFirstTimedSpanOnPage(pageIndex: Int): SpanEntry? {
        val page = bundle.getPage(pageIndex) ?: return null
        for (spanRect in page.spanRects) {
            val span = bundle.getSpanById(spanRect.spanId) ?: continue
            if (span.hasValidTiming()) {
                return span
            }
        }
        return null
    }

    fun jumpToPage(targetPageIndex: Int) {
        if (totalPages <= 0) {
            return
        }

        val clampedPageIndex = targetPageIndex.coerceIn(0, totalPages - 1)

        findFirstTimedSpanOnPage(clampedPageIndex)?.let { span ->
            seekToSpan(span, play = false, overridePageIndex = clampedPageIndex)
            return
        }

        // Keep page visible even if it has no timed spans.
        updatePlaybackCursor(span = null, pageIndex = clampedPageIndex)
        audioPlayer.pause()
    }

    LaunchedEffect(jumpToPageRequests, totalPages) {
        jumpToPageRequests.collect { requestedPageIndex ->
            if (PerfLog.enabled) {
                PerfLog.d("jump request pageIndex=$requestedPageIndex")
            }
            jumpToPage(requestedPageIndex)
        }
    }

    fun handlePlayPause() {
        if (isPlaying) {
            audioPlayer.pause()
            return
        }

        val playbackPositionMs = audioPlayer.getCurrentPositionMs()
        positionMs = playbackPositionMs

        val currentSpan = bundle.findSpanAtTime(playbackPositionMs.toDouble())
        if (currentSpan != null && currentSpan.hasValidTiming()) {
            updatePlaybackCursor(span = currentSpan, pageIndex = currentSpan.pageIndex)
            audioPlayer.play()
            return
        }

        val nextSpan = bundle.findNextSpanAfter(playbackPositionMs.toDouble())
        if (nextSpan != null && nextSpan.hasValidTiming()) {
            seekToSpan(nextSpan, play = true)
        } else {
            // No valid span to play; keep paused
            audioPlayer.pause()
        }
    }

    // UI
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.White)
    ) {
        // Page display
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.White)
        ) {
            currentPage?.let { page ->
                PageRenderer(
                    page = page,
                    activeSpanId = activeSpan?.id,
                    modifier = Modifier.fillMaxSize(),
                    debugMode = debugMode,
                    onSpanTap = { spanId ->
                        // Find the span and seek to its position
                        bundle.getSpanById(spanId)?.let { span ->
                            if (span.hasValidTiming()) {
                                seekToSpan(span, play = true)
                            }
                        }
                    },
                    onBackgroundTap = {
                        handlePlayPause()
                    }
                )
            } ?: run {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Loading...")
                }
            }
        }

        // Controls
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomCenter)
        ) {
            PlayerControls(
                isPlaying = isPlaying,
                positionMs = positionMs,
                currentPageIndex = currentPageIndex,
                totalPages = totalPages,
                debugMode = debugMode,
                onPlayPause = { handlePlayPause() },
                onDebugToggle = { debugMode = !debugMode },
                onPreviousPage = {
                    if (currentPageIndex > 0) {
                        jumpToPage(currentPageIndex - 1)
                    }
                },
                onNextPage = {
                    if (currentPageIndex < totalPages - 1) {
                        jumpToPage(currentPageIndex + 1)
                    }
                }
            )
        }
    }
}

/**
 * Playback controls - e-ink optimized with high contrast
 */
@Composable
private fun PlayerControls(
    isPlaying: Boolean,
    positionMs: Long,
    currentPageIndex: Int,
    totalPages: Int,
    debugMode: Boolean,
    onPlayPause: () -> Unit,
    onDebugToggle: () -> Unit,
    onPreviousPage: () -> Unit,
    onNextPage: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = Color.White
    ) {
        Column {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .background(Color.Black)
            )

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                EInkButton(onClick = onPreviousPage) {
                    Text("< Prev")
                }

                EInkButton(
                    onClick = onPlayPause,
                    filled = true,
                    modifier = Modifier.width(90.dp)
                ) {
                    Text(if (isPlaying) "Pause" else "Play")
                }

                Text(
                    text = "${currentPageIndex + 1} / $totalPages",
                    color = Color.Black
                )

                Text(
                    text = formatTime(positionMs),
                    color = Color.Black
                )

                EInkButton(onClick = onNextPage) {
                    Text("Next >")
                }

                EInkButton(onClick = onDebugToggle, filled = debugMode) {
                    Text("Debug")
                }
            }
        }
    }
}

private fun formatTime(ms: Long): String {
    val seconds = (ms / 1000) % 60
    val minutes = (ms / 1000) / 60
    return "%d:%02d".format(minutes, seconds)
}

@Composable
private fun EInkButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    filled: Boolean = false,
    content: @Composable () -> Unit
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isPressed by interactionSource.collectIsPressedAsState()

    val backgroundColor = when {
        filled && isPressed -> Color.DarkGray
        filled -> Color.Black
        isPressed -> Color.LightGray
        else -> Color.White
    }
    val contentColor = if (filled) Color.White else Color.Black

    Box(
        modifier = modifier
            .border(
                width = 1.dp,
                color = Color.Black,
                shape = RoundedCornerShape(4.dp)
            )
            .background(backgroundColor, RoundedCornerShape(4.dp))
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick
            )
            .padding(horizontal = 16.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) {
            content()
        }
    }
}
