#!/usr/bin/env bash

# Mirror only the open-source release branch to GitHub. GitLab remains the
# source of truth for the base, Pro, and Enterprise branches.

set -euo pipefail

readonly github_repository="${GITHUB_REPOSITORY:-Jsciammarella/minecraft-bedrock-manager}"
readonly branch="${CI_COMMIT_REF_NAME:-}"
readonly commit="${CI_COMMIT_SHA:-HEAD}"
readonly github_remote="ci-github-opensource"
readonly github_url="https://github.com/${github_repository}.git"

if [[ -z "${GITHUB_RELEASE_TOKEN:-}" ]]; then
  echo "GITHUB_RELEASE_TOKEN is required" >&2
  exit 1
fi

if [[ ! "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GITHUB_REPOSITORY must use the owner/repository format" >&2
  exit 1
fi

if [[ ! "$branch" =~ ^release/[0-9]+\.[0-9]+\.3$ ]]; then
  echo "Only release/MAJOR.MINOR.3 branches may be mirrored to GitHub" >&2
  exit 1
fi
# Fetch from GitLab before replacing the runner's GitLab credentials with the
# GitHub-only askpass helper.
git lfs fetch origin "$commit"


askpass_file="$(mktemp)"
cleanup() {
  git remote remove "$github_remote" >/dev/null 2>&1 || true
  rm -f "$askpass_file"
}
trap cleanup EXIT

cat >"$askpass_file" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "$GITHUB_RELEASE_TOKEN" ;;
esac
EOF
chmod 700 "$askpass_file"

export GIT_ASKPASS="$askpass_file"
export GIT_TERMINAL_PROMPT=0

git remote remove "$github_remote" >/dev/null 2>&1 || true
git config "lfs.${github_url}/info/lfs.locksverify" false
git remote add "$github_remote" "$github_url"

# Copy only LFS objects reachable from the open-source commit, then update only
# its matching release branch. No other GitLab ref is sent to GitHub.
git lfs push "$github_remote" "$commit"
git push "$github_remote" "$commit:refs/heads/$branch"

# Make a normal GitHub clone land on the actively mirrored open-source branch.
payload="$(printf '{"default_branch":"%s"}' "$branch")"
curl --silent --show-error --fail-with-body \
  --request PATCH \
  --header "Accept: application/vnd.github+json" \
  --header "Authorization: Bearer $GITHUB_RELEASE_TOKEN" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --data "$payload" \
  "https://api.github.com/repos/$github_repository" >/dev/null

echo "Mirrored $branch at $commit to GitHub"
