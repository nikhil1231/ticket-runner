'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { openDb, closeDb } = require('./db');
const { createStore } = require('./store');
const { normalizeProject, legacyProjectFromBoard } = require('./projects');
const healingState = require('./healing-state');

// The dashboard is a read-only, token-free view over local state: config.json
// (projects, provider policies, adapters), the SQLite ticket store, and the
// heartbeat file. It never talks to Notion/GitHub, so it renders even when no
// tracker token is configured. Quota is not a number these coding CLIs expose;
// the runner only detects rate limiting reactively (see engine.js QUOTA_RE), so
// the provider panel reports availability and attributed usage, not a countdown.

const CANONICAL_STATUSES = ['queued', 'in_progress', 'needs_info', 'in_review', 'testing', 'done', 'failed', 'cancelled'];

// Which env token / CLI each capability needs, so the dashboard can say what is
// actually wired up without importing the token-gated modules.
const CONNECTIONS = [
  { id: 'notion', label: 'Notion', env: 'NOTION_TOKEN', need: (p) => p.tracker?.type === 'notion' || p.trackerType === 'notion' },
  { id: 'github', label: 'GitHub', env: 'GITHUB_TOKEN', need: (p) => p.tracker?.type === 'github' || p.trackerType === 'github' },
  { id: 'expo', label: 'Expo (EAS)', env: 'EXPO_TOKEN', need: (p) => (p.publisher?.type || p.publisherType) === 'eas-update' },
];

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// Cross-platform "is this command on PATH" without spawning it (spawning a coding
// CLI just to probe presence risks hanging on an interactive prompt).
function commandOnPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/') || cmd.includes('\\')) return safe(() => fs.existsSync(cmd), false);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (safe(() => fs.existsSync(path.join(dir, cmd + ext)), false)) return true;
    }
  }
  return false;
}

// Build project views from config without touching Notion. Prefer the local
// `projects` array, fall back to legacy `boards`; a registry-only config can't be
// resolved offline, which we surface rather than fail on.
function loadProjects(config) {
  const raw = [];
  if (Array.isArray(config.projects) && config.projects.length) {
    for (const p of config.projects) raw.push(safe(() => normalizeProject(config, p), null));
  } else if (Array.isArray(config.boards) && config.boards.length) {
    for (const b of config.boards) raw.push(safe(() => legacyProjectFromBoard(config, b), null));
  }
  const projects = raw.filter(Boolean).map((p) => ({
    key: p.key,
    repoPath: p.repoPath,
    baseBranch: p.baseBranch,
    mainBranch: p.mainBranch,
    workdir: p.workdir,
    trackerType: p.tracker?.type || 'notion',
    integrationMode: p.integrationMode,
    integrationEnabled: !!p.integration?.enabled,
    publisherType: p.publisher?.type || 'none',
    easChannel: p.easChannel || '',
    validationCommands: (p.validationCommands || []).map((c) => c.join(' ')),
    notes: p.notes || '',
  }));
  const registryOnly = !projects.length && !!config.projectRegistry?.databaseId;
  return { projects, registryOnly };
}

// Providers = coding CLIs (from adapters), enriched with the models each is
// offered across the fallback policies and whether its CLI is installed.
function collectProviders(config) {
  const adapters = config.adapters || {};
  const policies = config.fallbackPolicies || {};
  const providers = {};
  const ensure = (name) => (providers[name] ||= { name, cmd: adapters[name]?.cmd || name, models: new Map(), phases: {} });
  for (const name of Object.keys(adapters)) ensure(name);
  for (const [phase, chain] of Object.entries(policies)) {
    (chain || []).forEach((cand, idx) => {
      if (!cand.provider) return;
      const p = ensure(cand.provider);
      const model = cand.model || '(default)';
      p.models.set(model, true);
      if (p.phases[phase] === undefined) p.phases[phase] = idx + 1; // 1-based priority
    });
  }
  return Object.values(providers).map((p) => ({
    name: p.name,
    cmd: p.cmd,
    installed: commandOnPath(p.cmd),
    models: [...p.models.keys()],
    phases: p.phases, // { feature: 1, review: 2, ... } = priority in that chain
  }));
}

