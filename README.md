# ticket-runner

Polls the Caligo and WorkoutTracker Notion boards for tickets flagged **For AI**,
claims one at a time, and completes it with a headless coding CLI (**codex** by
default, **antigravity** if the ticket's `CLI` field says so) in a fresh git
worktree of the calorieswipe monorepo. Notion is the only state store.

Every ticket optimistically starts at the top of the chain (codex first). If the
chosen engine fails or hits its usage quota, the runner falls back to the next
engine in `fallbackChain` (default `codex → antigravity`) within the same attempt
— so a codex quota wall doesn't waste a ticket attempt. There's no backoff state:
a quota rejection does no real work, so it's cheap to just try codex each time
and fall through when it's walled.

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

## Usage

```
node runner.js                 # poll loop (every 60s), one ticket at a time
node runner.js once            # single tick
node runner.js once --dry-run  # show what would be claimed, no writes
node runner.js push <shortId>  # manually publish a worktree to its EAS channel
node runner.js cleanup         # remove worktrees/branches of Done tickets
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
   - **Failed** — after 2 attempts (first failure auto-requeues). Log tail is
     in the comment, full logs under `runs/`. Move it to `Not started` to retry
     after fixing the cause.
4. To retry anything manually: move it to `Not started` (and reset `Attempts`
   if you want a full fresh set of retries).

## Guard rails

- Hard wall-clock timeout per run (25 min default) with full process-tree kill.
- Max 2 attempts per ticket, then Failed.
- Serial: one ticket at a time across both boards (oldest first).
- Agents work in a disposable worktree on their own branch; `main` is never
  touched. Nothing is pushed.
- On startup, `For AI` tickets stuck in `In progress` (crashed runner) are requeued or
  failed.

## Config

`config.json`: repo path, base branch, poll interval, run/install timeouts,
max attempts, the two boards (database IDs, app dir, commit scope), and
per-CLI command + extra args. Codex runs with `--sandbox workspace-write`; if
that misbehaves on Windows, set `"sandbox": "danger-full-access"` in
`adapters.codex` (the worktree still contains the blast radius, but nothing
else does).

## Review loop

After a ticket is implemented, an AI reviewer judges the diff (same codex↔agy
fallback chain as implementation, starting from a **different** model). Default
reviewer is agy `Gemini 3.5 Flash (Low)`; if the implementer already used that
exact engine+model, review falls back to `alt` (codex) so it's never same-on-same.

- **APPROVE** → publish the branch to the board's EAS `testing` channel and move
  the ticket to **Testing** for you to verify on-device, then set Done.
- **REQUEST_CHANGES** → the notes go into `Review feedback`, the ticket returns to
  **Not started**, and the next run's prompt includes that feedback. Bounded by
  `review.maxRounds` (default 2); after that it parks in **In review** for a human.
  `Attempts` is reset on a change-request so it doesn't count as an implement failure.
- A per-ticket **`Model`** field pins the implementer model (empty = engine default);
  the runner writes back the `engine / model` it actually used.

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
  fallback. Pick a model with `adapters.antigravity.model` in config (see
  `agy models`).

## Notes

- Both engines are verified working end-to-end on this machine (codex on a real
  ticket; agy via the adapter against a scratch repo).
- Prompts are never passed on the command line (stdin for codex, in-worktree
  file for agy) to survive newlines/quotes on Windows.
