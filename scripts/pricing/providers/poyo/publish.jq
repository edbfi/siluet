# SPDX-License-Identifier: AGPL-3.0-or-later

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

read_feed
| if type == "object" and keys == ["provider", "rates", "revision", "sourceDate", "version"]
    and .version == 1 and .provider == "poyo"
    and (.revision | type == "string" and test("\\A[a-f0-9]{40}\\z"))
    and (.sourceDate | timestamp)
    and (.rates | type == "object" and keys == ["seedream-5.5", "z-image"]
      and (."z-image" | fixed_rate) and (."seedream-5.5" | image_rate))
  then .
  else error("Invalid PoYo pricing feed handoff")
  end
