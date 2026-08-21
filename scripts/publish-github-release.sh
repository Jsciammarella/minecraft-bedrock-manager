#!/usr/bin/env bash

# Publish the Windows installer represented by a release tag to the GitHub
# mirror. GitLab remains the source of truth: the installer is pulled from
# GitLab LFS, copied to GitHub LFS, and attached to the matching GitHub Release.

set -euo pipefail

readonly github_repository="${GITHUB_REPOSITORY:-Jsciammarella/minecraft-bedrock-manager}"
readonly release_tag="${RELEASE_TAG:-${CI_COMMIT_TAG:-}}"

if [[ -z "${GITHUB_RELEASE_TOKEN:-}" ]]; then
  echo "GITHUB_RELEASE_TOKEN is required" >&2
  exit 1
fi

if [[ ! "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GITHUB_REPOSITORY must use the owner/repository format" >&2
  exit 1
fi

if [[ ! "$release_tag" =~ ^v([0-9]+\.[0-9]+\.3)$ ]]; then
  echo "Only open-source vMAJOR.MINOR.3 tags are published to GitHub" >&2
  exit 1
fi

readonly release_version="${BASH_REMATCH[1]}"
readonly github_remote="ci-github-release"
readonly github_url="https://github.com/${github_repository}.git"
askpass_file=""
publisher_helper="$(mktemp)"
cp scripts/publish-github-release.py "$publisher_helper"

cleanup() {
  git remote remove "$github_remote" >/dev/null 2>&1 || true
  [[ -z "$askpass_file" ]] || rm -f "$askpass_file"
  [[ -z "$publisher_helper" ]] || rm -f "$publisher_helper"
}
trap cleanup EXIT

git fetch --force origin "refs/tags/${release_tag}:refs/tags/${release_tag}"

mapfile -t installers < <(
  git ls-tree -r --name-only "$release_tag" -- dist/windows \
    | grep -E "^dist/windows/MinecraftBedrockManager-${release_version}(_[0-9]{4})?\.exe$" \
    || true
)

if [[ "${#installers[@]}" -ne 1 ]]; then
  echo "Expected exactly one ${release_version} Windows installer in ${release_tag}; found ${#installers[@]}" >&2
  printf '  %s\n' "${installers[@]:-}" >&2
  exit 1
fi

readonly installer="${installers[0]}"
git checkout --detach "$release_tag"
git lfs pull origin --include="$installer" --exclude=""

if [[ ! -s "$installer" ]]; then
  echo "Installer was not downloaded from GitLab LFS: $installer" >&2
  exit 1
fi

if head -n 1 "$installer" | grep -q '^version https://git-lfs.github.com/spec/v1$'; then
  echo "Installer is still an LFS pointer: $installer" >&2
  exit 1
fi

git remote remove "$github_remote" >/dev/null 2>&1 || true
git remote add "$github_remote" "$github_url"

askpass_file="$(mktemp)"
chmod 700 "$askpass_file"
cat >"$askpass_file" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$GITHUB_RELEASE_TOKEN" ;;
esac
EOF

export GIT_ASKPASS="$askpass_file"
export GIT_TERMINAL_PROMPT=0

# Copy only LFS objects reachable from this open-source release. Objects that
# exist solely on Pro or Enterprise refs must never be sent to GitHub.
git lfs fetch origin "$release_tag"
git lfs push "$github_remote" "$release_tag"

python3 "$publisher_helper" "$github_repository" "$release_tag" "$installer"
echo "Published $installer to GitHub release $release_tag"
