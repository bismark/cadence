{
  "id": "cc3aebf7",
  "title": "Player: add ADB page jump intent extras for debug navigation",
  "tags": [
    "player",
    "debug",
    "adb",
    "feature"
  ],
  "status": "open",
  "created_at": "2026-02-10T16:56:51.611Z"
}

Add intent-driven page jump support so developers can navigate directly to a page via ADB while the app is running.

Implemented:
- `MainActivity` now parses jump extras:
  - `page` / `com.cadence.player.extra.PAGE` (1-based)
  - `pageIndex` / `com.cadence.player.extra.PAGE_INDEX` (0-based)
- Added `singleTop` launch mode in `AndroidManifest.xml` so repeated `am start` calls route through `onNewIntent`.
- Added `MutableSharedFlow<Int>` in `MainActivity` and routed jump requests into Compose.
- `CadenceApp` passes initial and runtime jump requests into `PlayerScreen`.
- `PlayerScreen` now accepts:
  - `preferInitialPage`
  - `jumpToPageRequests: Flow<Int>`
- Added `jumpToPage()` helper that clamps bounds, seeks to first timed span on the page (if present), and pauses playback.
- Reused `jumpToPage()` for Prev/Next buttons.

Docs:
- Updated `player/README.md` with ADB commands:
  - `adb shell am start -n com.cadence.player/.MainActivity --ei page 30`
  - `adb shell am start -n com.cadence.player/.MainActivity --ei pageIndex 29`

Validation:
- Ran `player/scripts/verify.sh` (known existing dependency-analysis violations remain; compile/detekt/lint pass).
- Installed debug app and verified jump:
  - `adb shell am start -n com.cadence.player/.MainActivity --ei page 10`
  - Screenshot confirms page counter shows `10 / 674`.
