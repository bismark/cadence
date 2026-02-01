package com.cadence.player.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Persists playback position per book using SharedPreferences
 */
class PlaybackPreferences(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        "cadence_playback",
        Context.MODE_PRIVATE
    )

    /**
     * Save playback position for a book
     * @param bookId Unique identifier (e.g., bundle path or title hash)
     * @param positionMs Current audio position in milliseconds
     */
    fun savePosition(bookId: String, positionMs: Long) {
        prefs.edit()
            .putLong(keyFor(bookId), positionMs)
            .apply()
    }

    /**
     * Get saved playback position for a book
     * @return Position in milliseconds, or 0 if not found
     */
    fun getPosition(bookId: String): Long {
        return prefs.getLong(keyFor(bookId), 0L)
    }

    /**
     * Clear saved position for a book
     */
    fun clearPosition(bookId: String) {
        prefs.edit()
            .remove(keyFor(bookId))
            .apply()
    }

    private fun keyFor(bookId: String): String = "position_$bookId"
}
