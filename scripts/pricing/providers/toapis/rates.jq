# SPDX-License-Identifier: AGPL-3.0-or-later
# The rate grammar shared by the frozen v1 feed and the v2 feed.

include "publish-validation";

def model_source($model): {
  url: ("https://toapis.com/model-guide/" + $model),
  scope: "public-advertised", region: "global-site", tier: null, publishedAt: null
};

def image_rate($size): {
  model: "doubao-seedream-5-5", operations: ["generate", "edit"], unit: "image",
  conditions: {size: $size, outputCount: 1, layerDecomposition: false},
  source: model_source("doubao-seedream-5-5")
};

# Each reference image is charged on top of the output tier, with no free allowance.
def reference_rate: {
  model: "doubao-seedream-5-5", operations: ["generate", "edit"], unit: "reference-image",
  conditions: {freeAllowance: 0}, source: model_source("doubao-seedream-5-5")
};

def video_rate($video_input): {
  model: "seedance-2-5", operations: ["generate", "edit"], unit: "million-total-tokens",
  conditions: {videoInput: $video_input}, source: model_source("seedance-2-5")
};

def cache_age($observed):
  . == null or (type == "number" and . >= 0 and . <= $observed and floor == .);

def decimal_parts:
  split(".") | [(.[0] | tonumber), (((.[1] // "") + "000000")[:6] | tonumber)];

def valid_amounts:
  (.usd | positive_decimal) and (.approximateCredits | positive_decimal)
  # Split into whole and fractional parts to multiply without rounding decimal rates.
  and ((.usd | decimal_parts) as [$whole, $fraction]
    | ($fraction * 200) as $scaled
    | (.approximateCredits | decimal_parts) == [($whole * 200 + ($scaled / 1000000 | floor)), ($scaled % 1000000)]);

# Seedream rates come from the image page and Seedance rates from the video page.
def rate_delay($delays):
  (if .model == "doubao-seedream-5-5" then $delays.image else $delays.video end) // 0;

# $rates lists the expected rates without their amounts and page ages.
def valid_feed($observed; $rates):
  $observed >= 0
  and (if has("receiptDelaySeconds") then
    .receiptDelaySeconds | type == "object" and keys == ["conversion", "image", "video"]
      and all(.[]; type == "number" and floor == . and . >= 0 and . <= $observed)
      and .conversion >= .image and .image >= .video
  else true end)
  and ((.receiptDelaySeconds.conversion // 0) as $delay | .conversionCacheAgeSeconds | cache_age($observed - $delay))
  and (.receiptDelaySeconds as $delays | all(.rates[];
    rate_delay($delays) as $delay | .source.cacheAgeSeconds | cache_age($observed - $delay)))
  and (.rates | type == "array"
    and map(del(.usd, .approximateCredits, .source.cacheAgeSeconds)) == $rates
    and all(.[]; valid_amounts and (.source | has("cacheAgeSeconds") and (.cacheAgeSeconds | cache_age($observed))))
    and (.[0] | del(.conditions)) == (.[1] | del(.conditions))
    # Rates from one page share its source, including its reported age.
    and ([.[] | select(.model == "doubao-seedream-5-5") | .source] | unique | length == 1)
    and ([.[] | select(.model == "seedance-2-5") | .source] | unique | length == 1));

def valid_envelope($version):
  type == "object"
  and .version == $version and .provider == "toapis" and (.observedAt | timestamp)
  and .creditsPerUsd == "200" and .conversionSourceUrl == "https://toapis.com/pricing"
  and .gaps == [
    {model: "doubao-seedream-5-5", reason: "unpriced-image-options"},
    {model: "seedance-2-5", reason: "token-usage-unknown"}
  ];
