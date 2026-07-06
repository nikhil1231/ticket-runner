# ticket-runner

Polls the Caligo and WorkoutTracker Notion boards for tickets flagged **For AI**,
and the Ticket Incubator for feature briefs. It plans or implements one ticket at
a time with headless coding CLIs in isolated git worktrees. Notion is the only
state store.

Fallback policies are ordered provider/model candidates. Feature implementation
and incubation use Codex, then agy Claude, Pro, Flash and GPT-OSS. Review uses agy
Flash, Codex, Pro, Claude and GPT-OSS, excluding the exact implementation model.
Quota errors, timeouts, process failures and invalid structured output advance to
the next candidate. The resolver is stateless: each ticket starts at the top.

## Setup

1. **Notion token**: create an internal integration at
   <https://www.notion.so/my-integrations> (read + update + insert content
   capabilities, plus comment capabilities). Then connect it to both board
   pages (page `...` menu → Connections): the Caligo page and the Workout
   tracker page. Copy `.env.example` to `.env` and paste the token.
2. **codex**: install the Codex CLI and run `codex login` once.
3. **antigravity** (optional): install the Antigravity CLI (`agy`) and log in
   once (or set `ANTIGRAVITY_TOKEN`).
4. Node ≥ 18. No npm dependencies.
5. Run `npm run setup:notion` once. It idempotently adds the incubator fields and
   statuses plus `Last agent` on the app boards.

## Usage

```
node runner.js                 # poll loop (every 60s), one ticket at a time
node runner.js once            # single tick
node runner.js once --dry-run  # show what would be claimed, no writes
node runner.js push <shortId>  # manually publish a worktree to its EAS channel
node runner.js cleanup         # remove worktrees/branches of Done tickets
node runner.js healthcheck     # read-only config/Git/Notion readiness check
npm run setup:service          # install/reload the guarded systemd supervisor
```

## Workflow

1. Write a ticket on either board (title + body). Optionally set `CLI` to
   `antigravity`. Check **For AI**.
2. The runner claims it (`Status = In progress`, `Attempts + 1`), creates a
   worktree of calorieswipe on branch
   `ai/<shortId>` under `worktrees/`, runs `yarn install`, and spawns the CLI
   with the ticket as prompt.
3. Outcomes (always posted as a comment on the ticket):
   - **In review** — work committed on the branch; the `Branch` field is set.
     Review the diff in the worktree, merge it, set `Status = Done`, uncheck
     **For AI**. Run `node runner.js cleanup` occasionally to prune merged
     worktrees.
   - **Needs info** — the agent found the ticket too vague. Edit the ticket
     body, then move it to `Not started` to requeue.
   - **Failed** — after normal candidates and one bounded rescue pass fail, or
     when the self-healing circuit breaker parks an infrastructure fault. Full
     diagnostics remain under `runs/`.
4. To retry anything manually: move it to `Not started` (and reset `Attempts`
   if you want a full fresh set of retries).

## Ticket incubator

1. Create a ticket in **Ticket Incubator**, add a title/body, select `App`, and
   leave it in **Not started**.
2. The runner inspects the selected app in a disposable detached worktree and
   appends an **AI implementation plan**, then moves the ticket to **In review**.
3. To revise it, add top-level page comments and move it back to **Not started**.
   Only the managed plan section is replaced; the original brief is preserved.
4. To approve it, move it to **Done**. The runner moves the same Notion page to
   the selected app board, sets **For AI**, and queues it as **Not started** for
   implementation. The page body and comments move with it.

Missing briefs or `App` selections go to **Needs info**. Only open, top-level
human comments are used as revision feedback.

## Guard rails

- Hard wall-clock timeout per run (25 min default) with full process-tree kill.
- Max 2 attempts per ticket, then Failed.
- One rescue pass after the normal model chain is exhausted.
- Infrastructure faults do not consume ticket attempts. Transient Notion
  failures retry locally; unknown runner defects enter guarded self-healing.
- Serial: one ticket at a time across both boards (oldest first).
- App agents work in disposable worktrees; the target app's `main` is never
  touched and feature branches are not pushed. Guarded repairs may push this
  runner's `main` after validation.
