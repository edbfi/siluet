# SPDX-License-Identifier: AGPL-3.0-or-later
# The two rate kinds that the v1 feed and the estimator read.

include "publish-validation";

def fixed_rate:
  . == {kind: "unavailable"}
  or (type == "object" and keys == ["credits", "kind"] and .kind == "per-request"
    and (.credits | positive_decimal));

def image_rate:
  . == {kind: "unavailable"}
  or (type == "object" and keys == ["kind", "perReference", "resolutions"]
    and .kind == "per-image-with-references" and (.perReference | positive_decimal)
    and (.resolutions | type == "object" and keys == ["1.5K", "1K", "2K"]
      and all(.[]; positive_decimal)));
