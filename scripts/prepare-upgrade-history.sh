#!/usr/bin/env bash
set -euo pipefail
umask 077

output="$(realpath -m "${1:?Usage: prepare-upgrade-history.sh NEW_OUTPUT_DIRECTORY}")"
mkdir "$output"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

server_repo=https://github.com/clickety-clacks/harklight-server
fixture_commit=b53bf742c2ead8a9d10fa1794d9d317f1a8ca033
fixture="$scratch/synthetic-history-inventory.exs"
curl -fsSL --retry 3 \
  "https://raw.githubusercontent.com/clickety-clacks/harklight-server/$fixture_commit/scripts/synthetic-history-inventory.exs" \
  -o "$fixture"

versions=(0.1.49 0.2.0 0.2.16 0.2.28)
for version in "${versions[@]}"; do
  package="harklight-server-$version-linux-x86_64"
  mkdir "$scratch/$version"
  (
    cd "$scratch/$version"
    release="$server_repo/releases/download/v$version"
    curl -fsSL --retry 3 -O "$release/$package.tar.gz"
    curl -fsSL --retry 3 -O "$release/SHA256SUMS"
    awk -v file="$package.tar.gz" '$2 == file || $2 == "*" file' SHA256SUMS > "$output/SHA256SUMS-$version.txt"
    sha256sum --check "$output/SHA256SUMS-$version.txt"
    tar -xzf "$package.tar.gz" --strip-components=1
  )
done

# The pinned Server fixture starts an isolated Relay and uses synthetic identities.
# Keep the release's default listener disabled and its HOME separate.
mkdir "$scratch/"{home,original,upgrade}
export HOME="$scratch/home" ATTENTION_SERVER_ENABLE=0
export ERL_FLAGS='+S 2:2 +SDcpu 1 +SDio 1'
export FIXTURE_SCRIPT="$fixture"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$scratch/owner.key" -out "$scratch/owner.der" -outform DER -days 1 \
  -subj /CN=synthetic-owner 2>/dev/null

isolated() {
  sudo systemd-run --quiet --wait --pipe --collect --property=PrivateNetwork=yes \
    --property=MemoryMax=4G --property=MemorySwapMax=0 --uid="$(id -u)" \
    --working-directory="$scratch" /usr/bin/env HOME="$HOME" \
    ATTENTION_SERVER_ENABLE="$ATTENTION_SERVER_ENABLE" ERL_FLAGS="$ERL_FLAGS" \
    FIXTURE_SCRIPT="$FIXTURE_SCRIPT" FIXTURE_DB="$db" STAGE="$version" \
    OWNER_DER="$scratch/owner.der" INVENTORY="$output/$version.json" "$@"
}

inventory() {
  isolated "$scratch/$version/bin/attention_server" eval 'Code.require_file(System.fetch_env!("FIXTURE_SCRIPT"))'
}

db="$scratch/original/relay.sqlite3"
version="${versions[0]}"
inventory
original_checksum="$(sha256sum "$db")"
cp -a "$scratch/original/." "$scratch/upgrade/"
db="$scratch/upgrade/relay.sqlite3"
for version in "${versions[@]:1}"; do
  if [[ "$version" == 0.2.28 ]]; then
    isolated "$scratch/$version/bin/harklight" store convert-stopped "$db" --from-release v0.2.16
  fi
  inventory
done
printf '%s\n' "$original_checksum" | sha256sum --check > "$output/original-check.txt"
