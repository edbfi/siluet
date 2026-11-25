# SPDX-License-Identifier: AGPL-3.0-or-later
# Check the frozen v1 feed that the data branch still carries for older installations.

include "publish-validation";
include "providers/toapis/rates";

read_feed(4096)
| if valid_envelope(1)
  and (del(.receiptDelaySeconds) | keys) == ["conversionCacheAgeSeconds", "conversionSourceUrl", "creditsPerUsd", "gaps",
    "observedAt", "provider", "rates", "version"]
  and valid_feed(.observedAt | fromdateiso8601;
    [image_rate("1K"), image_rate("1.5K"), image_rate("2K"), video_rate(false), video_rate(true)])
then .
else error("Invalid ToAPIs pricing feed handoff")
end
