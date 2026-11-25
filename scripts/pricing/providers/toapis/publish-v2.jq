# SPDX-License-Identifier: AGPL-3.0-or-later
# Check the v2 handoff against the rate coverage that every v2 reader decodes.

include "publish-validation";
include "providers/toapis/rates";

read_feed(4096)
| if valid_envelope(2)
  and keys == ["conversionCacheAgeSeconds", "conversionSourceUrl", "creditsPerUsd", "gaps",
    "observedAt", "provider", "rates", "receiptDelaySeconds", "version"]
  and valid_feed(.observedAt | fromdateiso8601; [image_rate("1K"), image_rate("1.5K"), image_rate("2K"),
    reference_rate, video_rate(false), video_rate(true)])
then .
else error("Invalid ToAPIs v2 pricing feed handoff")
end
