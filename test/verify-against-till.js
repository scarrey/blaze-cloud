/**
 * Verify the cloud against the till.
 *
 *   cd backend
 *   DATABASE_URL=... node scripts/run-script.js ../cloud/test/verify-against-till.js
 *
 * Run this after ANY change to either backend/routes/reports.js or
 * cloud/routes/reports.js. It is the only thing standing between a dialect
 * edit and a report that quietly returns different numbers.
 *
 * It TRUNCATES the cloud database, so point DATABASE_URL at a scratch project
 * rather than production.
 *
 * The claim under test: **the cloud's reports return exactly what the till's do
 * for the same data.** The Postgres translation is where that could quietly
 * stop being true — a rewritten query that still runs and returns a different
 * number is the failure that never announces itself.
 *
 * Cloud runs as a child process on plain Node, till here on Electron's, as in
 * production. Cloud data is wiped first so the comparison starts from nothing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
// The till half is required directly into this process, which is running on
// Electron's Node — the only runtime whose ABI matches better-sqlite3.
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const CLOUD_PORT = 4394;
const CLOUD = `http://127.0.0.1:${CLOUD_PORT}/api`;
const TILL = 'http://127.0.0.1:3390/api';

const KEY_1 = crypto.randomBytes(32).toString('hex');
const KEY_2 = crypto.randomBytes(32).toString('hex');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const PW = 'owner-password-long';

if (!process.env.DATABASE_URL) {
  console.log('DATABASE_URL is not set.');
  process.exit(1);
}

const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-till-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${CLOUD_PORT}`,
  branch_id: 1, branch_name: 'E-18 Branch', api_key: KEY_1,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3390';

const cloudEnv = { ...process.env, PORT: String(CLOUD_PORT) };
delete cloudEnv.ELECTRON_RUN_AS_NODE;
delete cloudEnv.POS_USER_DATA_PATH;

function cloudExec(js) {
  const r = spawnSync('node', ['-e', js], { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloudExec failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}
const cloudQuery = (sql) => JSON.parse(cloudExec(`
  const db = require('./db/pg');
  db.q(${JSON.stringify(sql)}).then(async rows => {
    console.log(JSON.stringify(rows));
    await db.close();
  }).catch(async e => { console.error(e.message); process.exit(1); });
`));

let cookie = null;
async function cloudCall(method, p, { body, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  else if (cookie) headers.Cookie = cookie;
  const r = await fetch(CLOUD + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function tillCall(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(TILL + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

let cloudProc = null;
const startCloud = () => {
  // stderr inherited: a failure to reach Supabase must be visible, not silent.
  cloudProc = spawn('node', ['server.js'], {
    cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'],
  });
  // Generous: the schema is applied on boot, and this link to Singapore is slow.
  return waitFor(`${CLOUD}/health`, 200);
};
const stopCloud = () => { if (cloudProc) { try { cloudProc.kill(); } catch (e) {} cloudProc = null; } };

/** Report the first differing field, not just "not equal". */
function diff(a, b, label) {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
    return `${label}: ${a.length} rows on the till, ${b.length} on the cloud`;
  }
  if (Array.isArray(a)) {
    for (let i = 0; i < a.length; i++) {
      for (const k of Object.keys(a[i])) {
        if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i]?.[k])) {
          return `${label}: row ${i} "${k}" — till ${JSON.stringify(a[i][k])}, cloud ${JSON.stringify(b[i]?.[k])}`;
        }
      }
    }
  } else {
    for (const k of Object.keys(a || {})) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b?.[k])) {
        return `${label}: "${k}" — till ${JSON.stringify(a[k])}, cloud ${JSON.stringify(b?.[k])}`;
      }
    }
  }
  return `${label}: differ`;
}

