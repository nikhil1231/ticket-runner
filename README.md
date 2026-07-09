# ticket-runner

Polls Notion ticket boards for coding tickets flagged **For AI**, and the Ticket
Incubator for feature briefs. It plans or implements one ticket at a time with
headless coding CLIs in isolated git worktrees. Notion owns ticket intent and the
project registry; ignored local state records exact Git commits and testing stack
heads.

Fallback policies are ordered provider/model candidates. Feature implementation
and incubation use Codex, then configured fallbacks. Review uses the review
policy while excluding the exact implementation model.

## Setup

1. Create a Notion internal integration with read, update, insert content, and
   comment capabilities. Connect it to the Project Registry, Ticket Incubator,
   and each project ticket board.
2. Copy `.env.example` to `.env` and set `NOTION_TOKEN`.
3. Install and log in to the Codex CLI. Install Antigravity (`agy`) if you want
   those fallback models.
4. Use Node 18 or newer.
5. Set `projectRegistry.databaseId` in `config.json` when the registry is ready.
   Legacy `boards` config is still supported as a fallback.
6. Run `npm run setup:notion` once. It idempotently adds shared ticket fields and
   incubator statuses.

## Usage

```sh
node runner.js                 # poll loop
node runner.js once            # single tick
node runner.js once --dry-run  # show what would be claimed, no writes
node runner.js stack [project] # read-only desired/deployed stack report
node runner.js reconcile [project] # rebuild cumulative testing stacks
node runner.js cleanup         # prune verified merged ticket branches
node runner.js healthcheck     # read-only config/Git/Notion readiness check
npm run setup:service          # install/reload guarded supervisor
```

## Workflow

1. Write a ticket on a project board and check **For AI**.
2. The runner claims it, creates `worktrees/<project>/<shortId>` on branch
   `ai/<shortId>`, runs that project's setup commands, and spawns the coding CLI.
3. On approval, the runner composes the project's cumulative Testing stack,
   validates it, and publishes only if that project has a publisher configured.
4. Move a Testing ticket to **Done** to authorize its validated merge and push to
   the project's configured main branch.

Query-only tickets are handled without an implementation worktree. Prefix the
title with `[Query]` or start the body with `Query:`. The runner appends an
**AI query answer** section and parks the ticket in **Needs info**.

## Ticket Incubator

Create incubator tickets with a title/body and select `Project` (relation to the
registry) or `Project key`. The runner inspects the selected project in a
detached worktree and appends an **AI implementation plan**. Moving the incubator
ticket to **Done** moves the same page to the target project board, sets
**For AI**, and queues it as **Not started**.

## Project Registry

The preferred coordination model is a Notion Project Registry database. Each
enabled row represents one coding project and should expose these properties:

- `Key` - stable lowercase key, for example `leetcode-senpai`.
- `Enabled` - checkbox; only checked rows are polled.
- `Ticket database ID` - Notion database ID for the implementation board.
- `Repo path` - absolute path or path relative to the runner checkout.
- `Base branch`, `Remote`, `Main branch`, `Scope`, `Workdir`.
- `Setup commands JSON` - JSON array of command arrays.
- `Validation commands JSON` - JSON array of command arrays.
- `Integration mode` - `testing-stack` or `disabled`.
- `Publisher` - `none` for validation-only projects, `eas-update` for Expo OTA.
- `EAS channel` - required only for `eas-update`.
- `Stack block patterns JSON` - optional file patterns that park a ticket in
  human review instead of admitting it to the cumulative stack.
- `Notes` - optional project-specific prompt context.

For `leetcode-senpai`, use `Publisher = none`, `Workdir = .`, and:

```json
[[".venv\\Scripts\\python.exe", "-m", "pytest"]]
```

A matching setup command JSON can be:

```json
[["py", "-3", "-m", "venv", ".venv"], [".venv\\Scripts\\python.exe", "-m", "pip", "install", "-r", "requirements.txt"]]
```

## Guard Rails

- Hard timeout per run.
- Max attempts per ticket, then Failed.
- One bounded rescue pass after normal model candidates fail.
- Infrastructure faults do not consume ticket attempts.
- Serial processing across all project boards.
- Feature branches are local-only and never pushed directly.
- Done promotion merges only that ticket in an isolated worktree, validates it,
  verifies the remote has not advanced, and pushes without force.
- Cleanup verifies the ticket commit is an ancestor of the configured main
  branch before removing metadata.

## Review And Testing Stack

- **APPROVE** rebuilds `integration/<project>` from the configured main branch
  plus every oldest-first Testing ticket and the new candidate.
- Validation must pass before the candidate moves to **Testing**.
- Publishing runs only for configured publishers. `Publisher = none` validates
  and records the stack without deploying anything.
- **REQUEST_CHANGES** stores review feedback and requeues the ticket.
- **Force deploy** means force-admit to the cumulative Testing stack. Validation
  cannot be bypassed; generic projects do not publish anything there.

Existing Expo projects can keep `eas-update` publishing. Generic projects such
as `leetcode-senpai` should start with `Publisher = none`; production deployment
remains manual in v1.

## Stack Recovery

- `node runner.js stack [project]` compares Notion's desired Testing tickets
  with the last successfully deployed local state without modifying either
  system.
- `node runner.js reconcile [project]` rebuilds from the configured main branch.
- Conflicting tickets are returned to In review and excluded; compatible tickets
  continue.
- Validation, fetch, or publish failure preserves the previous stack state and
  blocks new implementation work until reconciliation succeeds.

## Engines

- **codex** (`codex exec`): sandboxed by default; the runner commits changes.
- **antigravity** (`agy --print`): uses `.agent-task.md`; the runner owns commits.
- Prompts are never passed on the command line.
