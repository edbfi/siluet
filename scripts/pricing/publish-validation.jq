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
