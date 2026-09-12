/**
 * Pairing a freshly installed till to a branch.
 *
 *   cd backend
 *   DATABASE_URL=... node scripts/run-script.js ../cloud/test/pairing.js
 *
 * Uses its own two branches (9008, 9009), its own dashboard login and a
 * throwaway copy of the till database. All removed at the end.
 *
 * The claim under test is the handover one: a machine with no identity at all
 * becomes E-18, or CBR Town, from a code somebody read out — without anybody
 * opening AppData, and without a 64-character key being shown to whoever is
 * standing at the counter.
 *
 * Two of these checks are about failure rather than success, and they are the
 * reason this file is longer than it looks like it needs to be: a code that can
 * be used twice is a way to pair the wrong machine, and re-pairing a till that
 * still holds unsent sales would file one shop's takings under another.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const TILL_ROOT = path.join(__dirname, '..', '..', 'backend');
const PORT = 4390;
const CLOUD = `http://127.0.0.1:${PORT}/api`;
const TILL = 'http://127.0.0.1:3387/api';

const BRANCH_A = 9008;
const BRANCH_B = 9009;
const EMAIL = `pair-test-${crypto.randomBytes(4).toString('hex')}@blaze.test`;
const PASSWORD = crypto.randomBytes(18).toString('hex');

/*
 * A till with no cloud-sync.json at all — a machine straight out of the
 * installer. That is the state this whole feature exists to get out of, so it
 * is the state the test has to start in.
 */
const tillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blaze-pair-'));
fs.copyFileSync(path.join(TILL_ROOT, 'pos_database.db'), path.join(tillDir, 'pos_database.db'));

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
async function api(method, p, { body, noAuth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie && !noAuth) headers.Cookie = cookie;
  const r = await fetch(CLOUD + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
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

const identityPath = path.join(tillDir, 'cloud-sync.json');
const readIdentity = () => JSON.parse(fs.readFileSync(identityPath, 'utf8'));

let proc = null;

(async () => {
 try {
  cloudExec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    const bcrypt = require('bcryptjs');
    const { generateKey, hashKey } = require('./db/keys');
    (async () => {
      await createSchema(db);
      for (const [id, name] of [[${BRANCH_A}, 'Pair Test A'], [${BRANCH_B}, 'Pair Test B']]) {
        await db.run(
          'INSERT INTO branches (id, name, api_key_hash) VALUES (?, ?, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
          [id, name, hashKey(generateKey())]);
      }
      await db.run(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (email) DO NOTHING',
        ['${EMAIL}', await bcrypt.hash('${PASSWORD}', 10), 'Pair Test', 'owner']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env: cloudEnv, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!await waitFor(`${CLOUD}/health`)) { console.log('cloud would not start'); process.exit(1); }

  require(path.join(TILL_ROOT, 'server'));
  if (!await waitFor(`${TILL}/health`)) { console.log('till would not start'); process.exit(1); }

  const T = (await till('POST', '/staff/login', null, { pin: '1234', staff_id: 1 })).body.token;
  const signedIn = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (signedIn.status !== 200) { console.log('sign-in failed:', signedIn.body.error); process.exit(1); }

  console.log('=== A MACHINE OUT OF THE INSTALLER ===');
  const fresh = await till('GET', '/sync/status', T);
  console.log(`   paired=${fresh.body.paired}, branch=${fresh.body.branch_id}`);
  ok('starts with no identity at all', fresh.body.paired === false);
  ok('and no pairing file on disk', !fs.existsSync(identityPath));

  console.log();
  console.log('=== THE OWNER ISSUES A CODE ===');
  const issued = await api('POST', '/pairing/codes', { body: { branch_id: BRANCH_A } });
  console.log(`   ${issued.body.code} for ${issued.body.branch_name}, ${issued.body.expires_in_hours}h`);
  ok('a code is issued', issued.status === 201);
  ok('short enough to read down a telephone', /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(issued.body.code || ''));
  // Characters people confuse when reading aloud must not appear at all.
  ok('with no O, I, 0 or 1 in it', !/[OI01]/.test((issued.body.code || '').replace('-', '')));

  const listed = await api('GET', '/pairing/codes');
  const row = (listed.body || []).find(c => c.branch_id === BRANCH_A);
  ok('the listing shows it outstanding', row && row.live === true);
  ok('without ever showing a usable code',
     JSON.stringify(listed.body).indexOf((issued.body.code || 'x').replace('-', '')) === -1);

  console.log();
  console.log('=== THE TILL PAIRS ITSELF ===');
  const paired = await till('POST', '/sync/pair', T, {
    cloud_url: `http://127.0.0.1:${PORT}`, code: issued.body.code });
  console.log(`   ${paired.status} -> ${paired.body.branch_name} (${paired.body.branch_id})`);
  ok('pairing succeeds', paired.status === 200);
  ok('and the till now reports as that branch', paired.body.branch_id === BRANCH_A);

  const written = readIdentity();
  ok('a pairing file was written', fs.existsSync(identityPath));
  ok('carrying a real 64-character key', /^[0-9a-f]{64}$/.test(written.api_key || ''));
  ok('which the status endpoint never returns',
     JSON.stringify(paired.body).indexOf(written.api_key) === -1);

  // The hole this was written to close: on a till that booted unpaired, none
  // of the sync agents had been scheduled, so a correct identity file sat there
  // doing nothing.
  const after = await till('GET', '/sync/status', T);
  ok('the sync agents started without a restart', typeof after.body.interval_ms === 'number');
  ok('and the backup agent with them', typeof after.body.cloud_backup_interval_ms === 'number');

  console.log();
  console.log('=== A CODE WORKS ONCE ===');
  const replay = await till('POST', '/sync/pair', T, {
    cloud_url: `http://127.0.0.1:${PORT}`, code: issued.body.code });
  console.log(`   reusing it -> ${replay.status} ${replay.body.code || ''}`);
  ok('the same code cannot pair a second machine', replay.status === 400);

  const nonsense = await api('POST', '/pairing/claim', { noAuth: true, body: { code: 'ZZZZ-ZZZZ' } });
  ok('an invented code is refused', nonsense.status === 400);
  ok('with the same wording as a spent one, so codes cannot be probed',
     nonsense.body.error === replay.body.error);

  console.log();
  console.log('=== A TILL HOLDING UNSENT SALES CANNOT BE MOVED ===');
  /*
   * The misattribution guard. Orders carry the branch they were rung up at, but
   * a push is filed by the cloud under whichever key presented it — so moving a
   * till mid-queue would put one shop's takings in the other's books.
   */
  const cur = (await till('GET', '/shifts/current', T)).body;
  if (cur && cur.id) await till('POST', '/shifts/close', T, { closing_cash: 0 });
  await till('POST', '/shifts/open', T, { opening_cash: 500 });
  await till('POST', '/orders', T, {
    items: [{ id: 1, name: 'Zinger', price: 600, quantity: 1 }], payment_method: 'Cash' });

  const db = require(path.join(TILL_ROOT, 'db', 'database'));
  db.prepare("UPDATE orders SET sync_state = 'pending'").run();
  const pending = db.prepare("SELECT COUNT(*) n FROM orders WHERE sync_state = 'pending'").get().n;
  console.log(`   ${pending} unsent orders for ${written.branch_name}`);

  const codeB = await api('POST', '/pairing/codes', { body: { branch_id: BRANCH_B } });
  const moved = await till('POST', '/sync/pair', T, {
    cloud_url: `http://127.0.0.1:${PORT}`, code: codeB.body.code });
  console.log(`   moving to ${codeB.body.branch_name} -> ${moved.status} ${moved.body.code || ''}`);
  ok('the move is refused', moved.status === 409 && moved.body.code === 'UNSYNCED_RECORDS');
  ok('and the till still reports as its own branch',
     readIdentity().branch_id === BRANCH_A);

  console.log();
  console.log('=== PAIRING STILL NEEDS A SIGNED-IN USER ===');
  /*
   * A manager may pair — the owner is never in the shop, so the person
   * standing at the machine has to be able to set it up. What stops this being
   * a way to move a till somewhere it should not go is the code itself, which
   * only the owner can issue. What is still refused is nobody at all.
   */
  const noSession = await fetch(`${TILL}/sync/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloud_url: 'http://x', code: 'AAAA-AAAA' }) });
  ok('an unauthenticated caller cannot pair this machine', noSession.status === 401);

  const badUrl = await till('POST', '/sync/pair', T, { cloud_url: 'not-a-url', code: 'AAAA-AAAA' });
  ok('a malformed cloud address is rejected before anything is written', badUrl.status === 400);

  /*
   * Last, deliberately.
   *
   * The limiter is keyed on the caller's address, and in this test every
   * caller is 127.0.0.1 — so exhausting it earlier locked out the legitimate
   * claims that follow, which is exactly what it is supposed to do to an
   * attacker. In a shop the till and anybody guessing are different addresses.
   */
  console.log();
  console.log('=== GUESSING IS RATE LIMITED ===');
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) {
    const r = await api('POST', '/pairing/claim', { noAuth: true, body: { code: 'AAAA-BBBB' } });
    if (r.status === 429) limited = true;
  }
  ok('repeated wrong codes are locked out', limited);

 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    cloudExec([
      "const db = require('./db/pg');",
      '(async () => {',
      `  for (const id of [${BRANCH_A}, ${BRANCH_B}]) {`,
      "    await db.run('DELETE FROM pairing_codes WHERE branch_id = ?', [id]);",
      "    for (const t of ['branch_backups','live_status','order_items','orders','shifts','expenses','staff','ingredients','customers','sync_cursor']) {",
      "      try { await db.run('DELETE FROM ' + t + ' WHERE branch_id = ?', [id]); } catch (e) {}",
      '    }',
      '  }',
      `  await db.run('DELETE FROM branches WHERE id IN (?, ?)', [${BRANCH_A}, ${BRANCH_B}]);`,
      `  await db.run('DELETE FROM users WHERE email = ?', ['${EMAIL}']);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(test branches and login removed)');
  } catch (e) {
    console.error('\nCOULD NOT CLEAN UP:', e.message);
  }
  if (proc) { try { proc.kill(); } catch (e) {} }
  try { fs.rmSync(tillDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
 }
})();
