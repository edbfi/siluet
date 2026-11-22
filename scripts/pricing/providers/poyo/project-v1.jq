# SPDX-License-Identifier: AGPL-3.0-or-later
# Project the v1 feed that older readers decode. A rate v1 cannot read becomes unavailable.

include "providers/poyo/rates";

{
  version: 1,
  provider,
  revision,
  sourceDate,
  rates: {
    "z-image": (.rates."z-image" | if fixed_rate then . else {kind: "unavailable"} end),
    "seedream-5.5": (.rates."seedream-5.5" | if image_rate then . else {kind: "unavailable"} end)
  }
}
