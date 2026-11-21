#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
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
    feed_file=feed.json
    data_ref=refs/heads/pricing-data
    date_field=sourceDate
    label=PoYo
    ;;
  1:toapis)
    feed_file=toapis.json
    data_ref=refs/heads/pricing-data-toapis
    date_field=observedAt
    label=ToAPIs
    ;;
  *) fail "Usage: publish.sh poyo LICENSE.poyo | publish.sh toapis" ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

canonical_feed() {
  head -c 4097 | jq -RsceS -L "$script_dir" -f "$script_dir/providers/$provider/publish.jq"
}

# Construct the exact data-only tree without checking out the branch.
# https://git-scm.com/docs/git-mktree
build_tree() {
  local feed_blob=$1 license_blob=$2 v1_tree pricing_tree
  v1_tree=$({
    printf '100644 blob %s\t%s\n' "$feed_blob" "$feed_file"
    if [[ -n $license_blob ]]; then
      printf '100644 blob %s\tLICENSE.poyo\n' "$license_blob"
    fi
  } | git mktree) || return
  pricing_tree=$(printf '040000 tree %s\tv1\n' "$v1_tree" | git mktree) || return
  printf '040000 tree %s\tpricing\n' "$pricing_tree" | git mktree
}

check_poyo_update() {
  local revision old_revision
  revision=$(jq -r '.revision' <<<"$candidate")
  old_revision=$(jq -r '.revision' <<<"$previous")
  if [[ "$revision" == "$old_revision" ]]; then
    [[ "$source_date" == "$old_date" && "$license_blob" == "$old_license" ]] ||
      fail "The same PoYo revision produced a different source date or license."
    if [[ "$candidate" == "$previous" ]]; then
      printf '%s\n' "Pricing feed is unchanged."
      exit 0
    fi
    # A reviewed collector update can fill a gap at the same source revision.
    jq -e --argjson old "$previous" '
      all(.rates | to_entries[];
        . as $rate | $old.rates[$rate.key] as $old_rate
        | $old_rate == $rate.value or $old_rate == {kind: "unavailable"})
    ' <<<"$candidate" >/dev/null ||
      fail "The same PoYo revision changed an existing rate."
  else
    [[ "$source_date" > "$old_date" ]] ||
      fail "The pricing candidate does not have a newer source date."
  fi
}

check_toapis_update() {
  jq -en --argjson candidate "$candidate" --argjson previous "${previous:-null}" --arg now "$now" \
    -f "$script_dir/providers/toapis/freshness.jq" >/dev/null || fail "ToAPIs source freshness validation failed."
  [[ -n $previous ]] || return 0
  if [[ "$candidate" == "$previous" ]]; then
    printf '%s\n' "Pricing feed is unchanged."
    exit 0
  fi
  [[ "$source_date" > "$old_date" ]] ||
    fail "The ToAPIs candidate does not have a newer observation."
  if [[ ${source_date:0:10} == "${old_date:0:10}" ]]; then
    printf '%s\n' "ToAPIs pricing was already published today."
    exit 0
  fi
}

candidate=$(canonical_feed)
source_date=$(jq -r --arg field "$date_field" '.[$field]' <<<"$candidate")
now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
[[ "$source_date" > "$now" ]] && fail "The pricing candidate source date is in the future."
license_blob=''
old_license=''
if [[ $provider == poyo ]]; then
  license_blob=$(git hash-object --no-filters -w -- "$2")
fi

parents=()
previous=''
if git ls-remote --exit-code --refs origin "$data_ref" >/dev/null; then
  git fetch --no-tags --depth=1 origin "$data_ref"
  parent=$(git rev-parse FETCH_HEAD)
  parents=(-p "$parent")
  old_feed=$(git rev-parse "$parent:pricing/v1/$feed_file")
  if [[ $provider == poyo ]]; then
    old_license=$(git rev-parse "$parent:pricing/v1/LICENSE.poyo")
  fi
  expected_tree=$(build_tree "$old_feed" "$old_license")
  [[ $(git rev-parse "$parent^{tree}") == "$expected_tree" ]] ||
    fail "Unexpected contents in the $data_ref branch."
  previous=$(git cat-file blob "$old_feed" | canonical_feed)
  old_date=$(jq -r --arg field "$date_field" '.[$field]' <<<"$previous")
  if [[ $provider == poyo ]]; then
    check_poyo_update
  fi
else
  [[ $? == 2 ]] || fail "Could not determine whether the $data_ref branch exists."
fi
if [[ $provider == toapis ]]; then
  check_toapis_update
fi

# https://git-scm.com/docs/git-commit-tree
feed_blob=$(printf '%s\n' "$candidate" | git hash-object -w --stdin)
tree=$(build_tree "$feed_blob" "$license_blob")
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
