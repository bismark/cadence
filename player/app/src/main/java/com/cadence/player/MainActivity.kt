package com.cadence.player

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.WindowManager
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
import com.cadence.player.ui.PlayerScreen
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Enable fullscreen immersive mode - hide system bars
        // This is important for e-ink devices and to match the compiler's viewport assumptions
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        setContent {
            MaterialTheme {
                CadenceApp()
            }
        }
    }
}

@Composable
fun CadenceApp() {
    val context = LocalContext.current
    var bundle by remember { mutableStateOf<CadenceBundle?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var hasPermission by remember { mutableStateOf(false) }
    var permissionRequested by remember { mutableStateOf(false) }

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
        hasPermission = Environment.isExternalStorageManager()
        if (!hasPermission) {
            error = "Storage permission is required to load bundles.\n\nPlease grant 'All files access' permission."
            isLoading = false
        }
    }

    // Request permission on first launch
    LaunchedEffect(Unit) {
        if (checkStoragePermission()) {
            hasPermission = true
        } else if (!permissionRequested) {
            permissionRequested = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:${context.packageName}")
                }
                manageStorageLauncher.launch(intent)
            } else {
                legacyPermissionLauncher.launch(Manifest.permission.READ_EXTERNAL_STORAGE)
            }
        }
    }

    // Try to load bundle once we have permission
    LaunchedEffect(hasPermission) {
        if (!hasPermission) return@LaunchedEffect

        try {
            // Look for bundle in standard locations
            val possiblePaths = listOf(
                // Downloads folder
                "${Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)}/cadence-bundle",
                // App's external files
                "/sdcard/Download/cadence-bundle",
                // Direct path for testing
                "/sdcard/cadence-bundle"
            )

            var loadedBundle: CadenceBundle? = null
            for (path in possiblePaths) {
                val dir = File(path)
                if (dir.exists() && dir.isDirectory && File(dir, "meta.json").exists()) {
                    loadedBundle = BundleLoader.loadBundle(path)
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
            PlayerScreen(bundle = bundle!!)
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
