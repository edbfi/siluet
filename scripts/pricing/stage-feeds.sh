#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Stage pricing feeds from origin for freshness.ts, one feed at a time.
# Usage: stage-feeds.sh DIR BRANCH:PATH:NAME...
#
# A branch or file that is confirmed absent is left unstaged, so freshness.ts reports it as
# missing (or checks PoYo v1 while v2 is absent). A failed read is reported as an error and
# fails this script only after every other feed has been staged.
set -uo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0

dir=${1:?Usage: stage-feeds.sh DIR BRANCH:PATH:NAME...}
shift
mkdir -p -- "$dir" || exit 1
status=0

error() {
  printf '::error title=Pricing freshness::%s\n' "$1"
  status=1
}

declare -A branches=()
for spec in "$@"; do
  IFS=: read -r branch path name <<<"$spec"
  ref="refs/remotes/origin/$branch"
  if [[ -z ${branches[$branch]:-} ]]; then
    # --exit-code returns 2 only when the remote has no such branch.
    git ls-remote --exit-code origin "refs/heads/$branch" >/dev/null
    case $? in
      0)
        if git fetch --quiet --no-tags --depth=1 origin "+refs/heads/$branch:$ref"; then
          branches[$branch]=fetched
        else
          branches[$branch]=failed
          error "Could not fetch the $branch branch."
        fi
        ;;
      2)
        branches[$branch]=absent
        printf 'The %s branch does not exist.\n' "$branch"
        ;;
      *)
        branches[$branch]=failed
        error "Could not determine whether the $branch branch exists."
        ;;
    esac
  fi
  [[ ${branches[$branch]} == fetched ]] || continue
  if ! listing=$(git ls-tree --name-only "$ref" -- "$path"); then
    error "Could not list $path on the $branch branch."
  elif [[ -z $listing ]]; then
    printf '%s does not exist on the %s branch.\n' "$path" "$branch"
  elif ! git show "$ref:$path" >"$dir/$name"; then
    rm -f -- "$dir/$name"
    error "Could not read $path from the $branch branch."
  fi
done
exit "$status"