(async () => {
 try {
  await require('./guard').requireScratchDatabase('every synced table, and the branches and accounts');

  console.log('=== FRESH CLOUD ===');
  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    const bcrypt = require('bcryptjs');
    (async () => {
      await createSchema(db);
      // Wipe: this is a verification run, and a comparison against leftovers
      // from a previous run would prove nothing.
      await db.run('TRUNCATE order_items, orders, shifts, expenses, staff, ingredients, live_status, sync_cursor, sessions, users, branches RESTART IDENTITY CASCADE');
      await db.run('INSERT INTO branches (id,name,api_key_hash) VALUES (?,?,?)', [1,'E-18 Branch','${sha(KEY_1)}']);
      await db.run('INSERT INTO branches (id,name,api_key_hash) VALUES (?,?,?)', [2,'CBR Town Branch','${sha(KEY_2)}']);
      await db.run('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)',
        ['owner@blaze.com', bcrypt.hashSync(${JSON.stringify(PW)}, 10), 'Owner', 'owner']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);
  ok('schema applied and seeded on Supabase', true);

  if (!await startCloud()) { console.log('cloud would not start'); process.exit(1); }
  ok('the cloud server starts against Supabase', true);

  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  const localOrders = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
  const localItems = db.prepare('SELECT COUNT(*) n FROM order_items').get().n;

  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const push = require(path.join(TILL_ROOT, 'sync', 'push'));
  const T = (await tillCall('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;

  async function syncUntilDone() {
    for (let i = 0; i < 120; i++) {
      const res = await push.syncAll();
      if (res.skipped !== 'already running') return res;
      await new Promise(r => setTimeout(r, 300));
    }
    return { ok: false };
  }

  console.log();
  console.log('=== SYNC UP ===');
  const synced = await syncUntilDone();
  if (!synced.ok) console.log('   error:', JSON.stringify(synced));
  ok('the whole history reaches Supabase', synced.ok === true && push.status().queue_depth === 0);
  const cloudOrders = cloudQuery('SELECT COUNT(*)::int AS n FROM orders')[0].n;
  const cloudItems = cloudQuery('SELECT COUNT(*)::int AS n FROM order_items')[0].n;
  console.log(`   till ${localOrders} orders / ${localItems} items -> cloud ${cloudOrders} / ${cloudItems}`);
  ok('every order arrived', cloudOrders === localOrders);
  ok('every line item arrived', cloudItems === localItems);
  ok('staff and stock arrived too',
     cloudQuery('SELECT COUNT(*)::int AS n FROM staff')[0].n > 0 &&
     cloudQuery('SELECT COUNT(*)::int AS n FROM ingredients')[0].n > 0);

  console.log();
  console.log('=== REPORTS MATCH THE TILL, FIELD BY FIELD ===');
  await cloudCall('POST', '/auth/login', { body: { email: 'owner@blaze.com', password: PW } });

  const RANGE = 'from=2026-01-01&to=2026-12-31';
  const ENDPOINTS = ['kpi', 'revenue-over-time', 'top-items', 'by-category',
    'hourly-heatmap', 'cashier-performance', 'detailed', 'line-items',
    'expenses-by-category', 'expenses-detail', 'daily'];

  const mismatches = [];
  for (const ep of ENDPOINTS) {
    const t = await tillCall('GET', `/reports/${ep}?${RANGE}`, T);
    const c = await cloudCall('GET', `/reports/${ep}?${RANGE}`);
    if (t.status !== 200 || c.status !== 200) {
      mismatches.push(`${ep}: till ${t.status}, cloud ${c.status} ${JSON.stringify(c.body).slice(0, 90)}`);
      continue;
    }
    // branch_name legitimately differs: this till's own rows predate branch
    // stamping, whereas the sync attributes everything to its API key's branch.
    const strip = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === 'branch_name' ? undefined : val)));
    const d = diff(strip(t.body), strip(c.body), ep);
    if (d) mismatches.push(d);
    else console.log(`   ${ep.padEnd(22)} identical (${Array.isArray(t.body) ? t.body.length + ' rows' : 'summary'})`);
  }
  mismatches.forEach(m => console.log('   MISMATCH ' + m));
  ok('every report endpoint returns identical output', mismatches.length === 0);

  console.log();
  console.log('=== TYPES SURVIVED THE PORT ===');
  const k = (await cloudCall('GET', `/reports/kpi?${RANGE}`)).body;
  console.log(`   ${k.total_orders} orders, revenue ${k.total_revenue}, net ${k.net_revenue}`);
  ok('counts are numbers, not strings', typeof k.total_orders === 'number');
  ok('money is a number, not a string', typeof k.total_revenue === 'number');
  const daily = (await cloudCall('GET', `/reports/daily?${RANGE}`)).body;
  ok('dates are plain YYYY-MM-DD, not ISO timestamps',
     daily.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(daily[0].date)));
  console.log(`   first daily row date: ${daily[0] && daily[0].date}`);
  const hourly = (await cloudCall('GET', `/reports/revenue-over-time?${RANGE}&groupBy=hour`)).body;
  ok('the hourly bucket groups without error', Array.isArray(hourly));

  console.log();
  console.log('=== IDEMPOTENCY AND ID COLLISION ===');
  const sample = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 3').all()
    .map(o => ({ ...o, items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id) }));
  for (let i = 0; i < 3; i++) {
    await cloudCall('POST', '/ingest/batch', { bearer: KEY_1, body: { table: 'orders', rows: sample } });
  }
  ok('replaying a batch three times changes nothing',
     cloudQuery('SELECT COUNT(*)::int AS n FROM orders')[0].n === cloudOrders);

  await cloudCall('POST', '/ingest/batch', {
    bearer: KEY_2,
    body: { table: 'orders', rows: [{
      id: 1, total: 4242, status: 'completed', payment_method: 'Cash',
      cashier_name: 'CBR Manager', created_at: '2026-09-07 12:00:00',
      items: [{ id: 1, name: 'CBR Pizza', price: 4242, quantity: 1, is_deal: 0, category: 'Regular Pizza' }],
    }] },
  });
  const both = cloudQuery('SELECT branch_id, total FROM orders WHERE local_id = 1 ORDER BY branch_id');
  console.log('   order #1 at each branch:', both.map(o => `b${o.branch_id}=${o.total}`).join(', '));
  ok('both branches keep their own order #1', both.length === 2);
  ok("CBR's item joined to CBR's order", cloudQuery(`
    SELECT o.branch_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.branch_id = 2 AND oi.local_id = 1`)[0].branch_id === 2);

  console.log();
  console.log('=== LIVE HEARTBEAT ===');
  const hb = require(path.join(TILL_ROOT, 'sync', 'heartbeat'));
  ok('a heartbeat reaches Supabase', (await hb.pushOnce()).ok === true);
  const live = (await cloudCall('GET', '/live')).body;
  const e18 = live.branches.find(b => b.branch_id === 1);
  ok('the branch reads as live', e18 && e18.freshness === 'live');
  ok('a branch that never reported says so',
     live.branches.find(b => b.branch_id === 2).freshness === 'never');
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  stopCloud();
  try { fs.rmSync(tillDir, { recursive: true, force: true }); } catch (e) {}
  console.log('\n(till copy removed; Supabase left as-is for inspection)');
  process.exit(0);
 }
})();
