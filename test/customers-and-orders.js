/**
 * The dashboard's Customers and Orders screens.
 *
 *   cd backend
 *   DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... \
 *     node scripts/run-script.js ../cloud/test/customers-and-orders.js
 *
 * Uses its own branch and a throwaway copy of the till's database, so the
 * shop's data is untouched.
 *
 * The claim under test for customers is the one the owner actually cares about:
 * a household that orders again next week must add to its own count rather than
 * appear twice — including when the two orders came from different branches.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const PORT = 4386;
const CLOUD = `http://127.0.0.1:${PORT}/api`;
const TILL = 'http://127.0.0.1:3384/api';

const KEY = crypto.randomBytes(32).toString('hex');
const BRANCH_A = 9003;
const BRANCH_B = 9004;
const KEY_B = crypto.randomBytes(32).toString('hex');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-cust-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${PORT}`,
  branch_id: BRANCH_A, branch_name: 'Cust Test A', api_key: KEY,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3384';

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
      const add = (id, name, hash) => db.run(
        'INSERT INTO branches (id, name, api_key_hash) VALUES (?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
        [id, name, hash]);
      await add(${BRANCH_A}, 'Cust Test A', '${sha(KEY)}');
      await add(${BRANCH_B}, 'Cust Test B', '${sha(KEY_B)}');
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!await waitFor(`${CLOUD}/health`)) { console.log('cloud would not start'); process.exit(1); }

  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  const push = require(path.join(TILL_ROOT, 'sync', 'push'));
  const T = (await tillCall('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;
  await cloudCall('POST', '/auth/login', {
    body: { email: process.env.DASH_EMAIL, password: process.env.DASH_PASSWORD } });

  // A shift is now required before an order can be taken.
  const cur = (await tillCall('GET', '/shifts/current', T)).body;
  if (cur && cur.id) await tillCall('POST', '/shifts/close', T, { closing_cash: 0 });
  await tillCall('POST', '/shifts/open', T, { opening_cash: 1000 });

  console.log('=== A RETURNING CUSTOMER IS NOT DUPLICATED ===');
  const PHONE = '0300-7654321';
  const deliver = (name, phone, address) => tillCall('POST', '/orders', T, {
    items: [{ id: 1, name: 'Zinger', price: 600, quantity: 1 }],
    order_type: 'Delivery', delivery_charge: 100, payment_method: 'Cash',
    customer_name: name, customer_phone: phone, customer_address: address,
  });

  await deliver('Sana Iqbal', PHONE, 'House 9, Street 3, F-10');
  // A week later, same person, phone typed without the dash.
  await deliver('Sana Iqbal', '03007654321', null);

  const local = db.prepare(
    'SELECT name, phone, address, order_count FROM customers WHERE phone = ?').get('03007654321');
  console.log(`   till: ${local.name} | ${local.phone} | ${local.order_count} orders`);
  ok('the till counted them once, twice over', local && local.order_count === 2);
  ok('and kept the address from the first order', local.address === 'House 9, Street 3, F-10');

  console.log();
  console.log('=== THEY REACH THE DASHBOARD ===');
  for (let i = 0; i < 40; i++) {
    const r = await push.syncAll();
    if (r.skipped !== 'already running') break;
    await new Promise(r2 => setTimeout(r2, 250));
  }
  const list = (await cloudCall('GET', `/customers?branch=${BRANCH_A}`)).body;
  const sana = (list.customers || []).find(c => c.phone && c.phone.includes('7654321'));
  console.log(`   cloud: ${sana && sana.name} | ${sana && sana.order_count} orders | ${sana && sana.total_spent}`);
  ok('the customer synced up', Boolean(sana));
  ok('with their order count', sana && sana.order_count === 2);
  ok('and what they have spent', sana && Number(sana.total_spent) > 0);
  ok('the address is there for the rider', sana && /F-10/.test(sana.address || ''));

  console.log();
  console.log('=== ONE HOUSEHOLD, TWO BRANCHES, ONE ROW ===');
  // The other branch files the same phone number as its own customer.
  await cloudCall('POST', '/ingest/batch', {
    bearer: KEY_B,
    body: { table: 'customers', rows: [{
      id: 1, name: 'Sana Iqbal', phone: '03007654321', address: 'Office, Blue Area',
      order_count: 3, total_spent: 4200,
      first_order_at: '2026-09-01 12:00:00', last_order_at: '2026-09-06 20:00:00',
    }] },
  });
  const all = (await cloudCall('GET', '/customers')).body;
  const merged = (all.customers || []).filter(c => c.phone && c.phone.includes('7654321'));
  console.log(`   rows for that number: ${merged.length}, total orders ${merged[0] && merged[0].order_count}`);
  ok('they appear once, not twice', merged.length === 1);
  ok('with both branches’ orders summed', merged[0] && merged[0].order_count === 5);
  ok('and both branches named', merged[0] && (merged[0].branch_count === 2));

  console.log();
  console.log('=== TOTALS THE SCREEN SHOWS ===');
  console.log(`   ${all.totals.customers} customers, ${all.totals.orders} orders, ${all.totals.returning} returning`);
  ok('a returning-customer count is offered', typeof all.totals.returning === 'number');
  ok('and counts only those who came back', all.totals.returning >= 1);

  console.log();
  console.log('=== THE ORDERS SCREEN ===');
  const today = new Date().toLocaleDateString('en-CA');
  const P = `from=2026-01-01&to=${today}`;
  const orders = (await cloudCall('GET', `/reports/detailed?${P}&include_voided=1&branch=${BRANCH_A}`)).body;
  ok('orders load for one branch', Array.isArray(orders) && orders.length > 0);
  ok('each carries its branch', orders.every(o => o.branch_name === 'Cust Test A'));
  ok('and the delivery customer for the row', orders.some(o => o.customer_name === 'Sana Iqbal'));

  const voidedCount = orders.filter(o => o.status === 'voided').length;
  const withoutVoided = (await cloudCall('GET', `/reports/detailed?${P}&branch=${BRANCH_A}`)).body;
  ok('include_voided actually includes them',
     orders.length === withoutVoided.length + voidedCount);
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      "  for (const t of ['live_status','order_items','orders','shifts','expenses','staff','ingredients','customers','sync_cursor']) {",
      `    for (const id of [${BRANCH_A}, ${BRANCH_B}]) {`,
      "      try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [id]); } catch (e) {}",
      '    }',
      '  }',
      `  await db.run('DELETE FROM branches WHERE id IN (?, ?)', [${BRANCH_A}, ${BRANCH_B}]);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(test branches removed)');
  } catch (e) {
    console.error('\nCOULD NOT REMOVE THE TEST BRANCHES:', e.message);
  }
  stopCloud();
  try { fs.rmSync(tillDir, { recursive: true, force: true }); } catch (e) {}
  console.log('(till copy removed)');
  process.exit(0);
 }
})();
