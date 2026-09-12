/**
 * Staff created on the dashboard, reaching a till.
 *
 *   cd backend
 *   DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... \
 *     node scripts/run-script.js ../cloud/test/staff-downlink.js
 *
 * Uses its own branch (9005) and a throwaway copy of the till's database, so
 * the shop's data is untouched. It creates nothing outside that branch and
 * removes it at the end.
 *
 * The claim under test is the one the owner cares about and the one that was
 * broken: a manager created here can actually sign in at the till. Everything
 * else — the deactivation that used to do nothing, the PIN edit that used to
 * fail — is checked by the same route.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const PORT = 4387;
const CLOUD = `http://127.0.0.1:${PORT}/api`;
const TILL = 'http://127.0.0.1:3385/api';

const KEY = crypto.randomBytes(32).toString('hex');
const BRANCH = 9005;
// Its own dashboard account, created and deleted by this script. Borrowing the
// owner's real login would mean holding their password to run a test.
const TEST_EMAIL = `staff-test-${crypto.randomBytes(4).toString('hex')}@blaze.test`;
const TEST_PASSWORD = crypto.randomBytes(18).toString('hex');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-staff-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${PORT}`,
  branch_id: BRANCH, branch_name: 'Staff Test', api_key: KEY,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3385';

const cloudEnv = { ...process.env, PORT: String(PORT) };
delete cloudEnv.ELECTRON_RUN_AS_NODE;
delete cloudEnv.POS_USER_DATA_PATH;

function cloudExec(js) {
  const r = spawnSync('node', ['-e', js], { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloudExec failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

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
async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

let proc = null;
const stopCloud = () => { if (proc) { try { proc.kill(); } catch (e) {} proc = null; } };

(async () => {
 try {
  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    (async () => {
      await createSchema(db);
      await db.run(
        'INSERT INTO branches (id, name, code, api_key_hash) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, code = EXCLUDED.code, active = 1',
        [${BRANCH}, 'Staff Test', 'ST-Test', '${sha(KEY)}']);
      const bcrypt = require('bcryptjs');
      await db.run(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (email) DO NOTHING',
        ['${TEST_EMAIL}', await bcrypt.hash('${TEST_PASSWORD}', 10), 'Staff Downlink Test', 'owner']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!await waitFor(`${CLOUD}/health`)) { console.log('cloud would not start'); process.exit(1); }

  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const staffPull = require(path.join(TILL_ROOT, 'sync', 'staff-pull'));
  const T = (await tillCall('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;
  const signedIn = await cloudCall('POST', '/auth/login', {
    body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  if (signedIn.status !== 200) {
    console.log('could not sign in to the dashboard:', signedIn.body.error);
    process.exit(1);
  }

  console.log('=== THE OWNER CREATES A MANAGER ===');
  const made = await cloudCall('POST', '/staff', {
    body: { name: 'Test Manager', role: 'Manager', pin: '8642', color: '#2563EB', branch_id: BRANCH },
  });
  console.log(`   ${made.status} — id ${made.body.id}, ${made.body.note || made.body.error || ''}`);
  ok('the dashboard is allowed to create staff', made.status === 201);
  ok('and it lands in the cloud id band, clear of the till’s own numbering',
     Number(made.body.id) >= 10000);
  const NEW_ID = Number(made.body.id);

  const admin = await cloudCall('POST', '/staff', {
    body: { name: 'Nope', role: 'Admin', pin: '1111', branch_id: BRANCH } });
  ok('but not an administrator', admin.status === 400);

  const noBranch = await cloudCall('POST', '/staff', {
    body: { name: 'Nobody', role: 'Manager', pin: '2222' } });
  ok('and not without a branch', noBranch.status === 400);

  const badPin = await cloudCall('POST', '/staff', {
    body: { name: 'Shorty', role: 'Manager', pin: '12', branch_id: BRANCH } });
  ok('and not with a PIN the till could never accept', badPin.status === 400);

  console.log();
  console.log('=== NO PIN HASH EVER REACHES THE DASHBOARD ===');
  const list = await cloudCall('GET', `/staff?branch=${BRANCH}`);
  const listed = (list.body || []).find(s => Number(s.id) === NEW_ID);
  ok('the new manager is listed', Boolean(listed));
  ok('every row is free of a pin hash',
     JSON.stringify(list.body || []).toLowerCase().indexOf('pin_hash') === -1);
  ok('and free of any bcrypt hash at all',
     JSON.stringify(list.body || []).indexOf('$2') === -1);

  console.log();
  console.log('=== THE TILL PULLS THEM DOWN, AND THEY CAN SIGN IN ===');
  const pulled = await staffPull.pullIfNewer();
  console.log(`   ${JSON.stringify({ applied: pulled.applied, inserted: pulled.inserted, error: pulled.error })}`);
  ok('the till applied the roster', pulled.ok === true && pulled.applied === true);
  ok('adding the new manager', pulled.inserted >= 1);

  const signIn = await tillCall('POST', '/staff/login', null, { pin: '8642', staff_id: NEW_ID });
  console.log(`   sign-in: ${signIn.status} ${signIn.body.error || 'ok'}`);
  ok('and the PIN set on the dashboard works at the till', signIn.status === 200);

  const secondPull = await staffPull.pullIfNewer();
  ok('a second pull costs nothing — the version has not moved', secondPull.upToDate === true);

  console.log();
  console.log('=== CHANGING THE PIN ===');
  const rekey = await cloudCall('PUT', `/staff/${BRANCH}/${NEW_ID}`, { body: { pin: '9753' } });
  ok('the dashboard accepts a new PIN', rekey.status === 200);
  await staffPull.pullIfNewer();
  const oldPin = await tillCall('POST', '/staff/login', null, { pin: '8642', staff_id: NEW_ID });
  const newPin = await tillCall('POST', '/staff/login', null, { pin: '9753', staff_id: NEW_ID });
  ok('the old PIN stops working at the till', oldPin.status !== 200);
  ok('the new one works', newPin.status === 200);

  console.log();
  console.log('=== DEACTIVATING ===');
  const off = await cloudCall('PUT', `/staff/${BRANCH}/${NEW_ID}`, { body: { active: false } });
  ok('the dashboard accepts a deactivation', off.status === 200);
  await staffPull.pullIfNewer();
  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  const row = db.prepare('SELECT name, active FROM staff WHERE id = ?').get(NEW_ID);
  console.log(`   till: ${row && row.name} active=${row && row.active}`);
  ok('and the till marks them inactive', row && row.active === 0);
  const deadPin = await tillCall('POST', '/staff/login', null, { pin: '9753', staff_id: NEW_ID });
  ok('a deactivated manager cannot sign in', deadPin.status !== 200);

  console.log();
  console.log('=== A TILL PUSH DOES NOT UNDO THE OWNER ===');
  // The heart of "deactivate does nothing". The till still holds this person
  // and pushes them up as reference data; if that push overwrote the owner's
  // edit, the row would come back to life within thirty seconds.
  await cloudCall('POST', '/ingest/batch', {
    bearer: KEY,
    body: { table: 'staff', rows: [{ id: NEW_ID, name: 'Test Manager', role: 'Manager', color: '#2563EB', active: 1 }] },
  });
  const after = await cloudCall('GET', `/staff?branch=${BRANCH}`);
  const stillOff = (after.body || []).find(s => Number(s.id) === NEW_ID);
  console.log(`   cloud after the push: active=${stillOff && stillOff.active}, origin=${stillOff && stillOff.origin}`);
  ok('the deactivation survives the till’s own push', stillOff && Number(stillOff.active) === 0);

  console.log();
  console.log('=== DELETING FOR GOOD ===');
  // Reactivated first: the route refuses to remove the last active account at
  // a branch, and that guard would otherwise be what this section measured.
  await cloudCall('PUT', `/staff/${BRANCH}/${NEW_ID}`, { body: { active: true } });
  await cloudCall('POST', '/staff', {
    body: { name: 'Stays Behind', role: 'Manager', pin: '5150', branch_id: BRANCH } });

  const del = await cloudCall('DELETE', `/staff/${BRANCH}/${NEW_ID}`);
  console.log(`   ${del.status} ${del.body.note || del.body.error || ''}`);
  ok('the owner can delete a staff account', del.status === 200);

  const listAfter = await cloudCall('GET', `/staff?branch=${BRANCH}`);
  ok('and they are gone from the cloud',
     !(listAfter.body || []).some(s2 => Number(s2.id) === NEW_ID));

  // The whole reason for the tombstone table: the till pushes its staff list
  // every five minutes and knows nothing about the deletion until it pulls.
  await cloudCall('POST', '/ingest/batch', {
    bearer: KEY,
    body: { table: 'staff', rows: [{ id: NEW_ID, name: 'Test Manager', role: 'Manager', color: '#2563EB', active: 1 }] },
  });
  const afterPush = await cloudCall('GET', `/staff?branch=${BRANCH}`);
  ok('and the till pushing them back does not resurrect them',
     !(afterPush.body || []).some(s2 => Number(s2.id) === NEW_ID));

  const pulledDelete = await staffPull.pullIfNewer();
  console.log(`   till: ${JSON.stringify({ deleted: pulledDelete.deleted, applied: pulledDelete.applied })}`);
  ok('the till removes them too', pulledDelete.deleted >= 1);

  const goneRow = db.prepare('SELECT id FROM staff WHERE id = ?').get(NEW_ID);
  ok('so the row is off that machine', !goneRow);
  const cannotSignIn = await tillCall('POST', '/staff/login', null, { pin: '9753', staff_id: NEW_ID });
  ok('and their PIN no longer signs in anywhere', cannotSignIn.status !== 200);

  // History is the thing deletion must not damage.
  const stillNamed = db.prepare(
    'SELECT COUNT(*) n FROM orders WHERE cashier_name IS NOT NULL').get().n;
  ok('past orders still name whoever took them', stillNamed > 0);

  console.log();
  console.log('=== ONE BRANCH KEY CANNOT READ ANOTHER BRANCH’S PINS ===');
  const snap = await cloudCall('GET', '/staff/snapshot', { bearer: KEY });
  ok('the snapshot answers this branch', snap.status === 200 && Number(snap.body.branch_id) === BRANCH);
  ok('and holds nobody from any other branch',
     (snap.body.staff || []).length === (after.body || []).length);
  const anon = await cloudCall('GET', '/staff/snapshot', { bearer: 'not-a-real-key' });
  ok('an unrecognised key gets nothing', anon.status === 401);

  console.log();
  console.log('=== THE PERFORMANCE TAB’S FIELD NAMES ===');
  const today = new Date().toLocaleDateString('en-CA');
  const perf = await cloudCall('GET', `/staff/performance?from=2026-01-01&to=${today}&branch=${BRANCH}`);
  const first = (perf.body || [])[0];
  console.log(`   ${first && first.name}: total_orders=${first && first.total_orders}, ` +
              `total_revenue=${first && first.total_revenue}, busiest_hour=${first && first.busiest_hour}`);
  ok('rows come back', Array.isArray(perf.body) && perf.body.length > 0);
  // The bug: the screen reads these four names and the route used to answer
  // `orders`/`revenue`, so every figure rendered as zero.
  ok('under the names the Staff screen reads',
     first && ['total_orders', 'total_revenue', 'avg_order_value', 'total_discounts', 'busiest_hour']
       .every(k => k in first));
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      "  for (const t of ['live_status','order_items','orders','shifts','expenses','staff','staff_deletions','ingredients','customers','sync_cursor']) {",
      `    try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [${BRANCH}]); } catch (e) {}`,
      '  }',
      `  await db.run('DELETE FROM branches WHERE id = ?', [${BRANCH}]);`,
      `  await db.run('DELETE FROM users WHERE email = ?', ['${TEST_EMAIL}']);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(test branch removed)');
  } catch (e) {
    console.error('\nCOULD NOT REMOVE THE TEST BRANCH:', e.message);
  }
  stopCloud();
  try { fs.rmSync(tillDir, { recursive: true, force: true }); } catch (e) {}
  console.log('(till copy removed)');
  process.exit(0);
 }
})();
