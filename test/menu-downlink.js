/**
 * The menu, edited on the dashboard, reaching a till.
 *
 *   cd backend
 *   DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... \
 *     node scripts/run-script.js ../cloud/test/menu-downlink.js
 *
 * The only part of this system that travels downward, and the only part that
 * can break a till that is trading. So the things worth proving are not that it
 * works when everything is fine, but that it cannot half-work:
 *
 *   - a shop with no connection keeps selling from the menu it has
 *   - a menu never arrives partially applied
 *   - an item retired upstream stops being sold but still resolves in reports
 *   - a paired till refuses local menu edits, rather than accepting one that
 *     would silently vanish at the next snapshot
 *
 * Uses a throwaway copy of the till's database. The cloud's menu tables are
 * written to, so point DATABASE_URL at a scratch project.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const PORT = 4391;
const CLOUD = `http://127.0.0.1:${PORT}/api`;
const TILL = 'http://127.0.0.1:3388/api';

const KEY = crypto.randomBytes(32).toString('hex');
/** High enough that it cannot collide with a real shop's branch ids. */
const TEST_BRANCH_ID = 9001;
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');

const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-menu-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${PORT}`,
  /*
   * A branch of this test's own, not one of the shop's.
   *
   * An earlier version re-keyed branch 1 so it could drive a till, and never
   * put the real key back — which unpaired the actual shop and left it
   * reporting "cloud rejected this branch key" against a cloud-sync.json that
   * was plainly correct. Save-and-restore would have worked until the test
   * crashed halfway. Not touching the shop's branches at all is simpler and
   * cannot fail that way.
   */
  branch_id: TEST_BRANCH_ID, branch_name: 'Menu Test Branch', api_key: KEY,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3388';

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
const startCloud = () => {
  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  return waitFor(`${CLOUD}/health`);
};
const stopCloud = () => { if (proc) { try { proc.kill(); } catch (e) {} proc = null; } };

(async () => {
 try {
  await require('./guard').requireScratchDatabase('the cloud menu');

  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    const bcrypt = require('bcryptjs');
    (async () => {
      await createSchema(db);
      await db.run('TRUNCATE deal_items, deals, item_variants, menu_items RESTART IDENTITY CASCADE');
      await db.run(
        'INSERT INTO branches (id, name, api_key_hash) VALUES (?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
        [${TEST_BRANCH_ID}, 'Menu Test Branch', '${sha(KEY)}']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  // Import the shop's menu, exactly as the operator would.
  const imported = spawnSync('node', ['scripts/import-menu.js'],
    { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  console.log('  ' + (imported.stdout || imported.stderr).trim().split('\n')[0]);

  if (!await startCloud()) { console.log('cloud would not start'); process.exit(1); }
  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  const menuPull = require(path.join(TILL_ROOT, 'sync', 'menu-pull'));
  const T = (await tillCall('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;
  const email = process.env.DASH_EMAIL, password = process.env.DASH_PASSWORD;
  await cloudCall('POST', '/auth/login', { body: { email, password } });

  console.log();
  console.log('=== THE CLOUD OWNS A MENU ===');
  const cloudMenu = (await cloudCall('GET', '/menu')).body;
  const cloudDeals = (await cloudCall('GET', '/deals')).body;
  console.log(`   ${cloudMenu.length} items, ${cloudDeals.length} deals on the cloud`);
  ok('the menu imported', cloudMenu.length > 0 && cloudDeals.length > 0);
  ok('deals carry their lines', cloudDeals.some(d => (d.items || []).length > 0));

  console.log();
  console.log('=== A TILL PULLS IT ===');
  /*
   * Rewind the recorded version first.
   *
   * Starting the till fires a heartbeat, whose response carries the menu
   * version — so by the time the test asks, the pull has usually already
   * happened and there is nothing left to observe. Rewinding makes this assert
   * the download rather than the race.
   */
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('cloud_menu_version', '0')
    ON CONFLICT(key) DO UPDATE SET value = '0'
  `).run();
  const before = menuPull.localVersion();
  const pulled = await menuPull.pullIfNewer();
  const localItems = db.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n;
  console.log(`   till menu version ${before} -> ${menuPull.localVersion()}, ${localItems} live items`);
  ok('the till applied the cloud menu', pulled.ok === true && pulled.applied === true);
  ok('it now sells what the cloud holds', localItems === cloudMenu.length);

  console.log();
  console.log('=== NOTHING HAPPENS WHEN NOTHING CHANGED ===');
  const again = await menuPull.pullIfNewer();
  ok('a second pull is a no-op', again.ok === true && again.upToDate === true);

  console.log();
  console.log('=== AN EDIT ON THE DASHBOARD REACHES THE TILL ===');
  const target = cloudMenu.find(m => !m.has_variants) || cloudMenu[0];
  const newPrice = Math.round((Number(target.price) || 100) + 77);
  const edit = await cloudCall('PUT', `/menu/${target.id}`, { body: { price: newPrice } });
  ok('the dashboard can edit the menu', edit.status === 200);
  ok('and the version moved', Number(edit.body.menu_version) > before);

  const applied = await menuPull.pullIfNewer();
  const localPrice = db.prepare(
    'SELECT price FROM menu_items WHERE name = ? AND active = 1').get(target.name);
  console.log(`   "${target.name}" ${target.price} -> ${newPrice}; till now has ${localPrice && localPrice.price}`);
  ok('the till picked the change up', applied.applied === true);
  ok('and sells at the new price', localPrice && Number(localPrice.price) === newPrice);

  console.log();
  console.log('=== RETIRING AN ITEM DOES NOT REWRITE HISTORY ===');
  const soldBefore = db.prepare(`
    SELECT COUNT(*) n FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE oi.is_deal = 0`).get().n;
  await cloudCall('DELETE', `/menu/${target.id}`);
  await menuPull.pullIfNewer();
  const stillLive = db.prepare(
    'SELECT COUNT(*) n FROM menu_items WHERE name = ? AND active = 1').get(target.name).n;
  const soldAfter = db.prepare(`
    SELECT COUNT(*) n FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
     WHERE oi.is_deal = 0`).get().n;
  ok('the retired item stops being sold', stillLive === 0);
  ok('past orders still resolve to a menu item', soldAfter === soldBefore);

  console.log();
  console.log('=== A PAIRED TILL REFUSES LOCAL MENU EDITS ===');
  const localEdit = await tillCall('POST', '/menu', T, { name: 'Sneaky Item', category: 'Burger', price: 1 });
  ok('the till refuses the write', localEdit.status === 409);
  ok('and says where the menu lives', /dashboard/i.test(localEdit.body.error || ''));
  const localDeal = await tillCall('POST', '/deals', T, { name: 'Sneaky Deal', price: 1 });
  ok('deals too', localDeal.status === 409);
  ok('reading the menu still works', (await tillCall('GET', '/menu', T)).status === 200);

  console.log();
  console.log('=== WITH NO CONNECTION, THE SHOP KEEPS SELLING ===');
  stopCloud();
  await new Promise(r => setTimeout(r, 300));

  const versionBefore = menuPull.localVersion();
  const itemsBefore = db.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n;
  const offline = await menuPull.pullIfNewer();
  ok('the pull fails quietly rather than throwing', offline.ok === false);
  ok('the menu is untouched', db.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n === itemsBefore);
  ok('the recorded version is unchanged', menuPull.localVersion() === versionBefore);

  const t0 = Date.now();
  const sale = await tillCall('POST', '/orders', T, {
    items: [{ id: 1, name: 'Zinger', price: 500, quantity: 1 }], payment_method: 'Cash' });
  ok(`a sale still completes (${Date.now() - t0}ms)`, sale.status === 201);

  console.log();
  console.log('=== AN EMPTY MENU IS REFUSED ===');
  await startCloud();
  cloudExec(`
    const db = require('./db/pg');
    (async () => {
      await db.run('UPDATE menu_items SET active = 0');
      await db.run('UPDATE menu_version SET version = version + 1 WHERE id = 1');
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);
  const empty = await menuPull.pullIfNewer();
  const survived = db.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n;
  console.log(`   cloud went empty; till still has ${survived} live items`);
  ok('an empty menu is refused rather than applied', empty.ok === false);
  ok('so the shop is not left with nothing to sell', survived === itemsBefore);
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  /*
   * Put the menu back before leaving.
   *
   * The last section retires every item to prove an empty menu is refused, and
   * leaving it that way blanks the dashboard's Menu tab — while import-menu.js
   * refuses to help, because a menu does technically exist. Also drops this
   * test's own branch so it does not appear in the dashboard's branch list.
   */
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      "  await db.run('UPDATE menu_items SET active = 1');",
      "  await db.run('UPDATE menu_version SET version = version + 1 WHERE id = 1');",
      // In dependency order. The test's own heartbeat leaves a live_status row,
      // whose foreign key blocks deleting the branch — which failed silently
      // the first time and left a phantom branch in the dashboard's list.
      "  for (const t of ['live_status','order_items','orders','shifts','expenses','staff','ingredients','sync_cursor']) {",
      `    try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [${TEST_BRANCH_ID}]); } catch (e) {}`,
      '  }',
      `  await db.run('DELETE FROM branches WHERE id = ?', [${TEST_BRANCH_ID}]);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(menu restored, test branch removed)');
  } catch (e) {
    console.error('\nCOULD NOT RESTORE THE MENU:', e.message);
    console.error('Fix with: UPDATE menu_items SET active = 1;');
  }
  stopCloud();
  try { fs.rmSync(tillDir, { recursive: true, force: true }); } catch (e) {}
  console.log('(till copy removed)');
  process.exit(0);
 }
})();
