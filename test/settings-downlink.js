/**
 * Shop-wide settings, edited on the dashboard, reaching a till.
 *
 *   cd backend
 *   DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... \
 *     node scripts/run-script.js ../cloud/test/settings-downlink.js
 *
 * The thing genuinely worth proving is not that a tax rate arrives. It is that
 * a branch's *own* settings survive it. The tills keep shop-wide and per-branch
 * values in one flat key/value table, so a snapshot applied carelessly would
 * give both branches the same printed address, the same delivery charge and the
 * same receipt footer — quietly, and visible only on a printed receipt.
 *
 * Uses its own branch and a throwaway copy of the till's database, so it leaves
 * the shop's data alone.
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
const TILL = 'http://127.0.0.1:3387/api';

const KEY = crypto.randomBytes(32).toString('hex');
const TEST_BRANCH_ID = 9002;
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-set-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${PORT}`,
  branch_id: TEST_BRANCH_ID, branch_name: 'Settings Test Branch', api_key: KEY,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3387';

const cloudEnv = { ...process.env, PORT: String(PORT) };
delete cloudEnv.ELECTRON_RUN_AS_NODE;
delete cloudEnv.POS_USER_DATA_PATH;

function cloudExec(js) {
  const r = spawnSync('node', ['-e', js], { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloudExec failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

let cookie = null;
async function cloudCall(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(CLOUD + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
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
const startCloud = () => {
  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  return waitFor(`${CLOUD}/health`);
};
const stopCloud = () => { if (proc) { try { proc.kill(); } catch (e) {} proc = null; } };

(async () => {
 try {
  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    (async () => {
      await createSchema(db);
      await db.run(
        'INSERT INTO branches (id, name, api_key_hash) VALUES (?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
        [${TEST_BRANCH_ID}, 'Settings Test Branch', '${sha(KEY)}']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  if (!await startCloud()) { console.log('cloud would not start'); process.exit(1); }
  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  const settingsPull = require(path.join(TILL_ROOT, 'sync', 'settings-pull'));
  await cloudCall('POST', '/auth/login', {
    email: process.env.DASH_EMAIL, password: process.env.DASH_PASSWORD });

  const get = (k) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : null;
  };
  const set = (k, v) => db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(k, v);

  // This branch's own settings, as a real shop would have them.
  set('restaurant_address', 'Plot 42, E-18 Sector, Islamabad');
  set('receipt_footer', 'Thank you from E-18!');
  set('delivery_price', '150');
  set('paper_size', '80mm');

  console.log('=== THE DASHBOARD OFFERS ONLY SHOP-WIDE SETTINGS ===');
  const form = await cloudCall('GET', '/settings');
  ok('settings load', form.status === 200);
  const offered = (form.body.fields || []).map(f => f.key);
  console.log('   offered:', offered.join(', '));
  ok('it offers the shop-wide ones', offered.includes('tax_rate') && offered.includes('currency_symbol'));
  ok('and never a branch-owned one',
     !offered.some(k => ['delivery_price', 'receipt_footer', 'restaurant_address', 'paper_size'].includes(k)));
  ok('it names what it does not control', (form.body.branch_owned || []).includes('delivery_price'));

  console.log();
  console.log('=== A CHANGE REACHES THE TILL ===');
  const saved = await cloudCall('PUT', '/settings', {
    tax_rate: '7.5', employee_discount_rate: '25', currency_symbol: 'PKR',
  });
  ok('the dashboard can save', saved.status === 200);
  ok('and the version moves', Number(saved.body.version) > 0);

  const applied = await settingsPull.pullIfNewer();
  console.log(`   till: tax_rate=${get('tax_rate')}, staff discount=${get('employee_discount_rate')}, currency=${get('currency_symbol')}`);
  ok('the till applied it', applied.ok === true && applied.applied === true);
  ok('tax rate arrived', get('tax_rate') === '7.5');
  ok('staff discount arrived', get('employee_discount_rate') === '25');
  ok('currency arrived', get('currency_symbol') === 'PKR');

  console.log();
  console.log("=== THE BRANCH'S OWN SETTINGS SURVIVED ===");
  console.log(`   address="${get('restaurant_address')}" delivery=${get('delivery_price')} paper=${get('paper_size')}`);
  ok('its printed address is untouched', get('restaurant_address') === 'Plot 42, E-18 Sector, Islamabad');
  ok('its receipt footer is untouched', get('receipt_footer') === 'Thank you from E-18!');
  ok('its delivery charge is untouched', get('delivery_price') === '150');
  ok('its paper size is untouched', get('paper_size') === '80mm');

  console.log();
  console.log('=== THE CLOUD REFUSES BRANCH-OWNED KEYS ===');
  const sneaky = await cloudCall('PUT', '/settings', { delivery_price: '999', paper_size: '58mm' });
  ok('a branch-owned key alone is rejected', sneaky.status === 400);

  const mixed = await cloudCall('PUT', '/settings', { tax_rate: '9', delivery_price: '999' });
  ok('a mixed request saves only the shop-wide part',
     mixed.status === 200 && (mixed.body.updated || []).length === 1 && mixed.body.updated[0] === 'tax_rate');
  await settingsPull.pullIfNewer();
  ok('so the branch keeps its delivery charge', get('delivery_price') === '150');
  ok('while the new tax rate did arrive', get('tax_rate') === '9');

  console.log();
  console.log('=== NOTHING CHANGED MEANS NOTHING HAPPENS ===');
  const again = await settingsPull.pullIfNewer();
  ok('a second pull is a no-op', again.ok === true && again.upToDate === true);

  console.log();
  console.log('=== WITH NO CONNECTION THE TILL KEEPS ITS SETTINGS ===');
  stopCloud();
  await new Promise(r => setTimeout(r, 300));
  const offline = await settingsPull.pullIfNewer();
  ok('the pull fails quietly', offline.ok === false);
  ok('and settings are unchanged', get('tax_rate') === '9' && get('delivery_price') === '150');
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      "  for (const t of ['live_status','order_items','orders','shifts','expenses','staff','ingredients','sync_cursor']) {",
      `    try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [${TEST_BRANCH_ID}]); } catch (e) {}`,
      '  }',
      `  await db.run('DELETE FROM branches WHERE id = ?', [${TEST_BRANCH_ID}]);`,
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
