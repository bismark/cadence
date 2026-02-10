---
name: player-verify
description: Run Cadence player verification checks (compileDebugKotlin, detekt, lintDebug, buildHealth) after any changes under player/.
---

# Player Verify

Use this skill whenever work touches files in `player/`.

## Run

```bash
./run.sh
```

## Checks executed

`./run.sh` calls `player/scripts/verify.sh`, which runs:
- `:app:compileDebugKotlin`
- `detekt`
- `:app:lintDebug`
- `buildHealth`

## Reports

- `player/app/build/reports/detekt/detekt.html`
- `player/app/build/reports/lint-results-debug.html`
- `player/build/reports/dependency-analysis/build-health-report.txt`
