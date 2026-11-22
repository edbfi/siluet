# SPDX-License-Identifier: AGPL-3.0-or-later
# Check the projected v1 feed that older readers decode.

include "publish-validation";
include "providers/poyo/rates";

read_feed(4096)
| if type == "object" and keys == ["provider", "rates", "revision", "sourceDate", "version"]
    and .version == 1 and .provider == "poyo"
    and (.revision | type == "string" and test("\\A[a-f0-9]{40}\\z"))
    and (.sourceDate | timestamp)
    and (.rates | type == "object" and keys == ["seedream-5.5", "z-image"]
      and (."z-image" | fixed_rate) and (."seedream-5.5" | image_rate))
  then .
  else error("Invalid PoYo pricing feed handoff")
  end
