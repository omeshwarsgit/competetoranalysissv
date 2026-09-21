---
name: sheets-secret-layout
description: The Apps Script shared secret is already confined to gitignored files -- do not "fix" it
metadata:
  type: project
---

The Google Sheets shared secret is handled correctly already:

- `apps-script/Code.gs` -- committed, contains only the `CHANGE_ME_TO_A_LONG_RANDOM_STRING` placeholder
- `config/Code.deploy.gs` -- the deployed copy **with the real secret**, in `.gitignore`
- `config/sheets.json` -- `webAppUrl` + `sharedSecret`, in `.gitignore`
- `config/google-service-account.json`, `data/sheets-sync-state.json` -- also gitignored

I flagged this as an exposure in an earlier session and was **wrong**; the retraction is recorded in
`CHANGELOG.md` (2026-08-10 14:05).

**Why:** recorded so a future session does not re-raise it and "fix" a non-problem, or worse, move
the secret somewhere less protected.

**How to apply:** check `.gitignore` before flagging any credential in this project. Note the repo
is not currently under git at all.
