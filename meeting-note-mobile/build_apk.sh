#!/usr/bin/env bash
set -euo pipefail

# Build a release APK with a git-derived, always-distinct identity, so two builds
# of different code are never labelled the same (the old manual "+2004" bump that
# left fresh and stale APKs indistinguishable).
#
#   versionCode (--build-number) = VERSION_CODE_BASE + commit count
#       -> monotonic and automatic (Play Store requires strictly increasing).
#       The base offset keeps it ABOVE the legacy manual 2004 so an in-place
#       update over already-installed builds still works (commit count alone is
#       only ~227, which Android would reject as a downgrade).
#   versionName (--build-name) = <marketing>-<shortSha>
#       -> ties every APK to a commit, visible in About / `adb dumpsys`.
#
# Flags:
#   --clean-name   use the bare marketing version as versionName (for a store
#                  submission where you do not want the -<sha> suffix).
#
# Env:
#   FLUTTER              path to the flutter binary (default: flutter on PATH)
#   VERSION_CODE_BASE    base offset for versionCode (default: 10000)

cd "$(dirname "$0")/app"

FLUTTER="${FLUTTER:-flutter}"
VERSION_CODE_BASE="${VERSION_CODE_BASE:-10000}"

clean_name=0
for arg in "$@"; do
  [ "$arg" = "--clean-name" ] && clean_name=1
done

marketing="$(grep -E '^version:' pubspec.yaml | sed -E 's/^version:[[:space:]]*([^+ ]+).*/\1/')"
commit_count="$(git rev-list --count HEAD)"
short_sha="$(git rev-parse --short HEAD)"
build_number=$((VERSION_CODE_BASE + commit_count))

if [ "$clean_name" = "1" ]; then
  build_name="$marketing"
else
  build_name="${marketing}-${short_sha}"
fi

echo "Building release APK"
echo "  versionName (build-name):   $build_name"
echo "  versionCode (build-number): $build_number  (base $VERSION_CODE_BASE + $commit_count commits)"
echo "  commit:                     $short_sha"

"$FLUTTER" build apk --release \
  --build-name="$build_name" \
  --build-number="$build_number"

apk="build/app/outputs/flutter-apk/app-release.apk"
echo ""
echo "Built $apk"
echo "  versionName=$build_name versionCode=$build_number"

# Verify the signer certificate. Release APKs are signed with the debug key on the
# operator's PC. A different signer means users cannot update in place.
expected_sha256="fd2f24cf1c0df5d27ba2fab39a8bd75051afc9d4c6d0ab425ed339e6e8821ccb"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$sdk_root" ]; then
  for c in "$LOCALAPPDATA/Android/Sdk" "$HOME/AppData/Local/Android/Sdk" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [ -d "$c" ] && sdk_root="$c" && break
  done
fi
apksigner=""
if [ -n "$sdk_root" ] && [ -d "$sdk_root/build-tools" ]; then
  apksigner="$(ls -d "$sdk_root"/build-tools/*/apksigner* 2>/dev/null | grep -E 'apksigner(\.bat)?$' | sort -V | tail -n 1 || true)"
fi
echo ""
if [ -n "$apksigner" ]; then
  actual_sha256="$("$apksigner" verify --print-certs "$apk" | grep -i 'Signer #1 certificate SHA-256 digest' | head -n 1 | sed 's/.*: *//' | tr -d '\r' | tr 'A-F' 'a-f')"
  echo "Signer certificate SHA-256: $actual_sha256"
  if [ "$actual_sha256" = "$expected_sha256" ]; then
    echo "Signer check: OK (matches the known key)"
  else
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "WARNING: SIGNER MISMATCH. Expected $expected_sha256" >&2
    echo "  Users cannot update this APK in place (uninstall and reinstall needed)." >&2
    echo "  Build on the original PC or restore its ~/.android/debug.keystore. See RUNBOOK.md." >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
  fi
else
  echo "WARNING: apksigner not found (set ANDROID_HOME); could not verify the signer SHA-256." >&2
fi
