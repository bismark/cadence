package com.cadence.player.audio

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.cadence.player.perf.PerfLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * Audio player wrapper using ExoPlayer
 */
class AudioPlayer(context: Context) {

    private val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()

    private val _isPlaying = MutableStateFlow(false)
    val isPlaying: StateFlow<Boolean> = _isPlaying.asStateFlow()

    private val _positionMs = MutableStateFlow(0L)
    val positionMs: StateFlow<Long> = _positionMs.asStateFlow()

    private val _durationMs = MutableStateFlow(0L)
    val durationMs: StateFlow<Long> = _durationMs.asStateFlow()

    private val _playbackEnded = MutableStateFlow(false)
    val playbackEnded: StateFlow<Boolean> = _playbackEnded.asStateFlow()

    init {
        exoPlayer.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                // Use playWhenReady instead of isPlaying to avoid brief false blips during seeks.
                // isPlaying can be momentarily false during seek/buffer even when user intends to play.
                _isPlaying.value = exoPlayer.playWhenReady

                if (PerfLog.enabled) {
                    PerfLog.d(
                        "audio isPlayingChanged raw=$isPlaying playWhenReady=${exoPlayer.playWhenReady} posMs=${exoPlayer.currentPosition}"
                    )
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (PerfLog.enabled) {
                    PerfLog.d(
                        "audio state=${playbackStateName(playbackState)} posMs=${exoPlayer.currentPosition} bufferedMs=${exoPlayer.bufferedPosition}"
                    )
                }

                when (playbackState) {
                    Player.STATE_READY -> {
                        _durationMs.value = exoPlayer.duration
                        _playbackEnded.value = false
                    }
                    Player.STATE_ENDED -> {
                        _playbackEnded.value = true
                        _isPlaying.value = false  // Actually stopped at end
                    }
                }
            }
        })
    }

    /**
     * Load an audio file from path
     */
    fun loadFile(filePath: String) {
        val file = File(filePath)
        if (file.exists()) {
            val mediaItem = MediaItem.fromUri(Uri.fromFile(file))
            exoPlayer.setMediaItem(mediaItem)
            exoPlayer.prepare()
            if (PerfLog.enabled) {
                PerfLog.d("audio load file=$filePath size=${file.length()} bytes")
            }
        } else if (PerfLog.enabled) {
            PerfLog.w("audio file missing path=$filePath")
        }
    }

    /**
     * Start or resume playback
     */
    fun play() {
        if (PerfLog.enabled) {
            PerfLog.d("audio play posMs=${exoPlayer.currentPosition}")
        }
        exoPlayer.play()
    }

    /**
     * Pause playback
     */
    fun pause() {
        if (PerfLog.enabled) {
            PerfLog.d("audio pause posMs=${exoPlayer.currentPosition}")
        }
        exoPlayer.pause()
    }

    /**
     * Toggle play/pause
     */
    fun togglePlayPause() {
        if (exoPlayer.playWhenReady) {
            pause()
        } else {
            play()
        }
    }

    /**
     * Seek to a position in milliseconds
     */
    fun seekTo(positionMs: Long) {
        if (PerfLog.enabled) {
            PerfLog.d("audio seekTo posMs=$positionMs")
        }
        exoPlayer.seekTo(positionMs)
    }

    /**
     * Get current playback position
     */
    fun getCurrentPositionMs(): Long {
        return exoPlayer.currentPosition
    }

    /**
     * Update position state (call from UI loop)
     */
    fun updatePosition() {
        _positionMs.value = exoPlayer.currentPosition
    }

    /**
     * Release player resources
     */
    fun release() {
        if (PerfLog.enabled) {
            PerfLog.d("audio release")
        }
        exoPlayer.release()
    }

    private fun playbackStateName(state: Int): String {
        return when (state) {
            Player.STATE_IDLE -> "IDLE"
            Player.STATE_BUFFERING -> "BUFFERING"
            Player.STATE_READY -> "READY"
            Player.STATE_ENDED -> "ENDED"
            else -> "UNKNOWN($state)"
        }
    }
}
