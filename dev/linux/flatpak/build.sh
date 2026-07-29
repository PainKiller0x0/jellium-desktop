#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUILD_OUT="${REPO_ROOT}/build/flatpak"
DIST_DIR="${REPO_ROOT}/dist"
mkdir -p "$BUILD_OUT" "$DIST_DIR"
cd "$BUILD_OUT"

MANIFEST="${SCRIPT_DIR}/net.nullsum.JelliumDesktop.yml"
APP_ID="net.nullsum.JelliumDesktop"
VERSION="$(cargo run --quiet --manifest-path "${REPO_ROOT}/src/xtask/Cargo.toml" -- version)"
DATE="$(date -u +%Y-%m-%d)"
ARCH="$(uname -m)"
BUNDLE_NAME="JelliumDesktop-${VERSION}-linux-${ARCH}.flatpak"
RUNTIME_VERSION="25.08"

# Check dependencies
command -v flatpak >/dev/null || { echo "Error: flatpak not found"; exit 1; }
command -v flatpak-builder >/dev/null || { echo "Error: flatpak-builder not found"; exit 1; }

# flatpak-builder downloads manifest sources on the host. Some runner images
# do not pass the system CA bundle to its downloader, which causes TLS errors
# such as: "CAfile: none CRLfile: none". Export the standard bundle paths
# before any source fetch or SDK operation.
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
    export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
fi

# Install SDK and runtime if needed
if ! flatpak info --user org.freedesktop.Sdk//$RUNTIME_VERSION >/dev/null 2>&1 && \
   ! flatpak info --system org.freedesktop.Sdk//$RUNTIME_VERSION >/dev/null 2>&1; then
    echo "Installing Freedesktop SDK $RUNTIME_VERSION..."
    flatpak install --user -y flathub org.freedesktop.Sdk//$RUNTIME_VERSION org.freedesktop.Platform//$RUNTIME_VERSION
fi

# rust-stable SDK extension provides cargo/rustc for the Rust workspace
if ! flatpak info --user org.freedesktop.Sdk.Extension.rust-stable//$RUNTIME_VERSION >/dev/null 2>&1 && \
   ! flatpak info --system org.freedesktop.Sdk.Extension.rust-stable//$RUNTIME_VERSION >/dev/null 2>&1; then
    echo "Installing Freedesktop Rust SDK extension $RUNTIME_VERSION..."
    flatpak install --user -y flathub org.freedesktop.Sdk.Extension.rust-stable//$RUNTIME_VERSION
fi

# llvm SDK extension provides libclang.so for bindgen (jfn-mpv's
# build.rs runs bindgen on mpv + libavcodec headers).
if ! flatpak info --user org.freedesktop.Sdk.Extension.llvm20//$RUNTIME_VERSION >/dev/null 2>&1 && \
   ! flatpak info --system org.freedesktop.Sdk.Extension.llvm20//$RUNTIME_VERSION >/dev/null 2>&1; then
    echo "Installing Freedesktop llvm SDK extension $RUNTIME_VERSION..."
    flatpak install --user -y flathub org.freedesktop.Sdk.Extension.llvm20//$RUNTIME_VERSION
fi

(cd "$REPO_ROOT" && cargo xtask fetch-cef)

# Generate metainfo.xml with the current version injected.
python3 "${SCRIPT_DIR}/generate_metainfo.py" \
    --template "${REPO_ROOT}/resources/linux/net.nullsum.JelliumDesktop.metainfo.xml" \
    --output "${BUILD_OUT}/generated.metainfo.xml" \
    --version "$VERSION" \
    --date "$DATE"

# Build
echo "Building flatpak..."
flatpak-builder --user --repo=repo --force-clean build-dir "$MANIFEST"

# Create bundle
echo "Creating bundle..."
flatpak build-bundle repo "${DIST_DIR}/${BUNDLE_NAME}" "$APP_ID"

echo "Done: ${DIST_DIR}/${BUNDLE_NAME}"
