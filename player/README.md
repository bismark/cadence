# Cadence Player

Android app for playing Cadence bundles with synchronized text and audio.

## Requirements

- Android 11+ (API 30)
- No Google Play Services required

## Building

1. Open the project in Android Studio
2. Sync Gradle
3. Build and run on device/emulator

```bash
# Or from command line with Android SDK installed
./gradlew assembleDebug
```

## Usage

1. Compile an EPUB with the Cadence compiler:
   ```bash
   cd ../compiler
   node dist/index.js compile -i book.epub --no-zip
   ```

2. Copy the bundle folder to your device:
   ```bash
   adb push book.bundle /sdcard/Download/cadence-bundle
   ```

3. Launch the Cadence Player app

4. Tap the screen to play/pause audio. The text highlights sync with playback.

## Bundle Location

The app looks for bundles in these locations:
- `/sdcard/Download/cadence-bundle`
- `/sdcard/cadence-bundle`

The folder should contain:
- `meta.json`
- `spans.jsonl`
- `pages/*.json`
- `audio/*.mp3`

## Architecture

```
com.cadence.player/
  data/
    Bundle.kt         # Data classes matching bundle format
    BundleLoader.kt   # JSON parsing
  ui/
    PageRenderer.kt   # Compose Canvas rendering
    PlayerScreen.kt   # Main player UI
  audio/
    AudioPlayer.kt    # ExoPlayer wrapper
  MainActivity.kt     # Entry point
```

## Features

- Canvas-based text rendering (no WebView)
- ExoPlayer audio playback
- Real-time highlight sync (~20Hz position updates)
- Page auto-advance when audio crosses page boundaries
- Manual page navigation with seek-to-page-start
