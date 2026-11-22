# SPDX-License-Identifier: AGPL-3.0-or-later

def effective_observations:
  (.observedAt | fromdateiso8601) as $observed
  | .receiptDelaySeconds as $delays
  | [((.conversionCacheAgeSeconds // 0) + ($delays.conversion // 0)),
     (.rates[] | (.source.cacheAgeSeconds // 0) +
       ((if .unit == "image" then $delays.image else $delays.video end) // 0))]
  | map($observed - .);

# The publisher passes each feed as a file, so both arrive slurped.
$candidate[0] as $candidate
| $previous[0] as $previous
| ($candidate | effective_observations) as $current
| if ($current | min) + (30 * 86400) <= ($now | fromdateiso8601) then
    error("The ToAPIs candidate has expired source evidence.")
  elif $previous != null then
    ($previous | effective_observations) as $prior
    | if any(range($current | length); $current[.] < $prior[.]) then
        error("The ToAPIs candidate would roll back a source observation (rollback).")
      else true end
  else true end
