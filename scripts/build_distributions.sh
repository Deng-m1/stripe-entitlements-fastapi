#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
output_argument="${1:-dist}"
if [[ "$output_argument" = /* ]]; then
  output_path="$output_argument"
else
  output_path="$PWD/$output_argument"
fi
mkdir -p "$output_path"
artifact_dir="$(cd "$output_path" && pwd -P)"

if find "$artifact_dir" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo "distribution output directory must be empty: $artifact_dir" >&2
  exit 1
fi

build_root="$(mktemp -d)"
cleanup_build_root() {
  rm -rf -- "$build_root"
}
trap cleanup_build_root EXIT

cd "$repository_root"
uv build --sdist --out-dir "$artifact_dir"

shopt -s nullglob
sdists=("$artifact_dir"/*.tar.gz)
if [[ "${#sdists[@]}" -ne 1 ]]; then
  echo "expected exactly one source distribution" >&2
  exit 1
fi

tar -xzf "${sdists[0]}" -C "$build_root"
source_roots=("$build_root"/*)
if [[ "${#source_roots[@]}" -ne 1 || ! -d "${source_roots[0]}" ]]; then
  echo "source distribution must contain exactly one root directory" >&2
  exit 1
fi

(
  cd "${source_roots[0]}"
  uv build --wheel --out-dir "$artifact_dir"
)

wheels=("$artifact_dir"/*.whl)
if [[ "${#wheels[@]}" -ne 1 ]]; then
  echo "expected exactly one Wheel rebuilt from the source distribution" >&2
  exit 1
fi
