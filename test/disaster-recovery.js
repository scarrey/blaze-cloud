/**
 * Losing a branch's machine, and getting it trading again on another one.
 *
 *   cd backend
 *   DATABASE_URL=... node scripts/run-script.js ../cloud/test/disaster-recovery.js
 *
 * Uses its own branch (9007), its own dashboard login and throwaway copies of
 * the till database. All removed at the end.
 *
 * This walks the whole thing rather than testing the pieces: a till trades,
 * backs up, is destroyed, and a *different* machine is paired and restored from
 * the cloud. The claim under test is the shop's own — that the replacement has
 * the orders, the staff, the customers and the stock the dead one had.
 *
 * It also pins down the bug this work started from. The old backup was an
 * fs.copyFileSync of a WAL-mode database, which silently omitted anything not
 * yet checkpointed; the first section proves the new one does not.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const PORT = 4389;
const CLOUD = `http://127.0.0.1:${PORT}/api`;
const TILL = 'http://127.0.0.1:3386/api';

const BRANCH = 9007;
const KEY = crypto.randomBytes(32).toString('hex');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const EMAIL = `dr-test-${crypto.randomBytes(4).toString('hex')}@blaze.test`;
const PASSWORD = crypto.randomBytes(18).toString('hex');

// The doomed machine.
const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-dr-old-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));
fs.writeFileSync(path.join(tillDir, 'cloud-sync.json'), JSON.stringify({
  enabled: true, cloud_url: `http://127.0.0.1:${PORT}`,
  branch_id: BRANCH, branch_name: 'DR Test', api_key: KEY,
}, null, 2));

process.env.POS_USER_DATA_PATH = tillDir;
process.env.PORT = '3386';

const cloudEnv = { ...process.env, PORT: String(PORT) };
delete cloudEnv.ELECTRON_RUN_AS_NODE;
delete cloudEnv.POS_USER_DATA_PATH;

function cloudExec(js) {
  const r = spawnSync('node', ['-e', js], { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloudExec failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

let cookie = null;
async function api(method, p, { body, bearer, noAuth, raw } = {}) {
  const headers = {};
  if (!raw) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  else if (cookie && !noAuth) headers.Cookie = cookie;
  const r = await fetch(CLOUD + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (raw) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function till(method, p, token, body) {
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

const Database = require(path.join(TILL_ROOT, 'node_modules', 'better-sqlite3'));
const countOrders = (file) => {
  const d = new Database(file, { readonly: true });
  const n = d.prepare("SELECT COUNT(*) n, MAX(created_at) last FROM orders").get();
  d.close();
  return n;
};

let proc = null;
let newDir = null;

(async () => {
 try {
  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    const bcrypt = require('bcryptjs');
    (async () => {
      await createSchema(db);
      await db.run(
        'INSERT INTO branches (id, name, code, api_key_hash) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
        [${BRANCH}, 'DR Test', 'DR', '${sha(KEY)}']);
      await db.run(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (email) DO NOTHING',
        ['${EMAIL}', await bcrypt.hash('${PASSWORD}', 10), 'DR Test', 'owner']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!await waitFor(`${CLOUD}/health`)) { console.log('cloud would not start'); process.exit(1); }

  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const backup = require(path.join(TILL_ROOT, 'db', 'backup'));
  const upload = require(path.join(TILL_ROOT, 'sync', 'backup-upload'));
  const T = (await till('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;
  const signedIn = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (signedIn.status !== 200) { console.log('sign-in failed:', signedIn.body.error); process.exit(1); }

  const dbPath = path.join(tillDir, 'pos_database.db');

  console.log('=== A BACKUP CATCHES WRITES STILL IN THE WAL ===');
  // The original bug, reproduced and then disproved. Sales are rung up and the
  // database is NOT checkpointed, so the new rows live only in the -wal file.
  const cur = (await till('GET', '/shifts/current', T)).body;
  if (cur && cur.id) await till('POST', '/shifts/close', T, { closing_cash: 0 });
  await till('POST', '/shifts/open', T, { opening_cash: 1000 });

  const before = countOrders(dbPath).n;
  for (let i = 0; i < 3; i++) {
    await till('POST', '/orders', T, {
      items: [{ id: 1, name: 'Zinger', price: 600, quantity: 1 }], payment_method: 'Cash' });
  }
  const walBytes = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0;
  console.log(`   ${walBytes} bytes sitting in the -wal file, uncheckpointed`);

  // What the old implementation did.
  const naive = path.join(tillDir, 'naive_copy.db');
  fs.copyFileSync(dbPath, naive);
  const naiveCount = countOrders(naive).n;

  const taken = backup.takeBackup('test');
  const properCount = countOrders(taken.path).n;
  console.log(`   live ${before + 3} orders · plain file copy ${naiveCount} · VACUUM INTO ${properCount}`);
  ok('the new backup holds every order', properCount === before + 3);
  ok('and it verified before replacing anything', taken.ok === true && taken.orders === before + 3);
  if (naiveCount < properCount) {
    ok(`the old file copy would have lost ${properCount - naiveCount} of them`, true);
  } else {
    console.log('  NOTE  the WAL happened to be checkpointed, so the plain copy matched this time');
  }

  console.log();
  console.log('=== IT LEAVES THE MACHINE ===');
  const sent = await upload.uploadOnce({ force: true, reason: 'test' });
  console.log(`   ${JSON.stringify({ uploaded: sent.uploaded, bytes: sent.bytes, error: sent.error })}`);
  ok('the till uploaded it', sent.ok === true && sent.uploaded === true);

  /*
   * The upload is skipped when nothing has changed.
   *
   * Retried until it settles rather than asserted once: the menu, staff and
   * settings downlinks all write to the database as they land, so a till that
   * has just been paired genuinely does change between two uploads. That is
   * the dedupe working, not failing. Once the pulls are done the hash stops
   * moving, which is the state a real till spends nearly all its time in.
   */
  let settled = null;
  for (let i = 0; i < 12 && !settled; i++) {
    const r = await upload.uploadOnce();
    if (r.skipped === 'unchanged') settled = r;
    else await new Promise(res => setTimeout(res, 500));
  }
  ok('an unchanged database is not uploaded twice', Boolean(settled));

  // The property that actually bounds storage, and it holds however often a
  // till uploads: one row per branch per day, rewritten in place.
  const perDay = await api('GET', '/backup');
  const daysHeld = (perDay.body.backups || []).filter(b => b.branch_id === BRANCH);
  const distinctDays = new Set(daysHeld.map(b => String(b.backup_day).slice(0, 10)));
  ok('repeated uploads keep one row per day, not one per upload',
     daysHeld.length === distinctDays.size);

  const rejected = await fetch(`${CLOUD}/backup/upload`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/gzip' },
    body: Buffer.from('this is not gzip at all'),
  });
  ok('a body that is not a gzip stream is refused', rejected.status === 400);

  const noKey = await fetch(`${CLOUD}/backup/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: Buffer.from([0x1f, 0x8b]) });
  ok('and so is one with no branch key', noKey.status === 401);

  console.log();
  console.log('=== THE OWNER CAN SEE IT, AND ITS AGE ===');
  const listed = await api('GET', '/backup');
  const mine = (listed.body.branches || []).find(b => b.id === BRANCH);
  const rows = (listed.body.backups || []).filter(b => b.branch_id === BRANCH);
  console.log(`   ${mine.name}: ${mine.backups_held} held, health "${mine.health}", ${rows[0].orders_count} orders`);
  ok('the branch shows a backup', mine && mine.backups_held === 1);
  ok('reported as current', mine.health === 'current');
  ok('with the order count it was taken at', rows[0].orders_count === before + 3);

  const anon = await api('GET', '/backup', { noAuth: true });
  ok('a caller with no session cannot list backups', anon.status === 401);
  const asBranch = await api('GET', '/backup', { bearer: KEY, noAuth: true });
  ok('and a branch key cannot either — a till reads nobody’s database', asBranch.status === 401);

  console.log();
  console.log('=== THE MACHINE DIES ===');
  const deadOrders = countOrders(dbPath);
  const deadStaff = new Database(dbPath, { readonly: true });
  const staffCount = deadStaff.prepare('SELECT COUNT(*) n FROM staff').get().n;
  const custCount = deadStaff.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const ingCount = deadStaff.prepare('SELECT COUNT(*) n FROM ingredients').get().n;
  deadStaff.close();
  console.log(`   lost with it: ${deadOrders.n} orders, ${staffCount} staff, ${custCount} customers, ${ingCount} stock lines`);

  console.log();
  console.log('=== A DIFFERENT MACHINE TAKES OVER ===');
  // Nothing from the old machine is carried across by hand: a fresh userData
  // directory, exactly as a newly installed PC would have.
  newDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-dr-new-'));

  const rekeyed = await api('POST', `/backup/rekey/${BRANCH}`);
  ok('the owner can issue a new pairing key from the dashboard', rekeyed.status === 200);
  ok('shaped as the file the machine needs', Boolean(rekeyed.body.config
    && rekeyed.body.config.api_key && rekeyed.body.config.branch_id === BRANCH));

  const oldKeyNow = await fetch(`${CLOUD}/staff/version`, {
    headers: { Authorization: 'Bearer ' + KEY } });
  ok('and the dead machine’s key stops working at once', oldKeyNow.status === 401);

  const NEW_KEY = rekeyed.body.config.api_key;
  fs.writeFileSync(path.join(newDir, 'cloud-sync.json'), JSON.stringify({
    ...rekeyed.body.config, cloud_url: `http://127.0.0.1:${PORT}`,
  }, null, 2));

  const dl = await api('GET', `/backup/${rows[0].id}/download`, { raw: true });
  ok('the backup downloads', dl.status === 200 && dl.buffer.length > 0);
  ok('as a plain SQLite file the restore screen accepts',
     dl.buffer.subarray(0, 15).toString('utf8') === 'SQLite format 3');

  const restored = path.join(newDir, 'pos_database.db');
  fs.writeFileSync(restored, dl.buffer);

  const after = countOrders(restored);
  const nd = new Database(restored, { readonly: true });
  const nStaff = nd.prepare('SELECT COUNT(*) n FROM staff').get().n;
  const nCust = nd.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const nIng = nd.prepare('SELECT COUNT(*) n FROM ingredients').get().n;
  const nMenu = nd.prepare('SELECT COUNT(*) n FROM menu_items WHERE active = 1').get().n;
  nd.close();
  console.log(`   recovered: ${after.n} orders, ${nStaff} staff, ${nCust} customers, ${nIng} stock lines, ${nMenu} menu items`);

  ok('every order is there', after.n === deadOrders.n);
  ok('the staff are there, PINs included', nStaff === staffCount);
  ok('the delivery customers are there', nCust === custCount);
  ok('the stock counts are there', nIng === ingCount);
  ok('and the menu', nMenu > 0);

  console.log();
  console.log('=== AND IT REPORTS AS THAT BRANCH ===');
  const asNew = await fetch(`${CLOUD}/staff/version`, {
    headers: { Authorization: 'Bearer ' + NEW_KEY } });
  ok('the replacement’s key is accepted', asNew.status === 200);
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      `  for (const t of ['branch_backups','live_status','order_items','orders','shifts','expenses','staff','ingredients','customers','sync_cursor']) {`,
      `    try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [${BRANCH}]); } catch (e) {}`,
      '  }',
      `  await db.run('DELETE FROM branches WHERE id = ?', [${BRANCH}]);`,
      `  await db.run('DELETE FROM users WHERE email = ?', ['${EMAIL}']);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(test branch and login removed)');
  } catch (e) {
    console.error('\nCOULD NOT CLEAN UP:', e.message);
  }
  if (proc) { try { proc.kill(); } catch (e) {} }
  for (const d of [tillDir, newDir]) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }
  process.exit(0);
 }
})();
