# SPDX-License-Identifier: AGPL-3.0-or-later

def read_feed($limit):
  if utf8bytelength <= $limit then fromjson
  else error("The pricing feed exceeds the size limit.") end;

# Shared with decimal.ts: at most 12 whole and 6 fractional digits.
def credit_decimal:
  type == "string" and test("\\A(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?\\z");

def positive_decimal:
  credit_decimal and test("[1-9]");

def timestamp:
  type == "string" and test("\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\\z")
  and (. as $stamp | try (fromdateiso8601 | todateiso8601 == $stamp) catch false);

# The PoYo price basis that pairs with the v2 feed: its revision, the SHA-256 of its canonical
# JSON without the trailing LF, and one SHA-256 per rate key.
def sha256_hex: type == "string" and test("\\A[a-f0-9]{64}\\z");

def basis:
  type == "object" and keys == ["digests", "feedSha256", "revision"]
  and (.revision | type == "string" and test("\\A[a-f0-9]{40}\\z"))
  and (.feedSha256 | sha256_hex)
  and (.digests | type == "object" and length <= 1000
    and all(to_entries[];
      (.key | test("\\A[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\\z")) and (.value | sha256_hex)));
