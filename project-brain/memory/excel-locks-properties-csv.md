---
name: excel-locks-properties-csv
description: Node writes to properties.csv fail with EBUSY while the sheet is open in Excel
metadata:
  type: project
---

While `properties.csv` is open in Excel, Windows holds an exclusive lock and any write from Node
fails with `EBUSY` / `Device or resource busy`. This bit during testing: a shell redirect
(`printf ... > properties.csv`) failed mid-`&&`-chain, and only an md5 comparison against a backup
confirmed the file was actually untouched.

**Why:** the operator edits this file in Excel, so it is *usually* open during a working session --
exactly when a script is most likely to want to write it.

**How to apply:** treat writes to `properties.csv` as fallible. Wrap them in try/catch, report the
`EBUSY` clearly with "close Excel and re-run" rather than failing silently, and verify with a
checksum instead of assuming success. `resolve-property-coords.js --write-csv` does this. Reads are
unaffected, which is why `GET /api/csv-properties` is safe to poll while the sheet is open.
