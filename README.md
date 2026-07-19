# ticket-runner

Polls tracked coding tickets assigned to the runner bot, plans or implements one
ticket at a time with headless coding CLIs, and keeps work isolated in git
worktrees. Local SQLite state records the canonical ticket queue, runner
metadata, worktree state, comments, and testing-stack heads.

Fallback policies are ordered provider/model candidates. Feature implementation
and incubation use Codex, then configured fallbacks. Review uses the review
policy while excluding the exact implementation model.

## Setup

1. Configure one or more projects in `config.json` under `projects`.
2. Configure each project with a `tracker` block. The built-in tracker is
   `github`.
3. Set `GITHUB_TOKEN` in `.env` when using GitHub-backed projects.
4. Install and log in to the Codex CLI. Install Antigravity (`agy`) and the
   Claude Code CLI (`claude`) if you want those fallback/planning models.
5. Use Node 22.5 or newer.

## Usage

```sh
node runner.js                 # poll loop
node runner.js once            # single tick
node runner.js once --dry-run  # show what would be claimed, no writes
node runner.js stack [project] # read-only desired/deployed stack report
node runner.js reconcile [project] # rebuild cumulative testing stacks
node runner.js cleanup         # prune verified merged ticket branches
node runner.js healthcheck     # read-only config/Git/tracker readiness check
node runner.js dashboard [port] # read-only web dashboard (default :4600)
npm run setup:service          # install/reload the runner + dashboard target
```

The dashboard header shows its serving URL, process id, checkout path, and the
restart command for the current platform. The browser polls for dashboard code
fingerprint changes and reloads itself when a rebuilt or restarted dashboard is
available.

## Deployment

The runner is a self-managing host agent, not a stateless container: it drives
authenticated coding CLIs (`codex`, `agy`), operates on Git worktrees of target
app repos, and self-updates its own checkout. It ships as systemd user units,
not Docker.

`npm run setup:service` installs three units into `~/.config/systemd/user/`:

- `ticket-runner.service` - the guarded, self-updating supervisor.
- `ticket-runner-dashboard.service` - the read-only dashboard.
- `ticket-runner.target` - groups both so they start/stop/restart together.

Both processes share `state/runner.db` so they must run from the same checkout.
The dashboard has no authentication. Keep it bound to loopback unless the local
network is trusted.

## Workflow

1. Queue a ticket by assigning the configured GitHub issue to the runner bot.
2. The runner claims it, creates `worktrees/<project>/<shortId>` on branch
   `ai/<shortId>`, runs that project's setup commands, and spawns the coding CLI.
3. On approval, the runner composes the project's cumulative Testing stack,
   validates it, and publishes only if that project has a publisher configured.
4. Move a Testing ticket to `Done` to authorize its validated merge and push to
   the project's configured main branch.

Query-only tickets are handled without an implementation worktree. Prefix the
title with `[Query]` or start the body with `Query:`. The runner appends an
`AI query answer` section and parks the ticket in `Needs info`.

## Config

Projects are configured locally:

```json
{
  "projects": [{
    "key": "example",
    "repoPath": "../example",
    "baseBranch": "main",
    "mainBranch": "main",
    "workdir": ".",
    "tracker": {
      "type": "github",
      "owner": "owner",
      "repo": "repo",
      "projectId": "PVT_...",
      "statusFieldId": "PVTSSF_...",
      "statusOptions": {
        "queued": "option-id"
      }
    },
    "validationCommands": [["npm", "test"]]
  }]
}
```

## Flywheel

Flywheel turns a high-level mission into an ongoing backlog. Enable it per
project with `flywheel.enabled: true`. Create one ticket labeled `mission`; its
body is the mission statement. The runner proposes epics, waits for human
approval, and then generates grounded feature tickets under approved epics.

## Archive Clean-Up

Every poll tick the runner archives tickets that have been closed for long
enough, so old cards stop piling up in `Done` and `Cancelled`.

Config:

```json
{ "archive": { "enabled": true, "closedForMs": 86400000 } }
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

- `node runner.js stack [project]` compares the GitHub Project's desired Testing
  tickets with the last successfully deployed local state without modifying
  either system.
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
