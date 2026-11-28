# SPDX-License-Identifier: AGPL-3.0-or-later
# Order a v2 candidate after the published v2 feed, or after v1 before v2 exists.
# Prints "confirmation" when only the confirmation moves, else "update".

. as $candidate
| $previous[0] as $old
| ($old.confirmedAt // $old.sourceDate) as $old_confirmed
| if .confirmedAt < $old_confirmed then
    error("The PoYo candidate has an older confirmation than the published feed.")
  elif .revision == $old.revision then
    if .sourceDate != $old.sourceDate or $license != "same" then
      error("The same PoYo revision produced a different source date or license.")
    elif ($old.rates | keys) - ($candidate.rates | keys) != [] then
      error("The same PoYo revision removed a published rate.")
    elif any($old.rates | to_entries[];
        .value != {kind: "unavailable"} and .value != $candidate.rates[.key]) then
      error("The same PoYo revision changed an existing rate.")
    elif .rates == $old.rates then "confirmation"
    else "update"
    end
  elif .sourceDate <= $old.sourceDate then
    error("The pricing candidate does not have a newer source date.")
  else "update"
  end
