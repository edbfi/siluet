# SPDX-License-Identifier: AGPL-3.0-or-later

# When each page was observed, keyed so a v2 feed compares with a v1 feed on shared rates.
def effective_observations:
  (.observedAt | fromdateiso8601) as $observed
  | .receiptDelaySeconds as $delays
  | {conversion: ((.conversionCacheAgeSeconds // 0) + ($delays.conversion // 0))}
    + (.rates | map({
      key: (if .unit == "image" then "image:" + .conditions.size
        elif .unit == "reference-image" then "reference-image"
        else "video:" + (.conditions.videoInput | tostring) end),
      # The reference rate comes from the Seedream page, so it shares the image delay.
      value: ((.source.cacheAgeSeconds // 0) +
        ((if .model == "doubao-seedream-5-5" then $delays.image else $delays.video end) // 0))
    }) | from_entries)
  | map_values($observed - .);

# The publisher passes each feed as a file, so both arrive slurped.
$candidate[0] as $candidate
| $previous[0] as $previous
| ($candidate | effective_observations) as $current
| if ([$current[]] | min) + (30 * 86400) <= ($now | fromdateiso8601) then
    error("The ToAPIs candidate has expired source evidence.")
  elif $previous != null then
    ($previous | effective_observations) as $prior
    | if any($prior | keys[]; $current[.] != null and $current[.] < $prior[.]) then
        error("The ToAPIs candidate would roll back a source observation (rollback).")
      else true end
  else true end
