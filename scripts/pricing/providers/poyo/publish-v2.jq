# SPDX-License-Identifier: AGPL-3.0-or-later
# Check the v2 handoff against the rate grammar that every reader decodes.

include "publish-validation";
include "providers/poyo/rates";

def rate_key: type == "string" and test("\\A[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\\z");

# Unfamiliar kinds keep plain objects and decimal strings, at most four objects deep.
def unfamiliar_fields($depth):
  $depth <= 4 and type == "object"
  and all(to_entries[]; (.key | rate_key)
    and (.value | credit_decimal or unfamiliar_fields($depth + 1)));

def poyo_rate:
  type == "object" and (.kind | type == "string") and
  if .kind == "unavailable" or .kind == "per-request" or .kind == "per-image-with-references"
  then fixed_rate or image_rate
  else (.kind | test("\\A[a-z][a-z0-9-]{0,63}\\z")) and (del(.kind) | unfamiliar_fields(1))
  end;

read_feed(65536)
| if type == "object"
    and keys == ["confirmedAt", "provider", "rates", "revision", "sourceDate", "version"]
    and .version == 2 and .provider == "poyo"
    and (.revision | type == "string" and test("\\A[a-f0-9]{40}\\z"))
    and (.sourceDate | timestamp) and (.confirmedAt | timestamp)
    and .confirmedAt >= .sourceDate
    and (.rates | type == "object" and length <= 1000
      and has("z-image") and has("seedream-5.5")
      and all(to_entries[]; (.key | rate_key) and (.value | poyo_rate)))
  then .
  else error("Invalid PoYo v2 pricing feed handoff")
  end