function connectionStatus(config, projects) {
  return CONNECTIONS.map((c) => {
    const required = projects.some((p) => c.need(p)) || (c.id === 'notion' && !!config.incubator?.databaseId);
    return {
      id: c.id,
      label: c.label,
      env: c.env,
      configured: !!process.env[c.env],
      required,
    };
  });
}

function runnerStatus(baseDir) {
  const hb = safe(() => healingState.readState(baseDir, 'heartbeat', null), null);
  if (!hb || !hb.at) return { state: 'unknown', heartbeat: null, ageMs: null };
  const ageMs = Date.now() - Date.parse(hb.at);
  // Loop heartbeats every poll interval; > ~5 min without one means the process
  // is stopped or wedged.
  const state = ageMs < 5 * 60 * 1000 ? 'live' : 'stale';
  return { state, heartbeat: hb, ageMs };
}

// ---- ticket store reads (all read-only) ----

function providerOf(lastAgent) {
  return String(lastAgent || '').split('/')[0].trim().toLowerCase();
}

function collectStoreData(baseDir) {
  const db = openDb(baseDir);
  try {
    const store = createStore({ baseDir, db });
    const all = (sql, ...args) => safe(() => db.prepare(sql).all(...args), []);
    const one = (sql, ...args) => safe(() => db.prepare(sql).get(...args), null);

    const byStatus = {};
    for (const r of all('SELECT status, COUNT(*) n FROM tickets GROUP BY status')) byStatus[r.status] = r.n;

    const perProjectRows = all('SELECT project_key, status, COUNT(*) n FROM tickets GROUP BY project_key, status');
    const projectStatus = {};
    for (const r of perProjectRows) {
      (projectStatus[r.project_key] ||= {})[r.status] = r.n;
    }

    const doneRows = all(
      `SELECT short_id, project_key, title, kind, last_agent, attempts, closed_at, implemented_at, updated_at,
              tracker, tracker_meta
       FROM tickets WHERE status = 'done'
       ORDER BY COALESCE(closed_at, implemented_at, updated_at) DESC LIMIT 40`
    );
    const completed = doneRows.map((r) => ({
      shortId: r.short_id,
      project: r.project_key,
      title: r.title,
      kind: r.kind,
      agent: r.last_agent || '',
      attempts: r.attempts,
      at: r.closed_at || r.implemented_at || r.updated_at,
      url: safe(() => JSON.parse(r.tracker_meta).url, '') || '',
    }));

    const attention = all(
      `SELECT short_id, project_key, title, status, attempts, review_feedback, updated_at
       FROM tickets WHERE status IN ('failed','needs_info','in_review')
       ORDER BY updated_at DESC LIMIT 25`
    ).map((r) => ({
      shortId: r.short_id, project: r.project_key, title: r.title, status: r.status,
      attempts: r.attempts, note: (r.review_feedback || '').slice(0, 160), at: r.updated_at,
    }));

    const activity = all(
      `SELECT e.type, e.from_status, e.to_status, e.created_at,
              t.title, t.project_key, t.short_id
       FROM ticket_events e LEFT JOIN tickets t ON t.id = e.ticket_id
       ORDER BY e.id DESC LIMIT 40`
    ).map((r) => ({
      type: r.type, from: r.from_status, to: r.to_status, at: r.created_at,
      title: r.title || '(unknown ticket)', project: r.project_key || '', shortId: r.short_id || '',
    }));

    // Attribute work to providers via last_agent ("provider / model"). Split total
    // vs last 24h so the panel shows recent pressure, our best proxy for load.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const usageTotal = {};
    for (const r of all("SELECT last_agent, COUNT(*) n FROM tickets WHERE last_agent <> '' GROUP BY last_agent")) {
      const p = providerOf(r.last_agent);
      if (p) usageTotal[p] = (usageTotal[p] || 0) + r.n;
    }
    const usageRecent = {};
    for (const r of all("SELECT last_agent, COUNT(*) n FROM tickets WHERE last_agent <> '' AND updated_at >= ? GROUP BY last_agent", dayAgo)) {
      const p = providerOf(r.last_agent);
      if (p) usageRecent[p] = (usageRecent[p] || 0) + r.n;
    }

    const stacks = all('SELECT project_key, status, publisher, branch, deployed_at FROM stacks').map((r) => ({
      project: r.project_key, status: r.status, publisher: r.publisher, branch: r.branch, deployedAt: r.deployed_at,
    }));

    const stats = safe(() => store.stats(), { tickets: 0, byStatus: {}, outboxPending: 0, outboxParked: 0 });
    const integrity = safe(() => one('PRAGMA integrity_check').integrity_check, 'unknown');

    return {
      totals: { tickets: stats.tickets || 0, outboxPending: stats.outboxPending || 0, outboxParked: stats.outboxParked || 0 },
      byStatus, projectStatus, completed, attention, activity,
      usage: { total: usageTotal, recent: usageRecent }, stacks, integrity,
      available: true,
    };
  } catch (error) {
    return { available: false, error: error.message, totals: {}, byStatus: {}, projectStatus: {}, completed: [], attention: [], activity: [], usage: { total: {}, recent: {} }, stacks: [], integrity: 'unavailable' };
  } finally {
    closeDb(db);
  }
}

