/**
 * Payroll.
 *
 *   cd cloud
 *   DATABASE_URL=... node test/payroll.js
 *
 * Uses its own branch (9006) and its own dashboard login, both removed at the
 * end, so the shop's data is untouched and the owner's password is never
 * needed. No till is involved: payroll has no till-facing route at all, which
 * is itself one of the things checked here.
 */
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

const CLOUD_ROOT = path.join(__dirname, '..');
const PORT = 4388;
const CLOUD = `http://127.0.0.1:${PORT}/api`;

const BRANCH = 9006;
const KEY = crypto.randomBytes(32).toString('hex');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const EMAIL = `payroll-test-${crypto.randomBytes(4).toString('hex')}@blaze.test`;
const PASSWORD = crypto.randomBytes(18).toString('hex');

const env = { ...process.env, PORT: String(PORT) };
delete env.ELECTRON_RUN_AS_NODE;
delete env.POS_USER_DATA_PATH;

function exec(js) {
  const r = spawnSync('node', ['-e', js], { cwd: CLOUD_ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('exec failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}

let cookie = null;
async function api(method, p, { body, bearer, noAuth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  else if (cookie && !noAuth) headers.Cookie = cookie;
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

const PERIOD = '2026-08';
const NEXT = '2026-09';
let proc = null;

(async () => {
 try {
  exec(`
    const db = require('./db/pg');
    const { createSchema } = require('./db/schema');
    const bcrypt = require('bcryptjs');
    (async () => {
      await createSchema(db);
      await db.run(
        'INSERT INTO branches (id, name, code, api_key_hash) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, active = 1',
        [${BRANCH}, 'Payroll Test', 'PT', '${sha(KEY)}']);
      // A till account at this branch, so the "managers appear automatically"
      // claim has something real to adopt.
      await db.run(
        'INSERT INTO staff (branch_id, local_id, name, role, active, origin, received_at) ' +
        'VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT (branch_id, local_id) DO NOTHING',
        [${BRANCH}, 1, 'Kamran', 'Manager', 'branch', Date.now()]);
      await db.run(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (email) DO NOTHING',
        ['${EMAIL}', await bcrypt.hash('${PASSWORD}', 10), 'Payroll Test', 'owner']);
      await db.close();
    })().catch(e => { console.error(e.message); process.exit(1); });
  `);

  proc = spawn('node', ['server.js'], { cwd: CLOUD_ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  if (!await waitFor(`${CLOUD}/health`)) { console.log('cloud would not start'); process.exit(1); }

  console.log('=== WAGES ARE NOT VISIBLE WITHOUT AN OWNER LOGIN ===');
  const anon = await api('GET', `/payroll?branch=${BRANCH}`, { noAuth: true });
  ok('a caller with no session gets nothing', anon.status === 401);
  const withBranchKey = await api('GET', `/payroll?branch=${BRANCH}`, { bearer: KEY, noAuth: true });
  // The point of the whole design: a till's own credential is not a way in.
  ok('and neither does a branch key — the tills have no route to payroll',
     withBranchKey.status === 401);

  const login = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (login.status !== 200) { console.log('could not sign in:', login.body.error); process.exit(1); }

  console.log();
  console.log('=== THE TILL STAFF ARE ALREADY ON THE LIST ===');
  const first = await api('GET', `/payroll?period=${PERIOD}&branch=${BRANCH}`);
  const kamran = (first.body.employees || []).find(e => e.name === 'Kamran');
  console.log(`   ${(first.body.employees || []).length} on the payroll; Kamran linked to till account ${kamran && kamran.staff_local_id}`);
  ok('a manager was adopted from the Staff tab without being typed in', Boolean(kamran));
  ok('and is marked as having a till login', kamran && kamran.has_till_account === true);
  ok('starting unpaid', kamran && kamran.status === 'unpaid');

  console.log();
  console.log('=== SOMEBODY WITH NO TILL LOGIN ===');
  const rider = await api('POST', '/payroll/employees', {
    body: { name: 'Shakeel', job_title: 'Rider', phone: '0300-1112233',
            monthly_salary: 32000, branch_id: BRANCH },
  });
  ok('a rider can be put on the payroll', rider.status === 201);
  const RIDER = rider.body.id;

  const noBranch = await api('POST', '/payroll/employees', { body: { name: 'Nobody' } });
  ok('but not without a branch', noBranch.status === 400);

  const listed = await api('GET', `/payroll?period=${PERIOD}&branch=${BRANCH}`);
  const shakeel = (listed.body.employees || []).find(e => e.id === RIDER);
  console.log(`   ${shakeel.name} (${shakeel.job_title}) starts at ${shakeel.base_salary}, net ${shakeel.net}`);
  ok('an untouched month starts at the agreed salary, not zero', shakeel.base_salary === 32000);
  ok('and has no till login', shakeel.has_till_account === false);

  console.log();
  console.log('=== BONUS, OVERTIME, ADVANCE AND DEDUCTION ===');
  const set = await api('PUT', `/payroll/${RIDER}/${PERIOD}`, {
    body: { base_salary: 32000, bonus: 5000, overtime: 2000, advance: 4000, deduction: 1000 },
  });
  console.log(`   32000 + 5000 + 2000 - 4000 - 1000 = ${set.body.net}`);
  ok('the net is the salary plus additions, less what was already taken',
     set.body.net === 34000);

  const negative = await api('PUT', `/payroll/${RIDER}/${PERIOD}`, {
    body: { base_salary: 1000, advance: 9000 } });
  ok('advances beyond the salary floor the payslip at zero rather than going negative',
     negative.body.net === 0);
  await api('PUT', `/payroll/${RIDER}/${PERIOD}`, {
    body: { base_salary: 32000, bonus: 5000, overtime: 2000, advance: 4000, deduction: 1000 } });

  console.log();
  console.log('=== PAYING, AND PAYING SHORT ===');
  const paidShort = await api('POST', `/payroll/${RIDER}/${PERIOD}/pay`, {
    body: { amount: 30000, paid_on: '2026-09-03', payment_method: 'Cash' } });
  console.log(`   paid 30000 of ${paidShort.body.net}, outstanding ${paidShort.body.outstanding}`);
  ok('a short payment is accepted', paidShort.status === 200);
  ok('and the balance is carried, not written off', paidShort.body.outstanding === 4000);

  const afterShort = await api('GET', `/payroll?period=${PERIOD}&branch=${BRANCH}`);
  const s2 = afterShort.body.employees.find(e => e.id === RIDER);
  ok('the row reads as part paid, which a paid/unpaid flag would have hidden',
     s2.status === 'short');

  const locked = await api('PUT', `/payroll/${RIDER}/${PERIOD}`, { body: { bonus: 999999 } });
  console.log(`   editing a paid month -> ${locked.status} ${locked.body.code || ''}`);
  ok('a paid month is locked against edits', locked.status === 409);

  await api('DELETE', `/payroll/${RIDER}/${PERIOD}/pay`);
  const reopened = await api('PUT', `/payroll/${RIDER}/${PERIOD}`, { body: { base_salary: 32000, bonus: 0 } });
  ok('undoing the payment reopens it', reopened.status === 200);

  const full = await api('POST', `/payroll/${RIDER}/${PERIOD}/pay`, {
    body: { paid_on: '2026-09-03' } });
  console.log(`   paying with no amount hands over the whole net: ${full.body.paid_amount}`);
  ok('the amount defaults to what is owed', full.body.paid_amount === 32000);
  ok('leaving nothing outstanding', full.body.outstanding === 0);

  console.log();
  console.log('=== A MONTH NOBODY OPENED IS STILL PAYABLE ===');
  const straight = await api('POST', `/payroll/${RIDER}/${NEXT}/pay`, { body: { paid_on: '2026-10-02' } });
  console.log(`   ${NEXT} paid straight off at ${straight.body.paid_amount}`);
  ok('paying an untouched month uses the agreed salary', straight.body.paid_amount === 32000);

  console.log();
  console.log('=== WHAT THE REPORTS SEE ===');
  // Dated on when the money moved, not on the month the payslip is labelled.
  const sept = await api('GET', `/payroll/summary?from=2026-09-01&to=2026-09-30&branch=${BRANCH}`);
  const aug = await api('GET', `/payroll/summary?from=2026-08-01&to=2026-08-31&branch=${BRANCH}`);
  console.log(`   wages counted in September: ${sept.body.wages_paid}; in August: ${aug.body.wages_paid}`);
  ok('August wages paid in September count in September', sept.body.wages_paid === 32000);
  ok('and not in August, when no money moved', aug.body.wages_paid === 0);
  ok('with a per-person breakdown', (sept.body.by_person || []).some(p => p.name === 'Shakeel'));

  const kpi = await api('GET', `/reports/kpi?from=2026-09-01&to=2026-09-30&branch=${BRANCH}`);
  console.log(`   kpi: wages_paid=${kpi.body.wages_paid}, expenses=${kpi.body.total_expenses}, net=${kpi.body.net_revenue}`);
  ok('the reports carry wages as their own figure', kpi.body.wages_paid === 32000);
  ok('kept out of the till expense total', kpi.body.total_expenses === 0);
  ok('but taken off what the owner actually keeps',
     kpi.body.net_revenue === (kpi.body.total_revenue - 32000));

  console.log();
  console.log('=== SOMEBODY WHO LEAVES ===');
  const del = await api('DELETE', `/payroll/employees/${RIDER}`);
  ok('deletion is refused, so the months already paid survive', del.status === 400);
  await api('PUT', `/payroll/employees/${RIDER}`, { body: { active: false } });
  const afterLeaving = await api('GET', `/payroll?period=${PERIOD}&branch=${BRANCH}`);
  const gone = afterLeaving.body.employees.find(e => e.id === RIDER);
  ok('they stay on the list, marked as left', gone && gone.active === 0);
  ok('but are out of the month’s totals', afterLeaving.body.totals.people === 1);

  const history = await api('GET', `/payroll/history/${RIDER}`);
  console.log(`   months on file for them: ${(history.body || []).map(h => h.period).join(', ')}`);
  ok('and every month they were paid is still on file', (history.body || []).length === 2);
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  try {
    exec([
      "const db = require('./db/pg');",
      '(async () => {',
      `  await db.run('DELETE FROM payslips WHERE employee_id IN (SELECT id FROM employees WHERE branch_id = ?)', [${BRANCH}]);`,
      `  await db.run('DELETE FROM employees WHERE branch_id = ?', [${BRANCH}]);`,
      `  await db.run('DELETE FROM staff WHERE branch_id = ?', [${BRANCH}]);`,
      `  await db.run('DELETE FROM branches WHERE id = ?', [${BRANCH}]);`,
      `  await db.run('DELETE FROM users WHERE email = ?', ['${EMAIL}']);`,
      '  await db.close();',
      "})().catch(e => { console.error(e.message); process.exit(1); });",
    ].join('\n'));
    console.log('\n(test branch, its people and the test login removed)');
  } catch (e) {
    console.error('\nCOULD NOT CLEAN UP:', e.message);
  }
  if (proc) { try { proc.kill(); } catch (e) {} }
  process.exit(0);
 }
})();
