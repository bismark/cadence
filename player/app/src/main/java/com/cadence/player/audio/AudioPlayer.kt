package com.cadence.player.audio

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
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

    init {
        exoPlayer.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _isPlaying.value = isPlaying
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) {
                    _durationMs.value = exoPlayer.duration
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
        }
    }

    /**
     * Start or resume playback
     */
    fun play() {
        exoPlayer.play()
    }

    /**
     * Pause playback
     */
    fun pause() {
        exoPlayer.pause()
    }

    /**
     * Toggle play/pause
     */
    fun togglePlayPause() {
        if (exoPlayer.isPlaying) {
            pause()
        } else {
            play()
        }
    }

    /**
     * Seek to a position in milliseconds
     */
    fun seekTo(positionMs: Long) {
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
        exoPlayer.release()
    }
}
