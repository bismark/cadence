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
import com.cadence.player.data.Page
import com.cadence.player.data.SpanEntry
import kotlinx.coroutines.delay

/**
 * Main player screen
 */
@Composable
fun PlayerScreen(
    bundle: CadenceBundle,
    initialPageIndex: Int = 0
) {
    val context = LocalContext.current
    val audioPlayer = remember { AudioPlayer(context) }

    // State - simplified to just track current page index
    var currentPageIndex by remember { mutableIntStateOf(initialPageIndex) }
    var activeSpan by remember { mutableStateOf<SpanEntry?>(null) }
    var isPlaying by remember { mutableStateOf(false) }
    var positionMs by remember { mutableLongStateOf(0L) }
    var debugMode by remember { mutableStateOf(false) }
    var currentAudioSrc by remember { mutableStateOf<String?>(null) }

    val currentPage = bundle.getPage(currentPageIndex)
    val totalPages = bundle.pages.size

    // Load audio for first span on startup
    LaunchedEffect(Unit) {
        bundle.spans.firstOrNull()?.let { span ->
            currentAudioSrc = span.audioSrc
            audioPlayer.loadFile(bundle.getAudioPath(span))
        }
    }

    // Position update loop
    LaunchedEffect(isPlaying) {
        while (isPlaying) {
            positionMs = audioPlayer.getCurrentPositionMs()

            // Find active span
            val span = bundle.findSpanAtTime(positionMs.toDouble())
            activeSpan = span

            // Auto-advance page if needed
            span?.let {
                if (it.pageIndex != currentPageIndex) {
                    currentPageIndex = it.pageIndex
                }
                // Switch audio file if needed
                if (it.audioSrc != currentAudioSrc) {
                    currentAudioSrc = it.audioSrc
                    audioPlayer.loadFile(bundle.getAudioPath(it))
                    audioPlayer.seekTo(it.clipBeginMs.toLong())
                    audioPlayer.play()
                }
            }

            delay(50)  // Update at ~20Hz
        }
    }

    // Collect player state
    LaunchedEffect(Unit) {
        audioPlayer.isPlaying.collect { playing ->
            isPlaying = playing
        }
    }

    // Cleanup
    DisposableEffect(Unit) {
        onDispose {
            audioPlayer.release()
        }
    }

    // UI - e-ink optimized: white background
    // Use Box with overlay so toolbar doesn't shrink content area
    // The compiler reserves bottom margin (200px) for the toolbar
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.White)
    ) {
        // Page display - e-ink optimized: instant color change on press, no ripple
        val interactionSource = remember { MutableInteractionSource() }
        val isPressed by interactionSource.collectIsPressedAsState()

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(if (isPressed) Color(0xFFE0E0E0) else Color.White)
                .clickable(
                    interactionSource = interactionSource,
                    indication = null
                ) { audioPlayer.togglePlayPause() }
        ) {
            currentPage?.let { page ->
                PageRenderer(
                    page = page,
                    activeSpanId = activeSpan?.id,
                    modifier = Modifier.fillMaxSize(),
                    debugMode = debugMode
                )
            } ?: run {
                // Loading state
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text("Loading...")
                }
            }
        }

        // Controls - overlaid at bottom (within the compiler's reserved margin area)
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
                onPlayPause = { audioPlayer.togglePlayPause() },
                onDebugToggle = { debugMode = !debugMode },
                onPreviousPage = {
                    if (currentPageIndex > 0) {
                        currentPageIndex--
                        // Seek to first span of the new page
                        bundle.getPage(currentPageIndex)?.firstSpanId?.let { spanId ->
                            bundle.spans.find { it.id == spanId }?.let { span ->
                                // Load audio if different
                                if (span.audioSrc != currentAudioSrc) {
                                    currentAudioSrc = span.audioSrc
                                    audioPlayer.loadFile(bundle.getAudioPath(span))
                                }
                                audioPlayer.seekTo(span.clipBeginMs.toLong())
                            }
                        }
                    }
                },
                onNextPage = {
                    if (currentPageIndex < totalPages - 1) {
                        currentPageIndex++
                        // Seek to first span of the new page
                        bundle.getPage(currentPageIndex)?.firstSpanId?.let { spanId ->
                            bundle.spans.find { it.id == spanId }?.let { span ->
                                // Load audio if different
                                if (span.audioSrc != currentAudioSrc) {
                                    currentAudioSrc = span.audioSrc
                                    audioPlayer.loadFile(bundle.getAudioPath(span))
                                }
                                audioPlayer.seekTo(span.clipBeginMs.toLong())
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
            // Divider line
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
                // Previous page
                EInkButton(onClick = onPreviousPage) {
                    Text("< Prev")
                }

                // Play/Pause
                EInkButton(onClick = onPlayPause, filled = true) {
                    Text(if (isPlaying) "Pause" else "Play")
                }

                // Page indicator
                Text(
                    text = "${currentPageIndex + 1} / $totalPages",
                    color = Color.Black
                )

                // Position
                Text(
                    text = formatTime(positionMs),
                    color = Color.Black
                )

                // Next page
                EInkButton(onClick = onNextPage) {
                    Text("Next >")
                }

                // Debug toggle
                EInkButton(onClick = onDebugToggle, filled = debugMode) {
                    Text("Debug")
                }
            }
        }
    }
}

/**
 * Format milliseconds as MM:SS
 */
private fun formatTime(ms: Long): String {
    val seconds = (ms / 1000) % 60
    val minutes = (ms / 1000) / 60
    return "%d:%02d".format(minutes, seconds)
}

/**
 * E-ink optimized button - instant color change on press, no ripple/animation
 */
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
