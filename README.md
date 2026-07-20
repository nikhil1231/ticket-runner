# ticket-runner

Polls Notion ticket boards for coding tickets flagged **For AI**, GitHub issues
assigned to the runner bot, and the Ticket Incubator for feature briefs. It
plans or implements one ticket at a time with headless coding CLIs in isolated
git worktrees. Notion owns the project registry; ignored local state records
exact Git commits and testing stack heads.

Fallback policies are ordered provider/model candidates. Feature implementation
and incubation use Codex, then configured fallbacks. Review uses the review
policy while excluding the exact implementation model.

## Setup

1. Create a Notion internal integration with read, update, insert content, and
   comment capabilities. Connect it to the Project Registry, Ticket Incubator,
   and each project ticket board.
2. Copy `.env.example` to `.env` and set `NOTION_TOKEN`.
3. Install and log in to the Codex CLI. Install Antigravity (`agy`) and the
   Claude Code CLI (`claude`) if you want those fallback/planning models.
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
node runner.js dashboard [port] # read-only web dashboard (default :4600)
npm run setup:service          # install/reload the runner + dashboard target
```

The dashboard header shows its serving URL, process id, checkout path, and the
restart command for the current platform. The browser polls for dashboard code
fingerprint changes and reloads itself when a rebuilt or restarted dashboard is
available.

## Deployment

The runner is a self-managing host agent, not a stateless container: it drives
authenticated coding CLIs (`codex`, `agy`), operates on Git worktrees of the
target app repos, and self-updates its own checkout. It ships as **systemd user
units**, not Docker.

`npm run setup:service` installs three units into `~/.config/systemd/user/`:

- `ticket-runner.service` - the guarded, self-updating supervisor (`scripts/supervisor.js`).
- `ticket-runner-dashboard.service` - the read-only dashboard (`runner.js dashboard`).
- `ticket-runner.target` - groups both so they start/stop/restart together.

```sh
systemctl --user status  ticket-runner.target      # both units at a glance
systemctl --user restart ticket-runner.target      # restart loop + dashboard
journalctl --user -u ticket-runner-dashboard.service -f
```

Both processes share `state/runner.db` (the runner writes, the dashboard reads via
WAL), so they must run from the same checkout. The dashboard unit binds
`0.0.0.0:4600`; it has **no authentication**, so anyone who can reach the host on
that port sees ticket contents and repo paths. Set `DASHBOARD_HOST=127.0.0.1` in
the unit to restrict it to loopback (the code default when the env var is unset),
or `DASHBOARD_PORT` to move it. Edit `WorkingDirectory=` in the units if your
checkout lives outside `~/Documents/Programming/AI/ticket-runner`.

## Workflow

1. Write a ticket on a project board and queue it for the runner: check
   **For AI** on Notion boards, or assign the GitHub issue to the runner bot.
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
**For AI** on Notion-backed boards, and queues it as **Not started**.

## Flywheel

Turns a high-level mission statement into a self-sustaining backlog, so a
project can run with minimal human involvement beyond writing the mission and
approving epics.

1. Enable it per project with `flywheel.enabled: true` (see below).
2. Create one ticket labeled `mission` (GitHub) or with `Kind = mission`
   (Notion) on the project's board. Its body is the mission statement, in your
   own words - what the project should become. Edit it any time; the runner
   picks up changes on the next pass.
3. The runner decomposes the mission into **epics** (`kind = epic`), parked in
   **In review** for a one-time human approval. Move an epic to **Not started**
   to approve it, or **Cancelled** to reject it; rejected epics are never
   re-proposed. The runner promotes an approved epic to **In progress** as soon
   as it starts working it: a mission or epic being actively worked lives in
   **In progress**, not parked in Not started (which is only the queue the runner
   pulls unstarted tickets from).
4. Once an epic is in progress, the runner tops up the project's queued backlog
   from that epic whenever it drops below `backlogThreshold`, generating
   grounded, decision-complete feature tickets that flow through the normal
   implementation loop.
5. When the epic's scope is fully delivered — the planner reports there is
   nothing left to add, or every ticket has reached the Testing stack — the
   runner moves the **epic** to **Testing** and stops proposing tickets for it
   (so it never flip-flops between "done" and "here are three more"). Then:
   - Move the epic to **Done** to land *every* ticket under it on the project's
     main branch at once, squashed into a single commit for the epic (rather than
     carrying each ticket's individual commits over as-is).
   - Move the epic back to **In progress** to have the runner resume adding
     tickets to it.
   An epic whose tickets were all merged (or cancelled) individually closes to
   **Done** on its own, with nothing left to cascade.

### One-shot vs. continuous missions

By default a mission is **one-shot**: once every epic under it is done or
rejected, Flywheel idles and posts a nudge to edit the mission (or add an epic
by hand) to continue.

Set `flywheel.continuous: true` for an open-ended "keep improving this app"
mission that is never "done". In continuous mode, when every epic has settled
the runner automatically opens a fresh epic-proposal round, re-reading the
now-changed codebase to rank the next highest-leverage improvements. The
flywheel keeps spinning; your only steering inputs are approving/rejecting
epics (their board order is their priority), editing the mission, and the
per-ticket Done gate. For a continuous mission, a small `maxEpics` (2-3) keeps
each round a focused, re-ranked slate rather than a big up-front plan.

Flywheel is a per-project maintenance pass in the tick loop, not a claimed
ticket - a failing planner never blocks or crashes the loop, and never
consumes a ticket's attempt budget. Failures back off with an exponential
cooldown and post one comment on the mission per cooldown window.

Config (`config.json`, per project):

```json
{
  "projects": [{
    "key": "caligo",
    "flywheel": {
      "enabled": true,
      "continuous": false,
      "backlogThreshold": 2,
      "maxOpenTickets": 10,
      "maxEpics": 7,
      "maxTicketsPerPass": 3,
      "cooldownMs": 900000
    }
  }],
  "fallbackPolicies": {
    "planner": [{ "provider": "claude", "model": "claude-opus-4-8" }, { "provider": "codex", "model": "" }]
  }
}
```

- `continuous` - `false` (one-shot: idle when all epics finish) or `true`
  (indefinite: auto-open a new epic round when all epics settle).
- `backlogThreshold` - top up when queued feature tickets under the active
  epic drop below this.
- `maxOpenTickets` - hard cap on non-terminal feature tickets per project.
- `maxEpics` - cap on epics proposed per round (use 2-3 for continuous
  missions).
- `maxTicketsPerPass` - cap on tickets generated per planning pass.
- `cooldownMs` - base wait after a needs-info, all-duplicate, or failed pass;
  failures back off exponentially from here.

Planning runs are read-only: a detached worktree, no edits, no git, same
pattern as the Ticket Incubator. `fallbackPolicies.planner` defaults to
`claude` then `codex`.

## Archive clean-up

Every poll tick the runner archives tickets that have been closed for long
enough, so old cards stop piling up in the board's Done/Cancelled columns.
Archiving removes the card from the GitHub Project board via
`archiveProjectV2Item`; the underlying issue stays closed, just off the board.
Archived tickets are also hidden from the local dashboard.

- Only `done` and `cancelled` tickets are archived (`failed` stays visible for
  triage).
- A ticket qualifies once it has been closed for longer than `closedForMs`
  (default 24h).
- Currently GitHub Projects only; Notion-tracked projects are skipped.

Config (`config.json`, top-level for all projects or per-project override under
`projects[]`, same precedence as `flywheel`):

```json
{ "archive": { "enabled": true, "closedForMs": 86400000 } }
```

- `enabled` - defaults to `true`; set `false` to leave closed cards on the board.
- `closedForMs` - how long a ticket must have been closed before its card is
  archived.

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

## In-App Bug Reports

The runner can poll a Firestore collection for app-submitted bug reports and
turn each `status: "new"` document into a normal GitHub-backed ticket. Configure:

```json
{
  "bugReports": {
    "projectId": "firebase-project-id",
    "collection": "bug_reports"
  }
}
```

Each report should include `app` (or `projectKey`) matching a configured
project. The project must use a GitHub tracker so the runner can create a
visibility issue. The runner uses `firebase login:list` for local Firebase CLI
auth, so run `firebase login` on the host, and keep `GITHUB_TOKEN` configured.
Imported bugs are tagged `bug` and `from-app`, and they build from the current
cumulative integration stack because that is what the app user was running.
Firestore statuses flow `new -> claimed -> fixing -> fixed` and eventually
`shipped` or `blocked`; the runner also writes back `runnerTicketId`,
`githubIssueUrl`, and `updateRef` when available.

## Engines

- **codex** (`codex exec`): sandboxed by default; the runner commits changes.
- **antigravity** (`agy --print`): reads its task from `.agent-task.md`, with the
  worktree pinned as the workspace via `--add-dir` (agy 1.1.3+ ignores the bare
  CWD); the runner owns commits.
- **claude** (`claude -p`): headless Claude Code, primarily used for Flywheel
  planning. Install and log in to the `claude` CLI on the runner machine.
  Planning callers force `--permission-mode plan` and disallow file-editing
  tools; other callers default to `--permission-mode bypassPermissions` inside
  the sandboxed worktree. The runner owns commits, same as the other engines.
- Prompts are never passed on the command line.
