# SPDX-License-Identifier: AGPL-3.0-or-later

def read_feed:
  if utf8bytelength <= 4096 then fromjson
  else error("The pricing feed exceeds the size limit.") end;

def positive_decimal:
  type == "string" and test("[1-9]")
  and test("\\A(0|[1-9][0-9]{0,11})(\\.[0-9]{1,6})?\\z");

def timestamp:
  type == "string" and test("\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\\z")
  and (. as $stamp | try (fromdateiso8601 | todateiso8601 == $stamp) catch false);
