package com.cadence.player.perf

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import java.util.Locale

object PerfLog {
    const val TAG = "CadencePerf"

    @Volatile
    private var initialized = false

    @Volatile
    private var debugEnabled = false

    val enabled: Boolean
        get() = debugEnabled

    fun initialize(context: Context) {
        if (initialized) return

        debugEnabled = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        initialized = true

        if (debugEnabled) {
            Log.d(TAG, "perf logging enabled")
        }
    }

    fun d(message: String) {
        if (enabled) {
            Log.d(TAG, message)
        }
    }

    fun w(message: String) {
        if (enabled) {
            Log.w(TAG, message)
        }
    }

    fun formatNs(durationNs: Long): String {
        return String.format(Locale.US, "%.2f", durationNs / 1_000_000.0)
    }
}

class RollingTimingStats(
    private val label: String,
    private val reportEvery: Int = 120,
    private val slowThresholdMs: Double? = null
) {
    private var samples = 0
    private var totalNs = 0L
    private var minNs = Long.MAX_VALUE
    private var maxNs = 0L

    inline fun <T> measure(
        noinline details: (() -> String)? = null,
        block: () -> T
    ): T {
        if (!PerfLog.enabled) return block()

        val startNs = System.nanoTime()
        return try {
            block()
        } finally {
            record(System.nanoTime() - startNs, details)
        }
    }

    fun record(
        durationNs: Long,
        details: (() -> String)? = null
    ) {
        if (!PerfLog.enabled) return

        samples++
        totalNs += durationNs

        if (durationNs < minNs) minNs = durationNs
        if (durationNs > maxNs) maxNs = durationNs

        val thresholdNs = slowThresholdMs?.let { (it * 1_000_000.0).toLong() }
        if (thresholdNs != null && durationNs >= thresholdNs) {
            val extra = details?.invoke()?.let { " $it" } ?: ""
            PerfLog.w("$label slow=${PerfLog.formatNs(durationNs)}ms$extra")
        }

        if (samples >= reportEvery) {
            val avgNs = totalNs / samples
            PerfLog.d(
                "$label avg=${PerfLog.formatNs(avgNs)}ms min=${PerfLog.formatNs(minNs)}ms max=${PerfLog.formatNs(maxNs)}ms n=$samples"
            )

            samples = 0
            totalNs = 0L
            minNs = Long.MAX_VALUE
            maxNs = 0L
        }
    }
}