function collectData(config, { baseDir }) {
  const { projects, registryOnly } = loadProjects(config);
  const providers = collectProviders(config);
  const connections = connectionStatus(config, projects);
  const store = collectStoreData(baseDir);

  // Fold per-provider usage into the provider cards.
  for (const p of providers) {
    p.usageTotal = store.usage.total[p.name] || 0;
    p.usageRecent = store.usage.recent[p.name] || 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    app: safe(() => require(path.join(baseDir, 'package.json')).name, 'ticket-runner'),
    runner: runnerStatus(baseDir),
    pollIntervalMs: config.pollIntervalMs || null,
    maxAttempts: config.maxAttempts || null,
    statuses: CANONICAL_STATUSES,
    projects,
    registryOnly,
    providers,
    connections,
    store,
  };
}

// ---- HTTP server ----

function startServer(config, { baseDir, port = 4600, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/data') {
      let body;
      try {
        body = JSON.stringify(collectData(config, { baseDir }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}

// Self-contained page: fetches /api/data and renders. Palette follows the
// data-viz reference (validated status + categorical hues, theme-aware surfaces).
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ticket-runner dashboard</title>
<style>
:root{
  --plane:#f9f9f7; --surface:#fcfcfb; --surface-2:#f2f1ee;
  --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --hair:rgba(11,11,11,.10); --grid:#e1e0d9;
  --good:#0ca30c; --warning:#eda100; --serious:#ec835a; --critical:#d03b3b;
  --c1:#2a78d6; --c2:#1baf7a; --c3:#eda100; --c5:#4a3aa7; --c8:#eb6834;
  --accent:#2a78d6;
}
@media (prefers-color-scheme:dark){:root{
  --plane:#0d0d0d; --surface:#1a1a19; --surface-2:#232320;
  --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
  --hair:rgba(255,255,255,.10); --grid:#2c2c2a;
  --good:#0ca30c; --warning:#c98500; --serious:#ec835a; --critical:#e05757;
  --c1:#3987e5; --c2:#199e70; --c3:#c98500; --c5:#9085e9; --c8:#d95926;
  --accent:#3987e5;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.45}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:4px}
h1{font-size:19px;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:12.5px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.pill{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
  border:1px solid var(--hair);background:var(--surface);font-size:12px;font-weight:500}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
  margin:30px 0 12px;font-weight:600}
.grid{display:grid;gap:14px}
.cards{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.card{background:var(--surface);border:1px solid var(--hair);border-radius:12px;padding:14px 15px}
.card h3{margin:0 0 2px;font-size:14.5px;display:flex;align-items:center;gap:8px;justify-content:space-between}
.card .k{color:var(--muted);font-size:12px}
.tiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.tile{background:var(--surface);border:1px solid var(--hair);border-radius:12px;padding:13px 15px}
.tile .val{font-size:26px;font-weight:650;letter-spacing:-.02em}
.tile .lab{color:var(--muted);font-size:12px;margin-top:2px}
.bar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:var(--surface-2);margin:9px 0 8px}
.bar span{display:block;height:100%}
.seg-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--ink-2)}
.seg-legend b{font-variant-numeric:tabular-nums;color:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
td.num{font-variant-numeric:tabular-nums;color:var(--ink-2)}
.tblwrap{background:var(--surface);border:1px solid var(--hair);border-radius:12px;overflow-x:auto}
tbody tr:last-child td{border-bottom:none}
.tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--hair);white-space:nowrap;
  font-weight:600;display:inline-flex;align-items:center;gap:5px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:var(--ink-2)}
.muted{color:var(--muted)}
.note{color:var(--muted);font-size:12px;margin-top:8px;max-width:70ch}
.empty{color:var(--muted);padding:18px;text-align:center;background:var(--surface);
  border:1px dashed var(--hair);border-radius:12px}
.rowline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.chip{font-size:11px;padding:1px 7px;border-radius:6px;background:var(--surface-2);color:var(--ink-2);
  font-family:ui-monospace,Menlo,Consolas,monospace}
footer{margin-top:34px;color:var(--muted);font-size:12px}
.err{color:var(--critical)}
</style>
</head>
<body>
<div class="wrap" id="root"><div class="empty">Loading dashboard…</div></div>
<script>
const STATUS_COLOR={queued:'var(--muted)',in_progress:'var(--c1)',needs_info:'var(--warning)',
  in_review:'var(--c5)',testing:'var(--c3)',done:'var(--good)',failed:'var(--critical)',cancelled:'var(--muted)'};
const STATUS_LABEL={queued:'Queued',in_progress:'In progress',needs_info:'Needs info',
  in_review:'In review',testing:'Testing',done:'Done',failed:'Failed',cancelled:'Cancelled'};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ago(iso){if(!iso)return '—';const d=Date.now()-Date.parse(iso);if(isNaN(d))return '—';
  const m=Math.round(d/6e4);if(m<1)return 'just now';if(m<60)return m+'m ago';
  const h=Math.round(m/60);if(h<24)return h+'h ago';const dd=Math.round(h/24);return dd+'d ago';}

function statusBar(counts,statuses){
  const total=statuses.reduce((a,s)=>a+(counts[s]||0),0);
  if(!total)return '<div class="muted" style="font-size:12px">No tickets yet</div>';
  const segs=statuses.filter(s=>counts[s]).map(s=>
    '<span style="width:'+(100*counts[s]/total)+'%;background:'+STATUS_COLOR[s]+
    '" title="'+STATUS_LABEL[s]+': '+counts[s]+'"></span>').join('');
  const leg=statuses.filter(s=>counts[s]).map(s=>
    '<span><span class="dot" style="background:'+STATUS_COLOR[s]+'"></span>'+
    STATUS_LABEL[s]+' <b>'+counts[s]+'</b></span>').join('');
  return '<div class="bar">'+segs+'</div><div class="seg-legend">'+leg+'</div>';
}

function render(d){
  const r=document.getElementById('root');
  const rs=d.runner, live=rs.state==='live';
  const runnerDot=live?'var(--good)':rs.state==='stale'?'var(--warning)':'var(--muted)';
  const runnerTxt=rs.state==='live'?'Runner live':rs.state==='stale'?'Runner stale':'Runner status unknown';
  const s=d.store;

  let h='';
  h+='<header><h1>'+esc(d.app)+' <span class="muted" style="font-weight:400">dashboard</span></h1>'+
     '<span class="pill"><span class="dot" style="background:'+runnerDot+'"></span>'+runnerTxt+
     (rs.heartbeat?' · '+ago(rs.heartbeat.at):'')+'</span>'+
     (d.pollIntervalMs?'<span class="sub">poll '+Math.round(d.pollIntervalMs/1000)+'s · max '+esc(d.maxAttempts)+' attempts</span>':'')+
     '</header><div class="sub">Updated '+ago(d.generatedAt)+' · auto-refreshes every 15s</div>';

  if(!s.available)h+='<div class="empty err" style="margin-top:16px">Ticket store unavailable: '+esc(s.error)+'</div>';

  // KPI tiles
  const bs=s.byStatus||{};
  const active=(bs.queued||0)+(bs.in_progress||0)+(bs.in_review||0)+(bs.testing||0)+(bs.needs_info||0);
  h+='<h2>Overview</h2><div class="grid tiles">'+
    tile(s.totals.tickets||0,'Tickets total')+
    tile(active,'Active in pipeline')+
    tile(bs.done||0,'Completed')+
    tile(bs.failed||0,'Failed',(bs.failed?'var(--critical)':''))+
    tile((bs.needs_info||0)+(bs.in_review||0),'Awaiting human')+
    tile(s.totals.outboxParked||0,'Parked sync ops',(s.totals.outboxParked?'var(--warning)':''))+
    '</div>';

  // Providers / quota
  h+='<h2>Agent providers &amp; quota</h2><div class="grid cards">';
  for(const p of d.providers){
    const dotc=p.installed?'var(--good)':'var(--critical)';
    const phases=Object.entries(p.phases||{}).map(([ph,pr])=>
      '<span class="chip" title="priority '+pr+' in '+ph+' chain">'+esc(ph)+' #'+pr+'</span>').join('')||'<span class="muted">not in any policy</span>';
    const models=(p.models||[]).map(m=>'<span class="chip">'+esc(m)+'</span>').join('')||'<span class="muted">—</span>';
    h+='<div class="card"><h3>'+esc(p.name)+
       '<span class="tag"><span class="dot" style="background:'+dotc+'"></span>'+(p.installed?'installed':'CLI missing')+'</span></h3>'+
       '<div class="k mono">'+esc(p.cmd)+'</div>'+
       '<div style="margin-top:10px;display:flex;gap:18px">'+
         '<div><div class="tile" style="border:0;padding:0"><div class="val" style="font-size:22px">'+p.usageRecent+'</div><div class="lab">runs · 24h</div></div></div>'+
         '<div><div class="val" style="font-size:22px;font-weight:650">'+p.usageTotal+'</div><div class="lab" style="color:var(--muted);font-size:12px">runs · total</div></div>'+
       '</div>'+
       '<div class="k" style="margin-top:10px">Models</div><div class="chips">'+models+'</div>'+
       '<div class="k" style="margin-top:8px">Failover priority</div><div class="chips">'+phases+'</div>'+
       '</div>';
  }
  h+='</div>';
  h+='<div class="note">These coding CLIs don\\'t expose a remaining-quota number — the runner detects rate limits '+
     'reactively and fails over down the chain. "Runs" attributes each ticket to the provider that last worked it '+
     '(from <span class="mono">last_agent</span>); recent runs are the best available proxy for quota pressure.</div>';

  // Connections
  h+='<div class="chips" style="margin-top:12px">';
  for(const c of d.connections){
    const ok=c.configured, dotc=ok?'var(--good)':(c.required?'var(--critical)':'var(--muted)');
    const lab=ok?'connected':(c.required?'token missing':'not used');
    h+='<span class="tag"><span class="dot" style="background:'+dotc+'"></span>'+esc(c.label)+' · '+lab+'</span>';
  }
  h+='</div>';

  // Projects
  h+='<h2>Projects</h2>';
  if(d.registryOnly)h+='<div class="note">Projects are defined in a Notion project registry, which the dashboard can\\'t read offline. '+
    'Add a local <span class="mono">projects</span> array to config.json to list them here.</div>';
  if(!d.projects.length && !d.registryOnly)h+='<div class="empty">No projects configured.</div>';
  if(d.projects.length){
    h+='<div class="grid cards" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">';
    for(const p of d.projects){
      const counts=s.projectStatus[p.key]||{};
      const stack=(s.stacks||[]).find(x=>x.project===p.key);
      const recent=(s.completed||[]).filter(c=>c.project===p.key).slice(0,4);
      h+='<div class="card"><h3>'+esc(p.key)+
         '<span class="tag">'+esc(p.trackerType)+'</span></h3>'+
         '<div class="k mono">'+esc(p.repoPath||'')+'</div>'+
         '<div class="rowline" style="margin-top:6px">'+
           '<span class="chip">publish: '+esc(p.publisherType)+(p.easChannel?' ('+esc(p.easChannel)+')':'')+'</span>'+
           '<span class="chip">'+esc(p.integrationMode)+(p.integrationEnabled?'':' · off')+'</span>'+
           (stack?'<span class="tag" title="testing stack"><span class="dot" style="background:'+(stack.status==='deployed'?'var(--good)':stack.status==='blocked'?'var(--critical)':'var(--muted)')+'"></span>stack: '+esc(stack.status)+'</span>':'')+
         '</div>'+
         statusBar(counts,d.statuses)+
         '<div class="k" style="margin-top:8px">Recent completed</div>'+
         (recent.length?('<div style="margin-top:4px">'+recent.map(c=>
            '<div class="rowline" style="justify-content:space-between;border-top:1px solid var(--grid);padding:5px 0">'+
            '<span>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank" rel="noopener">'+esc(c.title)+'</a>':esc(c.title))+'</span>'+
            '<span class="muted" style="font-size:11.5px;white-space:nowrap">'+ago(c.at)+'</span></div>').join('')+'</div>')
           :'<div class="muted" style="font-size:12px;margin-top:4px">Nothing completed yet</div>')+
         '</div>';
    }
    h+='</div>';
  }

  // Needs attention
  h+='<h2>Needs attention</h2>';
  if(!s.attention.length)h+='<div class="empty">Nothing waiting — no failed, in-review, or needs-info tickets.</div>';
  else{
    h+='<div class="tblwrap"><table><thead><tr><th>Ticket</th><th>Project</th><th>Status</th><th>Att.</th><th>Note</th><th>Updated</th></tr></thead><tbody>';
    for(const t of s.attention)h+='<tr><td>'+esc(t.title)+' <span class="mono">'+esc(t.shortId)+'</span></td>'+
      '<td class="mono">'+esc(t.project)+'</td><td>'+statusTag(t.status)+'</td>'+
      '<td class="num">'+esc(t.attempts)+'</td><td class="muted">'+esc(t.note||'—')+'</td>'+
      '<td class="num">'+ago(t.at)+'</td></tr>';
    h+='</tbody></table></div>';
  }

  // Recent completed (global)
  h+='<h2>Recently completed</h2>';
  if(!s.completed.length)h+='<div class="empty">No completed tickets yet.</div>';
  else{
    h+='<div class="tblwrap"><table><thead><tr><th>Ticket</th><th>Project</th><th>Kind</th><th>Agent</th><th>Att.</th><th>When</th></tr></thead><tbody>';
    for(const c of s.completed.slice(0,20))h+='<tr><td>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank" rel="noopener">'+esc(c.title)+'</a>':esc(c.title))+' <span class="mono">'+esc(c.shortId)+'</span></td>'+
      '<td class="mono">'+esc(c.project)+'</td><td>'+esc(c.kind)+'</td>'+
      '<td class="mono">'+esc(c.agent||'—')+'</td><td class="num">'+esc(c.attempts)+'</td><td class="num">'+ago(c.at)+'</td></tr>';
    h+='</tbody></table></div>';
  }

  // Activity feed
  h+='<h2>Activity</h2>';
  if(!s.activity.length)h+='<div class="empty">No activity recorded yet.</div>';
  else{
    h+='<div class="tblwrap"><table><thead><tr><th>When</th><th>Ticket</th><th>Project</th><th>Change</th></tr></thead><tbody>';
    for(const e of s.activity){
      const change=e.type==='transition'?(statusTag(e.from||'')+' <span class="muted">→</span> '+statusTag(e.to||'')):esc(e.type);
      h+='<tr><td class="num">'+ago(e.at)+'</td><td>'+esc(e.title)+' <span class="mono">'+esc(e.shortId)+'</span></td>'+
        '<td class="mono">'+esc(e.project)+'</td><td>'+change+'</td></tr>';
    }
    h+='</tbody></table></div>';
  }

  h+='<footer>Store integrity: '+esc(s.integrity)+' · '+
     (s.totals.outboxPending||0)+' sync op(s) pending · read-only view of state/runner.db</footer>';

  r.innerHTML=h;
}
function tile(v,l,c){return '<div class="tile"><div class="val"'+(c?' style="color:'+c+'"':'')+'>'+esc(v)+'</div><div class="lab">'+esc(l)+'</div></div>';}
function statusTag(st){if(!st)return '<span class="muted">—</span>';
  return '<span class="tag"><span class="dot" style="background:'+(STATUS_COLOR[st]||'var(--muted)')+'"></span>'+(STATUS_LABEL[st]||st)+'</span>';}

async function load(){
  try{const res=await fetch('/api/data',{cache:'no-store'});render(await res.json());}
  catch(e){document.getElementById('root').innerHTML='<div class="empty err">Failed to load: '+esc(e.message)+'</div>';}
}
load();setInterval(load,15000);
</script>
</body>
</html>`;

module.exports = { collectData, startServer, PAGE_HTML };
