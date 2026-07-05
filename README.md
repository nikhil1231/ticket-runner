# ticket-runner

Polls the Caligo and WorkoutTracker Notion boards for tickets flagged **For AI**,
claims one at a time, and completes it with a headless coding CLI (**codex** by
default, **antigravity** if the ticket's `CLI` field says so) in a fresh git
worktree of the calorieswipe monorepo. Notion is the only state store.

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
node runner.js cleanup         # remove worktrees/branches of Done tickets
```

## Workflow

1. Write a ticket on either board (title + body). Optionally set `CLI` to
   `antigravity`. Check **For AI**.
2. The runner claims it (`AI Status = Running`, `Status = In progress`,
   `Attempts + 1`), creates a worktree of calorieswipe on branch
   `ai/<shortId>` under `worktrees/`, runs `yarn install`, and spawns the CLI
   with the ticket as prompt.
3. Outcomes (always posted as a comment on the ticket):
   - **In Review** — work committed on the branch; the `Branch` field is set.
     Review the diff in the worktree, merge it, set `Status = Done`, uncheck
     **For AI**. Run `node runner.js cleanup` occasionally to prune merged
     worktrees.
   - **Needs Info** — the agent found the ticket too vague. Edit the ticket
     body, then clear `AI Status` to requeue.
   - **Failed** — after 2 attempts (first failure auto-requeues). Log tail is
     in the comment, full logs under `runs/`. Clear `AI Status` to retry after
     fixing the cause.
4. To retry anything manually: clear the `AI Status` field (and reset
   `Attempts` if you want a full fresh set of retries).

## Guard rails

- Hard wall-clock timeout per run (25 min default) with full process-tree kill.
- Max 2 attempts per ticket, then Failed.
- Serial: one ticket at a time across both boards (oldest first).
- Agents work in a disposable worktree on their own branch; `main` is never
  touched. Nothing is pushed.
- On startup, tickets stuck in `Running` (crashed runner) are requeued or
  failed.

## Config

`config.json`: repo path, base branch, poll interval, run/install timeouts,
max attempts, the two boards (database IDs, app dir, commit scope), and
per-CLI command + extra args. Codex runs with `--sandbox workspace-write`; if
that misbehaves on Windows, set `"sandbox": "danger-full-access"` in
`adapters.codex` (the worktree still contains the blast radius, but nothing
else does).

## Notes

- The antigravity path is wired but untested until `agy` is installed and
  authenticated on this machine.
- Prompts are never passed on the command line (stdin for codex, prompt file
  for agy) to survive newlines/quotes on Windows.