- On startup, `For AI` tickets stuck in `In progress` (crashed runner) are requeued or
  failed.
- Between tickets, the runner fetches `origin/main`. A clean checkout is
  fast-forwarded and the systemd service restarts onto the new code. Dirty or
  diverged checkouts are logged and left untouched; update failures do not stop
  ticket polling.

## Self-healing

The runner fingerprints failures and separates app/task failures from defects in
the runner itself. Task failures get one final context-rich rescue pass in the
app worktree. For an unknown runner defect, Codex receives the stack trace and
logs in an isolated `self-heal/*` worktree and must add a regression test.

A runner repair deploys only when all tests and syntax checks pass, protected
controller/configuration paths are untouched, and `origin/main` still equals the
recorded base commit. It is pushed as one normal fast-forward commit; force-pushes
are never used. The supervisor starts the candidate and waits for a matching
healthy heartbeat. A failed startup is reverted automatically when remote state
is unchanged. If another commit advances main, rollback stops rather than
overwriting it.

Repair fingerprints, pending deployments, heartbeat data, and deployment history
live under ignored `state/`; prompts and validation logs live below the ticket's
`runs/<id>/repair/` directory. One repair is allowed per fingerprint per 24-hour
cooldown by default. The Notion ticket receives progress and circuit-breaker
comments and is requeued without consuming an attempt after a successful repair.

Guarded deployment is disabled unless `scripts/supervisor.js` is the active
service entrypoint. On the Linux host, run `npm run setup:service` once after this
upgrade; it installs the tracked unit, reloads systemd, and starts the service.

## Config

`config.json`: repo path, base branch, poll interval, automatic update remote,
run/install timeouts, max attempts, app/incubator database IDs, service-specific
`fallbackPolicies`, `selfHealing` limits/candidates/health timeout, and
per-provider command settings. Codex runs with
`--sandbox workspace-write`; if
that misbehaves on Windows, set `"sandbox": "danger-full-access"` in
`adapters.codex` (the worktree still contains the blast radius, but nothing
else does).

## Review loop

After a ticket is implemented, an AI reviewer judges the diff using the review
policy. The exact implementation provider/model is removed from that policy, so
review is never same-on-same.

- **APPROVE** → publish the branch to the board's EAS `testing` channel and move
  the ticket to **Testing** for you to verify on-device, then set Done.
- **REQUEST_CHANGES** → the notes go into `Review feedback`, the ticket returns to
  **Not started**, and the next run's prompt includes that feedback. Bounded by
  `review.maxRounds` (default 2); after that it parks in **In review** for a human.
  `Attempts` is reset on a change-request so it doesn't count as an implement failure.
- Per-ticket **`CLI`** and **`Model`** fields optionally prepend an implementation
  override. The actual successful candidate is written to **`Last agent`**, so
  the override remains valid on review-driven retries.

Disable review globally with `review.enabled: false` in config (ticket then lands
in **In review** as before).

Requires a **Testing** Status option on each board (add it in the Notion UI — the
API can't add status options), and `EXPO_TOKEN` in `.env` for headless EAS pushes.
Only boards with an `easChannel` in config get pushed; the target needs a one-time
`eas build --profile testing` installed on-device, and EAS Update only ships JS/asset
changes (native changes need a rebuild).

## Engines

- **codex** (`codex exec`): sandboxed (`workspace-write`); can't reach the
  worktree's `.git`, so it makes changes and the runner commits them. Prompt
  piped via stdin.
- **antigravity** (`agy --print`): unsandboxed but told not to run git (runner
  commits, same as codex). The prompt is dropped into the worktree as
  `.agent-task.md` (deleted before the commit) because agy operates on its CWD,
  not on a prompt-file path. Noticeably slower than codex; used mainly as the
  fallback. Candidate model names in `fallbackPolicies` must exactly match
  `agy models`.

## Notes

- Both engines are verified working end-to-end on this machine (codex on a real
  ticket; agy via the adapter against a scratch repo).
- Prompts are never passed on the command line (stdin for codex, in-worktree
  file for agy) to survive newlines/quotes on Windows.
