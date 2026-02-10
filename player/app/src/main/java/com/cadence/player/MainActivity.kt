package com.cadence.player

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.cadence.player.data.BundleLoader
import com.cadence.player.data.CadenceBundle
import com.cadence.player.perf.PerfLog
import com.cadence.player.ui.PlayerScreen
import java.io.File
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

private const val EXTRA_PAGE = "page"            // 1-based (UI-friendly)
private const val EXTRA_PAGE_INDEX = "pageIndex"  // 0-based
private const val EXTRA_PAGE_NAMESPACED = "com.cadence.player.extra.PAGE"
private const val EXTRA_PAGE_INDEX_NAMESPACED = "com.cadence.player.extra.PAGE_INDEX"

private fun parseIntExtra(intent: Intent, key: String): Int? {
    if (!intent.hasExtra(key)) {
        return null
    }

    intent.getStringExtra(key)?.toIntOrNull()?.let { return it }

    val intValue = intent.getIntExtra(key, Int.MIN_VALUE)
    if (intValue != Int.MIN_VALUE) {
        return intValue
    }

    val longValue = intent.getLongExtra(key, Long.MIN_VALUE)
    if (longValue != Long.MIN_VALUE) {
        return longValue.toInt()
    }

    return null
}

private fun parseJumpPageIndex(intent: Intent?): Int? {
    intent ?: return null

    // Prefer explicit 0-based index when provided
    parseIntExtra(intent, EXTRA_PAGE_INDEX)?.let { return it }
    parseIntExtra(intent, EXTRA_PAGE_INDEX_NAMESPACED)?.let { return it }

    // Also accept 1-based page numbers to match on-screen numbering
    parseIntExtra(intent, EXTRA_PAGE)?.let { return it - 1 }
    parseIntExtra(intent, EXTRA_PAGE_NAMESPACED)?.let { return it - 1 }

    return null
}

class MainActivity : ComponentActivity() {
    private val jumpPageRequests = MutableSharedFlow<Int>(
        extraBufferCapacity = 1,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )

    private var launchPageIndexOverride: Int? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        PerfLog.initialize(applicationContext)
        launchPageIndexOverride = parseJumpPageIndex(intent)

        // Enable fullscreen immersive mode - hide system bars
        // This is important for e-ink devices and to match the compiler's viewport assumptions
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        setContent {
            MaterialTheme {
                CadenceApp(
                    initialPageIndexOverride = launchPageIndexOverride,
                    jumpPageRequests = jumpPageRequests
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)

        val jumpPageIndex = parseJumpPageIndex(intent) ?: return
        lifecycleScope.launch {
            jumpPageRequests.emit(jumpPageIndex)
        }
    }
}

@Composable
fun CadenceApp(
    initialPageIndexOverride: Int? = null,
    jumpPageRequests: Flow<Int> = emptyFlow()
) {
    val context = LocalContext.current
    var bundle by remember { mutableStateOf<CadenceBundle?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var hasPermission by remember { mutableStateOf(false) }
    var permissionRequested by remember { mutableStateOf(false) }
    var bundleLoadStarted by remember { mutableStateOf(false) }

    // Check if we have storage permission
    fun checkStoragePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.READ_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED
        }
    }

    // Launcher for Android 10 and below
    val legacyPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (PerfLog.enabled) {
            PerfLog.d("legacy permission result granted=$granted")
        }

        hasPermission = granted
        if (!granted) {
            error = "Storage permission is required to load bundles"
            isLoading = false
        }
    }

    // Launcher for Android 11+ (MANAGE_EXTERNAL_STORAGE)
    val manageStorageLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        val granted = Environment.isExternalStorageManager()
        if (PerfLog.enabled) {
            PerfLog.d("manage storage permission result granted=$granted")
        }

        hasPermission = granted
        if (!hasPermission) {
            error = "Storage permission is required to load bundles.\n\nPlease grant 'All files access' permission."
            isLoading = false
        }
    }

    // Request permission on first launch
    LaunchedEffect(Unit) {
        val alreadyGranted = checkStoragePermission()
        if (PerfLog.enabled) {
            PerfLog.d("permission check granted=$alreadyGranted requested=$permissionRequested")
        }

        if (alreadyGranted) {
            hasPermission = true
        } else if (!permissionRequested) {
            permissionRequested = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (PerfLog.enabled) {
                    PerfLog.d("launching MANAGE_EXTERNAL_STORAGE settings")
                }
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                manageStorageLauncher.launch(intent)
            } else {
                if (PerfLog.enabled) {
                    PerfLog.d("launching READ_EXTERNAL_STORAGE permission request")
                }
                legacyPermissionLauncher.launch(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
    }

    // Try to load bundle once we have permission
    LaunchedEffect(hasPermission) {
        if (!hasPermission || bundleLoadStarted) return@LaunchedEffect
        bundleLoadStarted = true

        if (PerfLog.enabled) {
            PerfLog.d("bundle load effect start hasPermission=$hasPermission")
        }

        try {
            // Look for bundle in standard locations
            val possiblePaths = listOf(
                // Downloads folder
                "${Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)}/cadence-bundle",
                // App's external files
                "/sdcard/Download/cadence-bundle",
                // Direct path for testing
                "/sdcard/cadence-bundle"
            ).flatMap { path ->
                listOf(path, "$path.zip")
            }

            var loadedBundle: CadenceBundle? = null
            for (path in possiblePaths) {
                val bundleFile = File(path)
                val isDirectoryBundle =
                    bundleFile.exists() && bundleFile.isDirectory && File(bundleFile, "meta.json").exists()
                val isZipBundle =
                    bundleFile.exists() && bundleFile.isFile && bundleFile.extension.lowercase() == "zip"

                if (PerfLog.enabled) {
                    PerfLog.d(
                        "bundle path check path=$path exists=${bundleFile.exists()} dir=$isDirectoryBundle zip=$isZipBundle"
                    )
                }

                if (isDirectoryBundle || isZipBundle) {
                    loadedBundle = BundleLoader.loadBundle(context, path)
                    break
                }
            }

            if (loadedBundle != null) {
                bundle = loadedBundle
            } else {
                error = "No bundle found. Place a bundle folder at:\n${possiblePaths.first()}"
            }
        } catch (e: Exception) {
            error = "Failed to load bundle: ${e.message}"
        } finally {
            isLoading = false
        }
    }

    when {
        isLoading -> {
            LoadingScreen()
        }
        error != null -> {
            ErrorScreen(error!!)
        }
        bundle != null -> {
            PlayerScreen(
                bundle = bundle!!,
                initialPageIndex = initialPageIndexOverride ?: 0,
                preferInitialPage = initialPageIndexOverride != null,
                jumpToPageRequests = jumpPageRequests
            )
        }
    }
}

@Composable
private fun LoadingScreen() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            CircularProgressIndicator()
            Text("Loading Cadence bundle...")
        }
    }
}

@Composable
private fun ErrorScreen(message: String) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.padding(32.dp)
        ) {
            Text(
                text = "Cadence Player",
                style = MaterialTheme.typography.headlineMedium
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}
