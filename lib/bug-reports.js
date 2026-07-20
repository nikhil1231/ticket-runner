'use strict';

const { execFileSync } = require('child_process');
const { findProject } = require('./projects');

const DEFAULT_COLLECTION = 'bug_reports';
const DEFAULT_DATABASE = '(default)';
const DEFAULT_LIMIT = 5;
const FIRESTORE_ROOT = 'https://firestore.googleapis.com/v1';

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
}

function bugConfig(config) {
  const configured = config.bugReports || config.firestoreBugs;
  if (!configured) return null;
  const raw = configured || {};
  if (raw.enabled === false) return null;
  const projectId = raw.projectId || raw.firebaseProject || process.env.FIREBASE_PROJECT || process.env.GCLOUD_PROJECT || '';
  if (!projectId || raw.source === 'disabled') return null;
  return {
    projectId,
    database: raw.database || DEFAULT_DATABASE,
    collection: raw.collection || DEFAULT_COLLECTION,
    limit: raw.limit || DEFAULT_LIMIT,
    labels: raw.labels || ['bug', 'from-app'],
    statusNew: raw.statusNew || 'new',
    statusClaimed: raw.statusClaimed || 'claimed',
    statusFixing: raw.statusFixing || 'fixing',
    statusFixed: raw.statusFixed || 'fixed',
    statusBlocked: raw.statusBlocked || 'blocked',
    statusShipped: raw.statusShipped || 'shipped',
    firebaseCommand: raw.firebaseCommand || 'firebase',
  };
}

function firebaseJson(args, { command = 'firebase', cwd = process.cwd() } = {}) {
  const output = execFileSync(command, [...args, '--json', '--non-interactive'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function accessToken(options = {}) {
  const listed = firebaseJson(['login:list'], options);
  const accounts = listed.result || [];
  const token = accounts.find((account) => account.tokens?.access_token)?.tokens?.access_token;
  if (!token) throw new Error('firebase login:list did not return an access token; run `firebase login`');
  return token;
}

function firestoreValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return !!value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValue);
  if ('mapValue' in value) return firestoreFields(value.mapValue.fields || {});
  return undefined;
}

function firestoreFields(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = firestoreValue(value);
  return out;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toFirestoreValue(nested)])),
      },
    };
  }
  return { stringValue: String(value) };
}

function firestoreDocument(doc) {
  const segments = String(doc.name || '').split('/');
  return {
    name: doc.name,
    id: segments[segments.length - 1],
    updateTime: doc.updateTime,
    data: firestoreFields(doc.fields || {}),
  };
}

