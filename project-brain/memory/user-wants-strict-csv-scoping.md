---
name: user-wants-strict-csv-scoping
description: User repeatedly required the sheet to govern both what is displayed and what data is stored
metadata:
  type: feedback
---

Across several messages on 2026-08-10 the user insisted, with increasing firmness, that
`properties.csv` govern the system completely:

1. "Only display the properties that have been added to the Excel/CSV file"
2. "should blank removed all the properties" -- an emptied sheet must empty the dropdown, not fall
   back to a default list
3. "dynamically use the `Property` column (Column B)" -- Column B is the label
4. "Keep data only for the properties currently listed... Remove all data, records, and references
   associated with properties that are not present in the sheet"

**Why:** the operator treats the sheet as the control surface for the whole tool. A dashboard that
quietly shows properties they removed -- or worse, retains their data -- makes the tool
untrustworthy. My first implementation failed open on an empty CSV, which was the wrong default and
had to be reversed (D-002).

**How to apply:** when scoping anything to the CSV in this project, default to **strict** -- the
sheet is exhaustive, and absence from it means removal, not "unknown". Only fall back to other
sources when the CSV genuinely cannot be read (server down, malformed), never when it is simply
empty. Related: [[csv-single-source-of-truth]].
