#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs on the Ubuntu Actions runners; local runs need GNU date and bash 4 or later.
set -euo pipefail
export LC_ALL=C GIT_TERMINAL_PROMPT=0

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Select fixed destinations independently of the candidate data.
provider=${1:-}
case "$#:$provider" in
  2:poyo)
    data_ref=refs/heads/pricing-data
    label=PoYo
    ;;
  1:toapis)
    data_ref=refs/heads/pricing-data-toapis
    label=ToAPIs
    ;;
  *) fail "Usage: publish.sh poyo LICENSE.poyo < poyo.json | publish.sh toapis < toapis.json" ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Feeds stay in files so no feed passes through argv or the environment.
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Record the outcome as a run annotation and a summary line.
report() {
  printf '::notice title=%s::%s\n' "$1" "$2"
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    printf -- '- %s\n' "$2" >>"$GITHUB_STEP_SUMMARY"
  fi
}

skip() {
  report "Pricing not published" "$1"
  exit 0
}

# Write the canonical compact JSON and its trailing LF. Reject input over the byte limit, and
# output whose published blob (LF included) would exceed it. LC_ALL=C makes ${#feed} a byte count.
canonical_feed() {
  local filter=$1 limit=$2 feed
  feed=$(head -c "$((limit + 1))" | jq -RsceS -L "$script_dir" -f "$script_dir/$filter")
  ((${#feed} + 1 <= limit)) || fail "The pricing feed exceeds the size limit."
  printf '%s\n' "$feed"
}

field() {
  jq -r --arg field "$1" '.[$field]' "$2"
}

# Construct the exact data-only tree without checking out the branch. Each feed is optional,
# and the PoYo license accompanies each PoYo feed.
# https://git-scm.com/docs/git-mktree
version_tree() {
  local feed=$1 name=$2 license=$3
  {
    if [[ -n $license ]]; then
      printf '100644 blob %s\tLICENSE.poyo\n' "$license"
    fi
    printf '100644 blob %s\t%s\n' "$feed" "$name"
  } | git mktree
}

build_tree() {
  local v1_feed=$1 license=$2 v2_feed=${3:-} v1_tree='' v2_tree='' pricing_tree
  if [[ -n $v1_feed ]]; then
    v1_tree=$(version_tree "$v1_feed" "$v1_name" "$license") || return
  fi
  if [[ -n $v2_feed ]]; then
    v2_tree=$(version_tree "$v2_feed" "$v2_name" "$license") || return
  fi
  pricing_tree=$({
    if [[ -n $v1_tree ]]; then
      printf '040000 tree %s\tv1\n' "$v1_tree"
    fi
    if [[ -n $v2_tree ]]; then
      printf '040000 tree %s\tv2\n' "$v2_tree"
    fi
  } | git mktree) || return
  printf '040000 tree %s\tpricing\n' "$pricing_tree" | git mktree
}

now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
now_seconds=$(date -u -d "$now" '+%s')

if [[ $provider == poyo ]]; then
  v1_name=feed.json
  v2_name=poyo.json
  canonical_feed providers/poyo/publish-v2.jq 65536 >"$work/candidate.json"
  source_date=$(field sourceDate "$work/candidate.json")
  confirmed_at=$(field confirmedAt "$work/candidate.json")
  license_blob=$(git hash-object --no-filters -w -- "$2")
else
  # The v1 feed cannot express the reference-image rate, so it stays frozen and only v2 advances.
  v1_name=toapis.json
  v2_name=toapis.json
  canonical_feed providers/toapis/publish-v2.jq 4096 >"$work/candidate.json"
  source_date=$(field observedAt "$work/candidate.json")
  license_blob=''
fi
[[ "$source_date" > "$now" ]] && fail "The pricing candidate source date is in the future."

parents=()
old_v1=''
old_v2=''
old_license=''
if git ls-remote --exit-code --refs origin "$data_ref" >/dev/null; then
  git fetch --no-tags --depth=1 origin "$data_ref"
  parent=$(git rev-parse FETCH_HEAD)
  parents=(-p "$parent")
  if [[ $provider == poyo ]]; then
    old_v1=$(git rev-parse "$parent:pricing/v1/$v1_name")
    old_license=$(git rev-parse "$parent:pricing/v1/LICENSE.poyo")
  else
    old_v1=$(git rev-parse --verify --quiet "$parent:pricing/v1/$v1_name" || true)
  fi
  old_v2=$(git rev-parse --verify --quiet "$parent:pricing/v2/$v2_name" || true)
  expected_tree=$(build_tree "$old_v1" "$old_license" "$old_v2")
  [[ $(git rev-parse "$parent^{tree}") == "$expected_tree" ]] ||
    fail "Unexpected contents in the $data_ref branch."
  if [[ -n $old_v1 ]]; then
    git cat-file blob "$old_v1" |
      canonical_feed "providers/$provider/publish.jq" 4096 >"$work/previous-v1.json"
  fi
  if [[ -n $old_v2 && $provider == poyo ]]; then
    git cat-file blob "$old_v2" | canonical_feed providers/poyo/publish-v2.jq 65536 >"$work/previous-v2.json"
  elif [[ -n $old_v2 ]]; then
    git cat-file blob "$old_v2" | canonical_feed providers/toapis/publish-v2.jq 4096 >"$work/previous-v2.json"
  fi
else
  [[ $? == 2 ]] || fail "Could not determine whether the $data_ref branch exists."
fi

if [[ $provider == poyo ]]; then
  # A rerun of the same collection publishes nothing.
  if [[ -n $old_v2 && $license_blob == "$old_license" ]] &&
    cmp -s "$work/candidate.json" "$work/previous-v2.json"; then
    skip "PoYo pricing is unchanged."
  fi
  # Only this run's history check mints a confirmation, so it must be current.
  confirmed_seconds=$(date -u -d "$confirmed_at" '+%s')
  ((confirmed_seconds <= now_seconds)) || fail "The PoYo confirmation is in the future."
  ((confirmed_seconds + 30 * 86400 > now_seconds)) || fail "The PoYo confirmation has expired."
  ((now_seconds - confirmed_seconds <= 3600)) ||
    fail "The PoYo confirmation is more than one hour older than the publisher's clock."
  if [[ -n $old_license ]]; then
    previous="$work/previous-v1.json"
    if [[ -n $old_v2 ]]; then
      previous="$work/previous-v2.json"
    fi
    license_state=same
    [[ $license_blob == "$old_license" ]] || license_state=changed
    update=$(jq -r --slurpfile previous "$previous" --arg license "$license_state" \
      -L "$script_dir" -f "$script_dir/providers/poyo/order.jq" "$work/candidate.json") ||
      fail "PoYo pricing ordering validation failed."
    # Publish at most one confirmation-only update per UTC day.
    if [[ -n $old_v2 && $update == confirmation &&
      ${confirmed_at:0:10} == "$(field confirmedAt "$previous" | cut -c1-10)" ]]; then
      skip "PoYo pricing was already confirmed today."
    fi
  fi
  # Older readers keep v1. Reuse its blob unless the projection changes.
  jq -c -L "$script_dir" -f "$script_dir/providers/poyo/project-v1.jq" "$work/candidate.json" |
    canonical_feed providers/poyo/publish.jq 4096 >"$work/projection.json"
  if [[ -n $old_v1 ]] && cmp -s "$work/projection.json" "$work/previous-v1.json"; then
    v1_blob=$old_v1
  else
    v1_blob=$(git hash-object -w -- "$work/projection.json")
  fi
  v2_blob=$(git hash-object -w -- "$work/candidate.json")
  revision=$(field revision "$work/candidate.json")
  outcome="PoYo pricing published: revision ${revision:0:12}, source $source_date, confirmed $confirmed_at."
else
  # Compare with the previous v2 feed, or with the frozen v1 feed before the first v2 publish.
  previous="$work/previous-v2.json"
  if [[ -z $old_v2 ]]; then
    previous="$work/previous-v1.json"
    if [[ -z $old_v1 ]]; then
      : >"$previous"
    fi
  fi
  jq -en --slurpfile candidate "$work/candidate.json" --slurpfile previous "$previous" \
    --arg now "$now" -f "$script_dir/providers/toapis/freshness.jq" >/dev/null ||
    fail "ToAPIs source freshness validation failed."
  if [[ -n $old_v2 ]] && cmp -s "$work/candidate.json" "$previous"; then
    skip "ToAPIs pricing is unchanged."
  fi
  if [[ -n $old_v1 || -n $old_v2 ]]; then
    old_date=$(field observedAt "$previous")
    [[ "$source_date" > "$old_date" ]] ||
      fail "The ToAPIs candidate does not have a newer observation."
    # The first v2 publish proceeds on the day of the last v1 observation.
    if [[ -n $old_v2 && ${source_date:0:10} == "${old_date:0:10}" ]]; then
      skip "ToAPIs pricing was already published today."
    fi
  fi
  v1_blob=$old_v1
  v2_blob=$(git hash-object -w -- "$work/candidate.json")
  outcome="ToAPIs pricing published: observed $source_date."
fi

# https://git-scm.com/docs/git-commit-tree
tree=$(build_tree "$v1_blob" "$license_blob" "$v2_blob")
export GIT_AUTHOR_NAME='github-actions[bot]' GIT_COMMITTER_NAME='github-actions[bot]'
export GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com'
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
commit=$(git -c commit.gpgSign=false commit-tree "$tree" "${parents[@]}" \
  -m "chore(pricing): publish $label feed" \
  -m "Signed-off-by: $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>")

# A normal push rejects a concurrently advanced branch or competing bootstrap.
# https://git-scm.com/docs/git-push#_note_about_fast_forwards
if [[ -n ${PRICING_PUSH_TOKEN:-} ]]; then
  auth=$(printf 'x-access-token:%s' "$PRICING_PUSH_TOKEN" | base64 -w0)
  printf '::add-mask::%s\n' "$auth"
  PRICING_AUTH_HEADER="Authorization: Basic $auth" \
    git --config-env=http.https://github.com/.extraheader=PRICING_AUTH_HEADER \
      push origin "$commit:$data_ref"
else
  git push origin "$commit:$data_ref"
fi
report "Pricing published" "$outcome"