async function firestoreRequest({ token, method, url, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`Firestore ${method} ${url} -> ${response.status}: ${truncate(text, 500)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function documentUrl(settings, docName) {
  return `${FIRESTORE_ROOT}/${docName}`;
}

async function listNewReports(settings, { token }) {
  const url = `${FIRESTORE_ROOT}/projects/${encodeURIComponent(settings.projectId)}/databases/${encodeURIComponent(settings.database)}/documents:runQuery`;
  const result = await firestoreRequest({
    token,
    method: 'POST',
    url,
    body: {
      structuredQuery: {
        from: [{ collectionId: settings.collection }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: settings.statusNew },
          },
        },
        limit: settings.limit,
      },
    },
  });
  return (result || []).map((row) => row.document).filter(Boolean).map(firestoreDocument);
}

async function patchReport(settings, { token, docName, fields, updateTime }) {
  const params = new URLSearchParams();
  for (const field of Object.keys(fields)) params.append('updateMask.fieldPaths', field);
  if (updateTime) params.set('currentDocument.updateTime', updateTime);
  const body = {
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, toFirestoreValue(value)])),
  };
  return firestoreRequest({
    token,
    method: 'PATCH',
    url: `${documentUrl(settings, docName)}?${params.toString()}`,
    body,
  });
}

function trackerKey(board) {
  const tracker = board.tracker || {};
  if (tracker.type !== 'github' || !tracker.owner || !tracker.repo) {
    throw new Error(`${board.key || board.app}: Firestore bug reports require a GitHub project tracker to create visibility issues`);
  }
  return `github:${tracker.owner}/${tracker.repo}`;
}

function titleOf(report, docId) {
  return truncate(report.title || report.summary || report.note || report.body || `App bug report ${docId}`, 120).replace(/\s+/g, ' ').trim();
}

function reportBody(report, doc) {
  const logs = Array.isArray(report.logs) ? report.logs.join('\n') : report.logs;
  const context = [
    ['App', report.app || report.projectKey],
    ['Route', report.route],
    ['App version', report.appVersion],
    ['Build channel', report.buildChannel],
    ['Active stack', report.activeStack],
    ['Screenshot', report.screenshotUrl],
    ['Firestore report', doc.name],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');

  return [
    '# In-app bug report',
    '',
    report.body || report.note || report.description || '(No user note provided.)',
    '',
    '## Captured context',
    ...context.map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Implementation constraints',
    '- Treat this as a JS-only bugfix unless the report explicitly proves otherwise.',
    '- Build and reason against the current cumulative integration stack; that is what the app user was running.',
    '',
    logs ? `## Recent logs\n\n\`\`\`\n${truncate(logs, 6000)}\n\`\`\`` : '',
    report.state ? `## Captured state\n\n\`\`\`json\n${truncate(JSON.stringify(report.state, null, 2), 6000)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');
}

function statusForTicket(ticket, settings) {
  if (ticket.status === 'in_progress') return settings.statusFixing;
  if (ticket.status === 'in_review' || ticket.status === 'testing') return settings.statusFixed;
  if (ticket.status === 'done') return settings.statusShipped;
  if (ticket.status === 'needs_info' || ticket.status === 'failed') return settings.statusBlocked;
  if (ticket.status === 'cancelled') return 'cancelled';
  return settings.statusClaimed;
}

function updatePayloadForTicket(ticket, config, settings) {
  const stack = config.store?.getStack(ticket.projectKey);
  return {
    status: statusForTicket(ticket, settings),
    runnerTicketId: ticket.shortId,
    githubIssueUrl: ticket.trackerMeta?.url || null,
    githubIssueNumber: ticket.trackerMeta?.issueNumber || null,
    runnerStatus: ticket.status,
    runnerBranch: ticket.branch || null,
    runnerHeadSha: ticket.headSha || null,
    updateRef: ticket.status === 'testing' || ticket.status === 'done' ? (stack?.compositeSha || ticket.headSha || null) : null,
    updatedAt: new Date(),
  };
}

async function importBugReports({ config, store, log = () => {}, services = {} } = {}) {
  const settings = bugConfig(config);
  if (!settings) return { imported: 0, skipped: 0, failed: 0 };
  const firebase = services.firebase || {
    accessToken: () => accessToken({ command: settings.firebaseCommand, cwd: config.baseDir }),
    listNewReports,
    patchReport,
  };
  const token = await firebase.accessToken();
  const docs = await firebase.listNewReports(settings, { token });
  const result = { imported: 0, skipped: 0, failed: 0 };

  for (const doc of docs) {
    const report = doc.data || {};
    const projectKey = report.projectKey || report.app;
    const board = findProject(config, projectKey);
    if (!board) {
      await firebase.patchReport(settings, {
        token,
        docName: doc.name,
        updateTime: doc.updateTime,
        fields: { status: settings.statusBlocked, runnerError: `Unknown project "${projectKey || ''}"`, updatedAt: new Date() },
      });
      result.skipped += 1;
      continue;
    }

    let ticket;
    try {
      await firebase.patchReport(settings, {
        token,
        docName: doc.name,
        updateTime: doc.updateTime,
        fields: { status: settings.statusClaimed, runnerProject: board.key || board.app, claimedAt: new Date(), updatedAt: new Date() },
      });
      ticket = store.createLocalTicket({
        projectKey: board.key || board.app,
        kind: 'feature',
        title: titleOf(report, doc.id),
        body: reportBody(report, doc),
        status: 'queued',
        tracker: trackerKey(board),
        trackerMeta: {
          labels: settings.labels,
          source: 'firestore-bug-report',
          firestoreDoc: doc.name,
        },
        meta: {
          bugReport: {
            source: 'firestore',
            docName: doc.name,
            docId: doc.id,
            app: projectKey || '',
            base: 'integration',
            jsOnly: true,
          },
        },
      });
      try {
        await firebase.patchReport(settings, {
          token,
          docName: doc.name,
          fields: { runnerTicketId: ticket.shortId, updatedAt: new Date() },
        });
      } catch (error) {
        log(`imported app bug report ${doc.id}, but Firestore ticket id writeback failed: ${error.message}`);
      }
      log(`imported app bug report ${doc.id} as "${ticket.title}" (${ticket.shortId})`);
      result.imported += 1;
    } catch (error) {
      result.failed += 1;
      const fields = { status: settings.statusBlocked, runnerError: truncate(error.message, 1000), updatedAt: new Date() };
      try { await firebase.patchReport(settings, { token, docName: doc.name, fields }); } catch {}
      log(`failed to import app bug report ${doc.id}: ${error.message}`);
    }
  }
  return result;
}

async function syncBugReportStatuses({ config, store, log = () => {}, services = {} } = {}) {
  const settings = bugConfig(config);
  if (!settings || !store.listBugReportTickets) return { updated: 0, failed: 0 };
  const firebase = services.firebase || {
    accessToken: () => accessToken({ command: settings.firebaseCommand, cwd: config.baseDir }),
    patchReport,
  };
  const token = await firebase.accessToken();
  const tickets = store.listBugReportTickets();
  const result = { updated: 0, failed: 0 };
  for (const ticket of tickets) {
    const docName = ticket.meta?.bugReport?.docName;
    if (!docName) continue;
    try {
      await firebase.patchReport(settings, {
        token,
        docName,
        fields: updatePayloadForTicket(ticket, config, settings),
      });
      result.updated += 1;
    } catch (error) {
      result.failed += 1;
      log(`failed to sync bug report ${ticket.shortId}: ${error.message}`);
    }
  }
  return result;
}

module.exports = {
  bugConfig,
  firestoreFields,
  toFirestoreValue,
  importBugReports,
  syncBugReportStatuses,
  updatePayloadForTicket,
};
