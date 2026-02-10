#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PLAYER_DIR"

echo "==> Running player verification checks"

DEPENDENCY_REPORT="build/reports/dependency-analysis/build-health-report.txt"
GRADLE_LOG="$(mktemp -t cadence-player-verify.XXXXXX.log)"
trap 'rm -f "$GRADLE_LOG"' EXIT

./gradlew --console=plain \
  :app:compileDebugKotlin \
  detekt \
  :app:lintDebug \
  buildHealth | tee "$GRADLE_LOG"

if grep -q "There were dependency violations" "$GRADLE_LOG"; then
  echo ""
  echo "❌ Dependency analysis reported violations."
  echo "   See: $DEPENDENCY_REPORT"
  exit 1
fi

echo "==> Done. Reports:"
echo "    - Detekt: app/build/reports/detekt/detekt.html"
echo "    - Lint: app/build/reports/lint-results-debug.html"
echo "    - Dependency analysis: $DEPENDENCY_REPORT"
