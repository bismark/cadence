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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.cadence.player.audio.AudioPlayer
import com.cadence.player.data.CadenceBundle
import com.cadence.player.data.PlaybackPreferences
import com.cadence.player.data.SpanEntry
import kotlinx.coroutines.delay

/**
 * Main player screen - simplified with single audio file
 */
@Composable
fun PlayerScreen(
    bundle: CadenceBundle,
    initialPageIndex: Int = 0
) {
    val context = LocalContext.current
    val audioPlayer = remember { AudioPlayer(context) }
    val playbackPrefs = remember { PlaybackPreferences(context) }

    // Use bundleId from meta.json, fallback to path hash for old bundles
    val bookId = remember { bundle.meta.bundleId ?: bundle.basePath.hashCode().toString() }

    // State
    var currentPageIndex by remember { mutableIntStateOf(initialPageIndex) }
    var activeSpan by remember { mutableStateOf<SpanEntry?>(null) }
    var isPlaying by remember { mutableStateOf(false) }
    var positionMs by remember { mutableLongStateOf(0L) }
    var debugMode by remember { mutableStateOf(false) }

    val currentPage = bundle.getPage(currentPageIndex)
    val totalPages = bundle.pages.size

    // Load audio and restore saved position on startup
    LaunchedEffect(Unit) {
        audioPlayer.loadFile(bundle.audioPath)

        // Restore saved position
        val savedPosition = playbackPrefs.getPosition(bookId)
        if (savedPosition > 0) {
            audioPlayer.seekTo(savedPosition)
            positionMs = savedPosition
            // Find and set the active span for the restored position
            bundle.findSpanAtTime(savedPosition.toDouble())?.let { span ->
                activeSpan = span
                currentPageIndex = span.pageIndex
            }
        }
    }

    // Position update loop - simple polling
    var saveCounter by remember { mutableIntStateOf(0) }
    LaunchedEffect(isPlaying) {
        while (isPlaying) {
            positionMs = audioPlayer.getCurrentPositionMs()

            // Only update activeSpan when position leaves current span's range
            // This prevents race conditions when user taps (tap sets activeSpan,
            // but position hasn't caught up yet - we don't want to overwrite)
            val currentSpan = activeSpan
            if (currentSpan == null ||
                positionMs < currentSpan.clipBeginMs ||
                positionMs >= currentSpan.clipEndMs) {
                bundle.findSpanAtTime(positionMs.toDouble())?.let { span ->
                    activeSpan = span
                    if (span.pageIndex != currentPageIndex) {
                        currentPageIndex = span.pageIndex
                    }
                }
            }

            // Save position every ~5 seconds (100 iterations * 50ms)
            saveCounter++
            if (saveCounter >= 100) {
                playbackPrefs.savePosition(bookId, positionMs)
                saveCounter = 0
            }

            delay(50)  // Update at ~20Hz
        }
    }

    // Save position when leaving the screen
    DisposableEffect(Unit) {
        onDispose {
            playbackPrefs.savePosition(bookId, audioPlayer.getCurrentPositionMs())
            audioPlayer.release()
        }
    }

    // Collect player state
    LaunchedEffect(Unit) {
        audioPlayer.isPlaying.collect { playing ->
            isPlaying = playing
        }
    }

    // Handle playback ending (reached end of audio)
    LaunchedEffect(Unit) {
        audioPlayer.playbackEnded.collect { ended ->
            if (ended) {
                // Go to last page and last span when playback completes
                val lastPage = bundle.pages.lastOrNull()
                if (lastPage != null) {
                    currentPageIndex = lastPage.pageIndex
                    bundle.getLastTimedSpan()?.let { lastSpan ->
                        activeSpan = lastSpan
                    }
                }
            }
        }
    }

    fun SpanEntry.hasValidTiming(): Boolean = clipBeginMs >= 0 && clipEndMs > clipBeginMs

    fun seekToSpan(span: SpanEntry, play: Boolean) {
        activeSpan = span
        if (span.pageIndex != currentPageIndex) {
            currentPageIndex = span.pageIndex
        }
        audioPlayer.seekTo(span.clipBeginMs.toLong() + 1)
        if (play) {
            audioPlayer.play()
        }
    }

    fun handlePlayPause() {
        if (isPlaying) {
            audioPlayer.pause()
            return
        }

        val currentSpan = bundle.findSpanAtTime(positionMs.toDouble())
        val nextSpan = currentSpan ?: bundle.findNextSpanAfter(positionMs.toDouble())
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
                            if (!span.hasValidTiming()) return@let
                            seekToSpan(span, play = true)
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
                        currentPageIndex--
                        bundle.getPage(currentPageIndex)?.firstSpanId?.let { spanId ->
                            bundle.getSpanById(spanId)?.let { span ->
                                if (!span.hasValidTiming()) return@let
                                seekToSpan(span, play = false)
                            }
                        }
                    }
                },
                onNextPage = {
                    if (currentPageIndex < totalPages - 1) {
                        currentPageIndex++
                        bundle.getPage(currentPageIndex)?.firstSpanId?.let { spanId ->
                            bundle.getSpanById(spanId)?.let { span ->
                                if (!span.hasValidTiming()) return@let
                                seekToSpan(span, play = false)
                            }
                        }
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
