# Repository instructions

- **Before doing anything else**, check whether `AGENTS.local.md` exists next to this file, and if so, read it and follow it as machine-specific local instructions. It is intentionally untracked (gitignored), so it won't show up in `git status`/`git diff` — you have to check for the file directly. On a machine that already runs a live deployment (e.g. as a systemd service), it documents where the real checkout lives, that config.json/.env there hold real project config and tokens, and not to clone a second copy.
- Work directly on `main` for this repository unless the user explicitly asks for a branch.
- Do not create pull-request branches for routine ticket-runner changes.
- After committing, push directly to `origin/main`.
- If you find yourself on a `codex/*` or other feature branch, switch back to `main` before committing or pushing.
