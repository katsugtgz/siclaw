#!/bin/bash
set -euo pipefail

# Match the pinned upstream .github/actions/setup-rusty-v8 action. Codex's
# sandbox-enabled V8 archives are published by openai/codex, rather than the
# default rusty_v8 release URL. The source checkout pins the manifest digest.
codex_source_root="${1:?Pass the pinned Codex source directory}"
v8_version="$(python3 "$codex_source_root/.github/scripts/rusty_v8_bazel.py" resolved-v8-crate-version)"
target="$(rustc -vV | sed -n 's/^host: //p')"
profile=ptrcomp_sandbox_release
artifact_dir=/tmp/codex-rusty-v8
release_url="https://github.com/openai/codex/releases/download/rusty-v8-v${v8_version}"
archive="librusty_v8_${profile}_${target}.a.gz"
binding="src_binding_${profile}_${target}.rs"
manifest="rusty_v8_${profile}_${target}.sha256"
trusted_manifests="$codex_source_root/third_party/v8/rusty_v8_${v8_version//./_}_release_manifests.sha256"

mkdir -p "$artifact_dir"
curl -fsSL --retry 3 "$release_url/$manifest" -o "$artifact_dir/$manifest"
expected="$(awk -v file="$manifest" '$2 == file { print $1 }' "$trusted_manifests")"
actual="$(sha256sum "$artifact_dir/$manifest" | cut -d ' ' -f 1)"
test -n "$expected" && test "$actual" = "$expected"
curl -fsSL --retry 3 "$release_url/$archive" -o "$artifact_dir/$archive"
curl -fsSL --retry 3 "$release_url/$binding" -o "$artifact_dir/$binding"
test "$(wc -l < "$artifact_dir/$manifest")" -eq 2
(cd "$artifact_dir" && tr -d '\r' < "$manifest" | sha256sum --check -)

export RUSTY_V8_ARCHIVE="$artifact_dir/$archive"
export RUSTY_V8_SRC_BINDING_PATH="$artifact_dir/$binding"
cd "$codex_source_root/codex-rs"
cargo build --release --locked -p codex-code-mode-host --bin codex-code-mode-host
target/release/codex-code-mode-host --help >/dev/null
