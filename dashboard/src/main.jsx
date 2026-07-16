import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleHelp, LayoutDashboard, OctagonAlert, RefreshCw, ScrollText, X } from 'lucide-react';
import './styles.css';

const STATUS_COLOR = {
  queued: 'var(--muted)',
  in_progress: 'var(--c1)',
  needs_info: 'var(--warning)',
  in_review: 'var(--c5)',
  testing: 'var(--c3)',
  done: 'var(--good)',
  failed: 'var(--critical)',
  cancelled: 'var(--muted)',
};

const STATUS_LABEL = {
  queued: 'Queued',
  in_progress: 'In progress',
  needs_info: 'Needs info',
  in_review: 'In review',
  testing: 'Testing',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function ago(iso) {
  if (!iso) return '-';
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return '-';
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function fmtInt(value) {
  const n = Number(value) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function fmtUsd(value) {
  const n = Number(value) || 0;
  if (!n) return '$0';
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.1 ? 2 : 3)}`;
}

function Dot({ color }) {
  return <span className="dot" style={{ background: color }} />;
}

function Tile({ value, label, color }) {
  return (
    <div className="tile">
      <div className="val" style={color ? { color } : null}>{value}</div>
      <div className="lab">{label}</div>
    </div>
  );
}

function StatusTag({ status }) {
  if (!status) return <span className="muted">-</span>;
  return (
    <span className="tag">
      <Dot color={STATUS_COLOR[status] || 'var(--muted)'} />
      {STATUS_LABEL[status] || status}
    </span>
  );
}

// Categorical identity color for a project, from the fixed 8-hue palette
// defined in styles.css (--c1..--c8 + matching --cN-ink foreground). Slots are
// assigned by sorted position in the configured project list — stable and
// collision-free for the realistic case of <= 8 projects — with a hash
// fallback for any project key outside that list, so nothing is ever
// unstyled and no per-project color list needs maintaining.
const PROJECT_HUES = 8;

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function buildProjectPalette(projects = []) {
  const keys = [...new Set(projects.map((p) => p.key).filter(Boolean))].sort();
  const map = new Map();
  keys.forEach((key, index) => map.set(key, (index % PROJECT_HUES) + 1));
  return map;
}

const ProjectPaletteContext = createContext(new Map());

function ProjectTag({ project }) {
  const palette = useContext(ProjectPaletteContext);
  if (!project) return null;
  const slot = palette.get(project) || (hashString(project) % PROJECT_HUES) + 1;
  return (
    <span className="project-pill" style={{ '--proj-bg': `var(--c${slot})`, '--proj-ink': `var(--c${slot}-ink)` }}>
      {project}
    </span>
  );
}

function TicketLink({ item, onOpen }) {
  const title = item?.title || '(untitled)';
  if (!item?.shortId) return title;
  return (
    <>
      <button className="linkbtn ticket-link" type="button" onClick={() => onOpen(item.shortId)}>{title}</button>{' '}
      <span className="mono">{item.shortId}</span>
    </>
  );
}

function StatusBar({ counts = {}, statuses = [] }) {
  const total = statuses.reduce((sum, status) => sum + (counts[status] || 0), 0);
  if (!total) return <div className="muted inline-empty">No tickets yet</div>;
  const active = statuses.filter((status) => counts[status]);
  return (
    <>
      <div className="bar">
        {active.map((status) => (
          <span
            key={status}
            style={{ width: `${(100 * counts[status]) / total}%`, background: STATUS_COLOR[status] }}
            title={`${STATUS_LABEL[status]}: ${counts[status]}`}
          />
        ))}
      </div>
      <div className="seg-legend">
        {active.map((status) => (
          <span key={status}>
            <Dot color={STATUS_COLOR[status]} />
            {STATUS_LABEL[status]} <b>{counts[status]}</b>
          </span>
        ))}
      </div>
    </>
  );
}

function Chips({ items }) {
  if (!items?.length) return <span className="muted">-</span>;
  return (
    <div className="chips">
      {items.map((item) => <span className="chip" key={item}>{item}</span>)}
    </div>
  );
}

function Field({ label, children }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className="field">
      <div className="lab">{label}</div>
      <div className="value">{empty ? <span className="muted">-</span> : children}</div>
    </div>
  );
}

function Empty({ children, error = false }) {
  return <div className={`empty${error ? ' err' : ''}`}>{children}</div>;
}

function ProviderCards({ providers = [] }) {
  return (
    <div className="grid cards">
      {providers.map((provider) => {
        const phases = Object.entries(provider.phases || {});
        return (
          <div className="card" key={provider.name}>
            <h3>
              {provider.name}
              <span className="tag">
                <Dot color={provider.installed ? 'var(--good)' : 'var(--critical)'} />
                {provider.installed ? 'installed' : 'CLI missing'}
              </span>
            </h3>
            <div className="k mono">{provider.cmd}</div>
            <div className="provider-metrics">
              <div>
                <div className="val small-val">{provider.usageRecent}</div>
                <div className="lab">runs - 24h</div>
              </div>
              <div>
                <div className="val small-val">{provider.usageTotal}</div>
                <div className="lab">runs - total</div>
              </div>
            </div>
            {(provider.tokens || provider.costUsd) ? (
              <div className="k spaced">{fmtInt(provider.tokens)} tokens{provider.costUsd ? ` - ${fmtUsd(provider.costUsd)} reported` : ''}</div>
            ) : null}
            <div className="k spaced">Models</div>
            <Chips items={provider.models?.length ? provider.models : null} />
            <div className="k spaced">Failover priority</div>
            <div className="chips">
              {phases.length ? phases.map(([phase, priority]) => (
                <span className="chip" title={`priority ${priority} in ${phase} chain`} key={phase}>{phase} #{priority}</span>
              )) : <span className="muted">not in any policy</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TokenUsage({ tokens, onOpen }) {
  if (!tokens?.available || !tokens.totals?.runs) return null;
  const phases = ['implementation', 'review', 'planning', 'query', 'other'];
  const labels = { implementation: 'Implementation', review: 'Review', planning: 'Planning', query: 'Query', other: 'Other' };
  const colors = { implementation: 'var(--c1)', review: 'var(--c5)', planning: 'var(--c3)', query: 'var(--c2)', other: 'var(--muted)' };
  const total = phases.reduce((sum, phase) => sum + ((tokens.byPhase?.[phase] || {}).tokens || 0), 0);
  const implementation = tokens.byPhase?.implementation?.tokens || 0;
  const logistics = (tokens.byPhase?.review?.tokens || 0) + (tokens.byPhase?.planning?.tokens || 0);

  return (
    <>
      <h2>Token usage</h2>
      <div className="grid tiles">
        <Tile value={fmtInt(tokens.totals.tokens)} label="Tokens total" />
        <Tile value={fmtInt(tokens.recent.tokens)} label="Tokens - 24h" />
        {tokens.costTracked ? <Tile value={fmtUsd(tokens.totals.costUsd)} label="Reported cost" /> : null}
        <Tile value={tokens.totals.runs} label="Engine runs" />
      </div>
      {total ? (
        <div className="tblwrap padded top-gap">
          <div className="k">By phase - implementation is the work you would run by hand; review + planning is the Flywheel logistics overhead</div>
          <div className="bar tall">
            {phases.filter((phase) => tokens.byPhase?.[phase]?.tokens).map((phase) => (
              <span
                key={phase}
                style={{ width: `${(100 * tokens.byPhase[phase].tokens) / total}%`, background: colors[phase] }}
                title={`${labels[phase]}: ${fmtInt(tokens.byPhase[phase].tokens)}`}
              />
            ))}
          </div>
          <div className="seg-legend">
            {phases.filter((phase) => tokens.byPhase?.[phase]?.tokens).map((phase) => (
              <span key={phase}>
                <Dot color={colors[phase]} />
                {labels[phase]} <b>{fmtInt(tokens.byPhase[phase].tokens)}</b>{' '}
                <span className="muted">({Math.round((100 * tokens.byPhase[phase].tokens) / total)}%)</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {implementation + logistics ? (
        <div className="note">
          Logistics (review + planning) is <b>{fmtInt(logistics)}</b> tokens - <b>{Math.round((100 * logistics) / (implementation + logistics))}%</b> of implementation + logistics.
          {tokens.costTracked ? ' Reported cost is claude runs only (codex reports tokens but no price; antigravity reports neither).' : ''}
        </div>
      ) : null}
      {tokens.perTicket?.length ? (
        <div className="tblwrap top-gap">
          <table>
            <thead>
              <tr><th>Costliest tickets</th><th>Tokens</th>{tokens.costTracked ? <th>Cost</th> : null}<th>Runs</th></tr>
            </thead>
            <tbody>
              {tokens.perTicket.slice(0, 12).map((row) => (
                <tr key={row.shortId}>
                  <td><button className="linkbtn ticket-link mono" type="button" onClick={() => onOpen(row.shortId)}>{row.shortId}</button></td>
                  <td className="num">{fmtInt(row.tokens)}</td>
                  {tokens.costTracked ? <td className="num">{row.costUsd ? fmtUsd(row.costUsd) : '-'}</td> : null}
                  <td className="num">{row.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function Projects({ data, onOpen }) {
  const store = data.store || {};
  return (
    <>
      <h2>Projects</h2>
      {data.registryOnly ? (
        <div className="note">Projects are defined in a Notion project registry, which the dashboard cannot read offline. Add a local <span className="mono">projects</span> array to config.json to list them here.</div>
      ) : null}
      {!data.projects?.length && !data.registryOnly ? <Empty>No projects configured.</Empty> : null}
      {data.projects?.length ? (
        <div className="grid cards project-cards">
          {data.projects.map((project) => {
            const counts = store.projectStatus?.[project.key] || {};
            const stack = (store.stacks || []).find((item) => item.project === project.key);
            const recent = (store.completed || []).filter((item) => item.project === project.key).slice(0, 4);
            return (
              <div className="card" key={project.key}>
                <h3><ProjectTag project={project.key} /><span className="tag">{project.trackerType}</span></h3>
                <div className="k mono">{project.repoPath}</div>
                <div className="rowline spaced">
                  <span className="chip">publish: {project.publisherType}{project.easChannel ? ` (${project.easChannel})` : ''}</span>
                  <span className="chip">{project.integrationMode}{project.integrationEnabled ? '' : ' - off'}</span>
                  {stack ? (
                    <span className="tag" title="testing stack">
                      <Dot color={stack.status === 'deployed' ? 'var(--good)' : stack.status === 'blocked' ? 'var(--critical)' : 'var(--muted)'} />
                      stack: {stack.status}
                    </span>
                  ) : null}
                </div>
                <StatusBar counts={counts} statuses={data.statuses} />
                <div className="k spaced">Recent completed</div>
                {recent.length ? (
                  <div className="recent-list">
                    {recent.map((item) => (
                      <div className="rowline recent-row" key={item.shortId}>
                        <span><TicketLink item={item} onOpen={onOpen} /></span>
                        <span className="muted nowrap">{ago(item.at)}</span>
                      </div>
                    ))}
                  </div>
                ) : <div className="muted tiny-gap">Nothing completed yet</div>}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

function Connections({ connections = [] }) {
  return (
    <div className="chips top-gap">
      {connections.map((connection) => {
        const color = connection.configured ? 'var(--good)' : connection.required ? 'var(--critical)' : 'var(--muted)';
        const label = connection.configured ? 'connected' : connection.required ? 'token missing' : 'not used';
        return (
          <span className="tag" key={connection.id}>
            <Dot color={color} />
            {connection.label} - {label}
          </span>
        );
      })}
    </div>
  );
}

// Reused wherever a ticket participates in a dependency stall: role="blocker"
// is the ticket a human must act on, role="blocked" a ticket waiting behind it.
function BlockageTag({ role }) {
  return <span className={`tag ${role === 'blocker' ? 'blocker-tag' : 'blocked-tag'}`}>{role}</span>;
}

// The human-readable reason a ticket is stuck: the runner always posts the
// park reason as a tracker comment, so the newest outbox comment is the
// latest comment on the issue; review feedback is the fallback.
function IssueText({ item }) {
  const text = item.lastComment || item.note;
  if (!text) return null;
  return <div className="issue-text">{text}</div>;
}

// Tickets parked in needs_info: the runner never retries these on its own, so
// they sit alongside dependency blockages at the top. Tickets already shown
// as blockers are skipped — they have a stronger card there already.
function NeedsInfoPanel({ items = [], blockerIds, onOpen }) {
  const list = items.filter((item) => !blockerIds?.has(item.shortId));
  if (!list.length) return null;
  return (
    <>
      <h2 className="needsinfo-h">Needs info</h2>
      <div className="needsinfo-panel">
        <div className="blockage-summary">
          <CircleHelp size={16} className="needsinfo-icon" />
          <span>
            <b>{list.length}</b> ticket{list.length === 1 ? ' is' : 's are'} parked until a human answers or acts — the runner will not retry {list.length === 1 ? 'it' : 'them'} on its own.
          </span>
        </div>
        <div className="needsinfo-list">
          {list.map((item) => (
            <div className="blockage-row needsinfo" key={item.shortId}>
              <div className="rowline">
                <span className="tag needsinfo-tag">needs info</span>
                <TicketLink item={item} onOpen={onOpen} />
              </div>
              <div className="state-meta">
                <ProjectTag project={item.project} />
                <span className="muted">{item.attempts} attempt{item.attempts === 1 ? '' : 's'}</span>
                {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">tracker</a> : null}
                <span className="muted nowrap">{ago(item.at)}</span>
              </div>
              <IssueText item={item} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Queued tickets the runner is silently skipping because a dependency chain
// bottoms out at a ticket that needs a human. Rendered above everything else;
// renders nothing when the pipeline is flowing.
function Blockages({ blockages, onOpen }) {
  const blocked = blockages?.blocked || [];
  const blockers = blockages?.blockers || [];
  if (!blocked.length || !blockers.length) return null;
  return (
    <>
      <h2 className="blockage-h">Blockage</h2>
      <div className="blockage-panel">
        <div className="blockage-summary">
          <OctagonAlert size={16} className="blockage-icon" />
          <span>
            <b>{blocked.length}</b> queued ticket{blocked.length === 1 ? ' is' : 's are'} stuck behind{' '}
            <b>{blockers.length}</b> ticket{blockers.length === 1 ? '' : 's'} waiting on a human — the runner will not pick {blocked.length === 1 ? 'it' : 'them'} up until the blocker{blockers.length === 1 ? ' is' : 's are'} resolved.
          </span>
        </div>
        <div className="blockage-cols">
          <div>
            <div className="blockage-col-title">Blockers — need human action</div>
            {blockers.map((item) => (
              <div className="blockage-row blocker" key={item.shortId}>
                <div className="rowline">
                  <BlockageTag role="blocker" />
                  <TicketLink item={item} onOpen={onOpen} />
                </div>
                <div className="state-meta">
                  <ProjectTag project={item.project} />
                  <StatusTag status={item.status} />
                  <span className="chip warn">blocks {item.blocks.length}</span>
                  {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer">tracker</a> : null}
                  <span className="muted nowrap">{ago(item.at)}</span>
                </div>
                <IssueText item={item} />
              </div>
            ))}
          </div>
          <div>
            <div className="blockage-col-title">Blocked — waiting in queue</div>
            {blocked.map((item) => (
              <div className="blockage-row blocked" key={item.shortId}>
                <div className="rowline">
                  <BlockageTag role="blocked" />
                  <TicketLink item={item} onOpen={onOpen} />
                </div>
                <div className="state-meta">
                  <ProjectTag project={item.project} />
                  <StatusTag status={item.status} />
                  <span className="muted">waiting on</span>
                  {item.blockedBy.map((shortId) => (
                    <button className="linkbtn mono" type="button" key={shortId} onClick={() => onOpen(shortId)}>{shortId}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function MiniTicketList({ items = [], onOpen, empty }) {
  if (!items.length) return <div className="muted tiny-gap">{empty}</div>;
  return (
    <div className="state-list">
      {items.map((item) => (
        <div className="state-row" key={item.shortId}>
          <div className="state-main">
            <TicketLink item={item} onOpen={onOpen} />
            <div className="state-meta">
              <ProjectTag project={item.project} />
              <StatusTag status={item.status} />
              {item.blocked ? <BlockageTag role="blocked" /> : null}
              {item.agent ? <span className="mono">{item.agent}</span> : null}
            </div>
          </div>
          <span className="muted nowrap">{ago(item.at)}</span>
        </div>
      ))}
    </div>
  );
}

function LogBox({ title, lines = [] }) {
  if (!lines.length) return null;
  return (
    <div className="task-log-block">
      <div className="task-log-title">{title}</div>
      <pre className="task-logs">{lines.join('\n')}</pre>
    </div>
  );
}

function RunningTaskLog({ task }) {
  const [state, setState] = useState({ loading: false, data: null, error: '' });

  const loadTaskLogs = useCallback(async () => {
    if (!task?.shortId) return;
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch(`/api/task-logs/${encodeURIComponent(task.shortId)}?lines=300`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'task log load failed');
      setState({ loading: false, data: body, error: '' });
    } catch (taskLogError) {
      setState((current) => ({ loading: false, data: current.data, error: taskLogError.message }));
    }
  }, [task?.shortId]);

  useEffect(() => {
    loadTaskLogs();
    const timer = setInterval(loadTaskLogs, 4000);
    return () => clearInterval(timer);
  }, [loadTaskLogs]);

  const invocations = state.data?.invocations || [];
  const hasLines = invocations.some((inv) => inv.stderrLines?.length || inv.stdoutLines?.length);

  return (
    <div className="task-log-panel">
      <div className="task-log-head">
        <span className="mono">{state.data?.run?.name || 'no run directory yet'}</span>
        <span className="sub">{state.loading ? 'Loading...' : state.data?.generatedAt ? `Updated ${ago(state.data.generatedAt)}` : ''}</span>
      </div>
      {state.error ? <div className="note err">{state.error}</div> : null}
      {!state.loading && !state.data?.run ? <Empty>No run logs found for this task yet.</Empty> : null}
      {state.data?.run && !hasLines ? <Empty>No CLI output has been written yet.</Empty> : null}
      {invocations.map((invocation) => (
        <div className="task-invocation" key={invocation.tag}>
          <div className="rowline task-invocation-head">
            <span className="chip">{invocation.tag}</span>
            {invocation.updatedAt ? <span className="muted nowrap">{ago(invocation.updatedAt)}</span> : null}
          </div>
          <LogBox title="stderr" lines={invocation.stderrLines} />
          <LogBox title="stdout" lines={invocation.stdoutLines} />
        </div>
      ))}
    </div>
  );
}

function InFlightPanel({ items = [], onOpen }) {
  const [activeShortId, setActiveShortId] = useState(items[0]?.shortId || '');

  useEffect(() => {
    if (!items.length) {
      setActiveShortId('');
      return;
    }
    if (!items.some((item) => item.shortId === activeShortId)) {
      setActiveShortId(items[0].shortId);
    }
  }, [activeShortId, items]);

  const active = items.find((item) => item.shortId === activeShortId) || items[0] || null;

  return (
    <section className="card state-card active-work">
      <h3><span>In flight</span><span className="tag">{items.length} running</span></h3>
      {!items.length ? <Empty>No tickets are currently running.</Empty> : (
        <>
          <div className="task-tabs" role="tablist" aria-label="Running tasks">
            {items.map((item) => (
              <button
                className={`task-tab${item.shortId === active?.shortId ? ' active' : ''}`}
                key={item.shortId}
                type="button"
                role="tab"
                aria-selected={item.shortId === active?.shortId}
                onClick={() => setActiveShortId(item.shortId)}
              >
                <span>{item.title || '(untitled)'}</span>
                <span className="mono">{item.shortId}</span>
              </button>
            ))}
          </div>
          {active ? (
            <>
              <div className="active-task-meta">
                <TicketLink item={active} onOpen={onOpen} />
                <ProjectTag project={active.project} />
                <StatusTag status={active.status} />
                {active.agent ? <span className="mono">{active.agent}</span> : null}
                <span className="muted nowrap">{ago(active.at)}</span>
              </div>
              <RunningTaskLog task={active} />
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function CurrentState({ data, onOpen }) {
  const store = data.store || {};
  const current = store.current || {};
  const byStatus = store.byStatus || {};
  const stackSummary = current.stackSummary || {};
  const syncColor = store.totals?.outboxParked ? 'var(--warning)' : store.totals?.outboxPending ? 'var(--c3)' : 'var(--good)';
  const running = current.running || current.inFlight || [];
  const testing = current.testing || [];

  return (
    <>
      <h2>Current state</h2>
      <div className="state-grid">
        <InFlightPanel items={running} onOpen={onOpen} />
        <section className="card state-card">
          <h3><span>Testing</span><span className="tag">{testing.length} testing</span></h3>
          <MiniTicketList items={testing} onOpen={onOpen} empty="No tickets are currently in testing." />
        </section>
        <section className="card state-card">
          <h3><span>Up next</span><span className="tag">{byStatus.queued || 0} queued</span></h3>
          <MiniTicketList items={current.queued?.slice(0, 5)} onOpen={onOpen} empty="Queue is empty." />
        </section>
        <section className="card state-card">
          <h3><span>Just finished</span><span className="tag">{byStatus.done || 0} done</span></h3>
          <MiniTicketList items={current.recentlyCompleted?.slice(0, 5)} onOpen={onOpen} empty="Nothing completed yet." />
        </section>
        <section className="card state-card">
          <h3><span>Project flow</span></h3>
          {!current.projectFlow?.length ? <div className="muted tiny-gap">No active project pressure.</div> : (
            <div className="flow-list">
              {current.projectFlow.map((project) => (
                <div className="flow-row" key={project.project}>
                  <ProjectTag project={project.project} />
                  <span className="chip">{project.moving} moving</span>
                  <span className="chip">{project.queued} queued</span>
                  {project.blocked ? <span className="chip warn">{project.blocked} blocked</span> : null}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card state-card">
          <h3><span>Signals</span></h3>
          <div className="signal-grid">
            <div>
              <div className="val small-val" style={{ color: (byStatus.failed || byStatus.needs_info) ? 'var(--critical)' : 'var(--good)' }}>
                {(byStatus.failed || 0) + (byStatus.needs_info || 0)}
              </div>
              <div className="lab">blocked or needs info</div>
            </div>
            <div>
              <div className="val small-val" style={{ color: syncColor }}>{store.totals?.outboxPending || 0}</div>
              <div className="lab">sync ops pending</div>
            </div>
            <div>
              <div className="val small-val" style={{ color: stackSummary.blocked ? 'var(--critical)' : 'var(--good)' }}>{stackSummary.deployed || 0}</div>
              <div className="lab">stacks deployed</div>
            </div>
            <div>
              <div className="val small-val">{current.reviewing?.length || 0}</div>
              <div className="lab">in review</div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function NeedsAttention({ items = [], blockerIds, onOpen }) {
  return (
    <>
      <h2>Needs attention</h2>
      {!items.length ? <Empty>Nothing waiting - no failed, in-review, or needs-info tickets.</Empty> : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Ticket</th><th>Project</th><th>Status</th><th>Att.</th><th>Note</th><th>Updated</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.shortId}>
                  <td><TicketLink item={item} onOpen={onOpen} />{blockerIds?.has(item.shortId) ? <> <BlockageTag role="blocker" /></> : null}</td>
                  <td><ProjectTag project={item.project} /></td>
                  <td><StatusTag status={item.status} /></td>
                  <td className="num">{item.attempts}</td>
                  <td className="muted">{item.note || '-'}</td>
                  <td className="num">{ago(item.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Completed({ items = [], onOpen }) {
  return (
    <>
      <h2>Recently completed</h2>
      {!items.length ? <Empty>No completed tickets yet.</Empty> : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>Ticket</th><th>Project</th><th>Kind</th><th>Agent</th><th>Att.</th><th>When</th></tr></thead>
            <tbody>
              {items.slice(0, 20).map((item) => (
                <tr key={item.shortId}>
                  <td><TicketLink item={item} onOpen={onOpen} /></td>
                  <td><ProjectTag project={item.project} /></td>
                  <td>{item.kind}</td>
                  <td className="mono">{item.agent || '-'}</td>
                  <td className="num">{item.attempts}</td>
                  <td className="num">{ago(item.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Activity({ items = [], onOpen }) {
  return (
    <>
      <h2>Activity</h2>
      {!items.length ? <Empty>No activity recorded yet.</Empty> : (
        <div className="tblwrap">
          <table>
            <thead><tr><th>When</th><th>Ticket</th><th>Project</th><th>Change</th></tr></thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={`${item.shortId}-${item.at}-${index}`}>
                  <td className="num">{ago(item.at)}</td>
                  <td><TicketLink item={item} onOpen={onOpen} /></td>
                  <td><ProjectTag project={item.project} /></td>
                  <td>{item.type === 'transition' ? <><StatusTag status={item.from} /> <span className="muted">-&gt;</span> <StatusTag status={item.to} /></> : item.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function JsonBlock({ value }) {
  return <pre className="detail">{JSON.stringify(value || {}, null, 2)}</pre>;
}

function EventTable({ events = [] }) {
  if (!events.length) return <Empty>No events recorded.</Empty>;
  return (
    <div className="tblwrap">
      <table>
        <thead><tr><th>When</th><th>Type</th><th>Change</th><th>Payload</th></tr></thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td className="num">{ago(event.at)}</td>
              <td>{event.type}</td>
              <td>{event.type === 'transition' ? <><StatusTag status={event.from} /> <span className="muted">-&gt;</span> <StatusTag status={event.to} /></> : <span className="muted">-</span>}</td>
              <td><span className="mono">{JSON.stringify(event.payload || {})}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RelationList({ items = [], onOpen }) {
  if (!items.length) return <span className="muted">-</span>;
  return items.map((item) => (
    <div className="rowline relation-row" key={`${item.shortId}-${item.type}`}>
      <TicketLink item={item} onOpen={onOpen} /> <StatusTag status={item.status} /> <ProjectTag project={item.project} />
    </div>
  ));
}

function OutboxTable({ items = [] }) {
  if (!items.length) return <Empty>No sync operations for this ticket.</Empty>;
  return (
    <div className="tblwrap">
      <table>
        <thead><tr><th>Op</th><th>Attempts</th><th>Next</th><th>Done</th><th>Error</th></tr></thead>
        <tbody>
          {items.map((op) => (
            <tr key={op.id}>
              <td className="mono">{op.op}</td>
              <td className="num">{op.attempts}</td>
              <td className="num">{ago(op.nextAttemptAt)}</td>
              <td className="num">{op.doneAt ? ago(op.doneAt) : <span className="muted">pending</span>}</td>
              <td className="muted">{op.lastError || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TicketModal({ ticketId, onClose, onOpen }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: '' });
    fetch(`/api/tickets/${encodeURIComponent(ticketId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'ticket load failed');
        if (alive) setState({ loading: false, data: body, error: '' });
      })
      .catch((error) => {
        if (alive) setState({ loading: false, data: null, error: error.message });
      });
    return () => { alive = false; };
  }, [ticketId]);

  const ticket = state.data?.ticket;

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <div>
            <div className="modal-title">{state.loading ? 'Loading ticket...' : state.error ? 'Ticket unavailable' : ticket.title || '(untitled)'}</div>
            {ticket ? <div className="rowline modal-status"><StatusTag status={ticket.status} /> <span className="mono">{ticket.shortId}</span></div> : null}
          </div>
          <button className="btn icon-btn modal-close" type="button" onClick={onClose} aria-label="Close ticket details"><X size={16} /></button>
        </div>
        {state.error ? <Empty error>{state.error}</Empty> : null}
        {ticket ? (
          <>
            <div className="detail-grid">
              <Field label="Project">{ticket.projectKey}</Field>
              <Field label="Kind">{ticket.kind}</Field>
              <Field label="Attempts">{ticket.attempts}</Field>
              <Field label="Review rounds">{ticket.reviewRounds}</Field>
              <Field label="Last agent">{ticket.lastAgent}</Field>
              <Field label="Engine pin">{ticket.enginePin}</Field>
              <Field label="Model pin">{ticket.modelPin}</Field>
              <Field label="Branch">{ticket.branch}</Field>
              <Field label="Base SHA">{ticket.baseSha}</Field>
              <Field label="Head SHA">{ticket.headSha}</Field>
              <Field label="Created">{ticket.createdAt}</Field>
              <Field label="Updated">{ticket.updatedAt}</Field>
              <Field label="Implemented">{ticket.implementedAt}</Field>
              <Field label="Closed">{ticket.closedAt}</Field>
              <Field label="Tracker">{ticket.tracker}</Field>
              <Field label="Tracker URL">{ticket.url ? <a href={ticket.url} target="_blank" rel="noopener noreferrer">Open tracker</a> : ''}</Field>
            </div>
            <h2>Description</h2>
            {ticket.body ? <pre className="detail">{ticket.body}</pre> : <Empty>No description stored.</Empty>}
            <h2>Review feedback</h2>
            {ticket.reviewFeedback ? <pre className="detail">{ticket.reviewFeedback}</pre> : <Empty>No review feedback.</Empty>}
            <h2>Files</h2>
            <div className="detail-grid">
              <Field label="Changed files"><Chips items={ticket.changedFiles} /></Field>
              <Field label="Native-sensitive files"><Chips items={ticket.nativeSensitiveFiles} /></Field>
            </div>
            <h2>Relations</h2>
            <div className="detail-grid">
              <Field label="Depends on"><RelationList items={state.data.dependencies} onOpen={onOpen} /></Field>
              <Field label="Blocked by this"><RelationList items={state.data.blockedBy} onOpen={onOpen} /></Field>
            </div>
            <h2>Events</h2>
            <EventTable events={state.data.events} />
            <h2>Sync outbox</h2>
            <OutboxTable items={state.data.outbox} />
            <h2>Metadata</h2>
            <div className="detail-grid">
              <JsonBlock value={ticket.trackerMeta} />
              <JsonBlock value={ticket.meta} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function LogsPage({ services = [] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id || 'ticket-runner');
  const [lineCount, setLineCount] = useState(200);
  const [live, setLive] = useState(true);
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    if (!services.some((service) => service.id === serviceId) && services[0]?.id) {
      setServiceId(services[0].id);
    }
  }, [serviceId, services]);

  const loadLogs = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const response = await fetch(`/api/logs/${encodeURIComponent(serviceId)}?lines=${lineCount}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'log load failed');
      setState({ loading: false, data: body, error: '' });
    } catch (logError) {
      setState((current) => ({ loading: false, data: current.data, error: logError.message }));
    }
  }, [lineCount, serviceId]);

  useEffect(() => {
    loadLogs();
    if (!live) return undefined;
    const timer = setInterval(loadLogs, 4000);
    return () => clearInterval(timer);
  }, [live, loadLogs]);

  const text = state.data?.lines?.join('\n') || '';

  return (
    <>
      <h2>Live logs</h2>
      <div className="log-toolbar">
        <div className="segmented" role="tablist" aria-label="Service logs">
          {services.map((service) => (
            <button
              className={`seg-btn${service.id === serviceId ? ' active' : ''}`}
              key={service.id}
              type="button"
              onClick={() => setServiceId(service.id)}
            >
              <ScrollText size={14} /> {service.label}
            </button>
          ))}
        </div>
        <select className="select" value={lineCount} onChange={(event) => setLineCount(Number(event.target.value))} aria-label="Log line count">
          <option value={100}>Tail 100</option>
          <option value={200}>Tail 200</option>
          <option value={500}>Tail 500</option>
          <option value={1000}>Tail 1000</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          Live
        </label>
        <button className="btn" type="button" onClick={loadLogs} disabled={state.loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div className="log-head">
        <span className="mono">{state.data?.service?.unit || serviceId}</span>
        <span className="sub">{state.loading ? 'Loading...' : state.data?.generatedAt ? `Updated ${ago(state.data.generatedAt)}` : ''}</span>
      </div>
      {state.error ? <div className="note err">{state.error}</div> : null}
      {text ? <pre className="logs">{text}</pre> : <Empty>{state.loading ? 'Loading logs...' : 'No log lines returned.'}</Empty>}
    </>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [actionStatus, setActionStatus] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [view, setView] = useState(() => (window.location.hash === '#logs' ? 'logs' : 'dashboard'));
  const [codeVersion, setCodeVersion] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/data', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'dashboard load failed');
      setData(body);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setTicketId('');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(window.location.hash === '#logs' ? 'logs' : 'dashboard');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const nextVersion = data?.dashboard?.codeVersion;
    if (!nextVersion) return;
    if (!codeVersion) {
      setCodeVersion(nextVersion);
      return;
    }
    if (nextVersion !== codeVersion) {
      window.location.reload();
    }
  }, [codeVersion, data?.dashboard?.codeVersion]);

  const restartRunner = useCallback(async () => {
    if (!window.confirm('Restart ticket-runner services?')) return;
    setRestarting(true);
    setActionStatus('Restarting...');
    try {
      const response = await fetch('/api/restart', { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'restart failed');
      setActionStatus('Restart requested');
      setTimeout(load, 4000);
    } catch (restartError) {
      setActionStatus(restartError.message);
      setRestarting(false);
    }
  }, [load]);

  const overview = useMemo(() => {
    const byStatus = data?.store?.byStatus || {};
    const active = (byStatus.queued || 0) + (byStatus.in_progress || 0) + (byStatus.in_review || 0) + (byStatus.testing || 0) + (byStatus.needs_info || 0);
    return { byStatus, active };
  }, [data]);
  const projectPalette = useMemo(() => buildProjectPalette(data?.projects), [data?.projects]);

  if (error && !data) {
    return <main className="wrap"><Empty error>Failed to load: {error}</Empty></main>;
  }
  if (!data) {
    return <main className="wrap"><Empty>Loading dashboard...</Empty></main>;
  }

  const runner = data.runner || {};
  const store = data.store || {};
  const dashboard = data.dashboard || {};
  const blockerIds = new Set((store.blockages?.blockers || []).map((item) => item.shortId));
  const runnerDot = runner.state === 'live' ? 'var(--good)' : runner.state === 'stale' ? 'var(--warning)' : 'var(--muted)';
  const runnerText = runner.state === 'live' ? 'Runner live' : runner.state === 'stale' ? 'Runner stale' : 'Runner status unknown';
  const setPage = (nextView) => {
    setView(nextView);
    window.location.hash = nextView === 'logs' ? 'logs' : '';
  };

  return (
    <ProjectPaletteContext.Provider value={projectPalette}>
      <div className="wrap">
        <header>
          <h1>{data.app} <span className="muted light">dashboard</span></h1>
          <span className="pill"><Dot color={runnerDot} />{runnerText}{runner.heartbeat ? ` - ${ago(runner.heartbeat.at)}` : ''}</span>
          {data.pollIntervalMs ? <span className="sub">poll {Math.round(data.pollIntervalMs / 1000)}s - max {data.maxAttempts} attempts</span> : null}
          <nav className="view-nav" aria-label="Dashboard views">
            <button className={`btn nav-btn${view === 'dashboard' ? ' active' : ''}`} type="button" onClick={() => setPage('dashboard')}>
              <LayoutDashboard size={14} /> Dashboard
            </button>
            <button className={`btn nav-btn${view === 'logs' ? ' active' : ''}`} type="button" onClick={() => setPage('logs')}>
              <ScrollText size={14} /> Logs
            </button>
          </nav>
          <div className="actions">
            <span className="sub">{actionStatus}</span>
            <button className="btn danger restart-btn" type="button" onClick={restartRunner} disabled={restarting}>
              <RefreshCw size={14} /> Restart
            </button>
          </div>
        </header>
        <div className="sub">Updated {ago(data.generatedAt)} - auto-refreshes every 15s</div>
        <div className="server-line">
          {dashboard.url ? <span>Dashboard <span className="mono">{dashboard.url}</span></span> : null}
          {dashboard.pid ? <span>PID <span className="mono">{dashboard.pid}</span></span> : null}
          {dashboard.startedAt ? <span>started {ago(dashboard.startedAt)}</span> : null}
          {dashboard.restartCommand ? <span>restart <span className="mono">{dashboard.restartCommand}</span></span> : null}
          {dashboard.checkout ? <span>checkout <span className="mono">{dashboard.checkout}</span></span> : null}
        </div>

        {view === 'logs' ? (
          <LogsPage services={data.services} />
        ) : (
          <>
            {error ? <div className="note err">Last refresh failed: {error}</div> : null}
            {!store.available ? <Empty error>Ticket store unavailable: {store.error}</Empty> : null}

            <Blockages blockages={store.blockages} onOpen={setTicketId} />
            <NeedsInfoPanel items={store.needsInfo} blockerIds={blockerIds} onOpen={setTicketId} />

            <h2>Overview</h2>
            <div className="grid tiles">
              <Tile value={store.totals?.tickets || 0} label="Tickets total" />
              <Tile value={overview.active} label="Active in pipeline" />
              <Tile value={store.blockages?.blocked?.length || 0} label="Blocked by dependency" color={store.blockages?.blocked?.length ? 'var(--critical)' : ''} />
              <Tile value={overview.byStatus.done || 0} label="Completed" />
              <Tile value={overview.byStatus.failed || 0} label="Failed" color={overview.byStatus.failed ? 'var(--critical)' : ''} />
              <Tile value={(overview.byStatus.needs_info || 0) + (overview.byStatus.in_review || 0)} label="Awaiting human" />
              <Tile value={store.totals?.outboxParked || 0} label="Parked sync ops" color={store.totals?.outboxParked ? 'var(--warning)' : ''} />
            </div>

            <CurrentState data={data} onOpen={setTicketId} />
            <Projects data={data} onOpen={setTicketId} />

            <h2>Agent providers &amp; quota</h2>
            <ProviderCards providers={data.providers} />
            <div className="note">
              These coding CLIs do not expose a remaining-quota number. The runner detects rate limits reactively and fails over down the chain. Runs attributes each ticket to the provider that last worked it (from <span className="mono">last_agent</span>); token counts are reconstructed from per-invocation logs.
            </div>

            <TokenUsage tokens={data.tokens} onOpen={setTicketId} />
            <Connections connections={data.connections} />
            <NeedsAttention items={store.attention} blockerIds={blockerIds} onOpen={setTicketId} />
            <Completed items={store.completed} onOpen={setTicketId} />
            <Activity items={store.activity} onOpen={setTicketId} />
            <footer>Store integrity: {store.integrity} - {store.totals?.outboxPending || 0} sync op(s) pending - read-only view of state/runner.db</footer>
          </>
        )}
      </div>
      {ticketId ? <TicketModal ticketId={ticketId} onClose={() => setTicketId('')} onOpen={setTicketId} /> : null}
    </ProjectPaletteContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<App />);
