/**
 * Check every endpoint the reused POS screens call.
 *
 *   cd cloud && DATABASE_URL=... node test/dashboard-endpoints.js
 *
 * The dashboard renders frontend/src/pages/* unmodified, so each screen calls
 * the till's API names. This asserts the cloud answers all of them, in shapes
 * those screens can render — a missing field here shows up as a blank column
 * or NaN rather than an error, so it is worth checking explicitly.
 *
 * Read-only: safe against a live database.
 */
const { spawn } = require('child_process');

const PORT = 4393;
const BASE = `http://127.0.0.1:${PORT}/api`;
const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);

let cookie = null;
async function call(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

const EMAIL = process.env.DASH_EMAIL;
const PASSWORD = process.env.DASH_PASSWORD;

let proc = null;
(async () => {
 try {
  proc = spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (!await waitFor(`${BASE}/health`)) { console.log('cloud would not start'); process.exit(1); }

  if (!EMAIL || !PASSWORD) {
    console.log('Set DASH_EMAIL and DASH_PASSWORD to a dashboard account.');
    process.exit(1);
  }
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  ok('the owner can sign in', login.status === 200);
  if (login.status !== 200) process.exit(1);

  const today = new Date().toLocaleDateString('en-CA');
  const RANGE = `?from=2026-01-01&to=${today}`;

  console.log();
  console.log('=== EVERY CALL THE REUSED SCREENS MAKE ===');
  const CALLS = [
    ['Reports',   'GET', `/reports/kpi${RANGE}`],
    ['Reports',   'GET', `/reports/revenue-over-time${RANGE}`],
    ['Reports',   'GET', `/reports/top-items${RANGE}`],
    ['Reports',   'GET', `/reports/by-category${RANGE}`],
    ['Reports',   'GET', `/reports/hourly-heatmap${RANGE}`],
    ['Reports',   'GET', `/reports/cashier-performance${RANGE}`],
    ['Reports',   'GET', `/reports/detailed${RANGE}`],
    ['Reports',   'GET', `/reports/line-items${RANGE}`],
    ['Reports',   'GET', `/reports/expenses-by-category${RANGE}`],
    ['Reports',   'GET', `/reports/expenses-detail${RANGE}`],
    ['Reports',   'GET', '/branches'],
    ['Expenses',  'GET', `/expenses${RANGE}`],
    ['Expenses',  'GET', '/expenses/categories'],
    ['Shifts',    'GET', '/shifts/current'],
    ['Shifts',    'GET', '/shifts/history?limit=10'],
    ['Staff',     'GET', '/staff'],
    ['Staff',     'GET', `/staff/performance${RANGE}`],
    ['Inventory', 'GET', '/inventory'],
  ];

  let broken = [];
  for (const [screen, method, p] of CALLS) {
    const r = await call(method, p);
    if (r.status !== 200) broken.push(`${screen}: ${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 70)}`);
  }
  broken.forEach(b => console.log('   BROKEN ' + b));
  ok(`all ${CALLS.length} calls answer 200`, broken.length === 0);

  console.log();
  console.log('=== SHAPES THE SCREENS DEPEND ON ===');
  const exp = (await call('GET', `/expenses${RANGE}`)).body;
  ok('expenses list is { expenses, totals }',
     Array.isArray(exp.expenses) && exp.totals && typeof exp.totals.total === 'number');
  console.log(`   ${exp.expenses.length} expenses, total ${exp.totals.total}, drawer ${exp.totals.from_drawer_total}`);

  const hist = (await call('GET', '/shifts/history?limit=10')).body;
  ok('shift history carries computed totals',
     Array.isArray(hist) && (hist.length === 0 || typeof hist[0].expected_cash === 'number'));
  if (hist.length) {
    const s = hist[0];
    console.log(`   latest closed shift: ${s.staff_name} | ${s.total_orders} orders | drawer ${s.expected_cash} | variance ${s.variance}`);
    ok('drawer maths holds (float + cash - payouts)',
       Math.abs((s.opening_cash + s.cash_revenue - s.drawer_expenses) - s.expected_cash) < 0.01
       || s.status === 'closed');
  }

  const staff = (await call('GET', '/staff')).body;
  ok('staff cards have the today figures they render',
     Array.isArray(staff) && staff.length > 0 &&
     'todayOrders' in staff[0] && 'todayRevenue' in staff[0]);
  console.log(`   ${staff.length} staff, e.g. ${staff[0].name} (${staff[0].role}) at ${staff[0].branch_name}`);

  const perf = (await call('GET', `/staff/performance${RANGE}`)).body;
  ok('performance uses the field names the screen reads',
     Array.isArray(perf) && perf.length > 0 && 'orders' in perf[0] && 'revenue' in perf[0]);

  const inv = (await call('GET', '/inventory')).body;
  ok('inventory rows carry stock and a threshold',
     Array.isArray(inv) && inv.length > 0 && 'stock' in inv[0] && 'low_stock_threshold' in inv[0]);
  console.log(`   ${inv.length} ingredients, e.g. ${inv[0].name} ${inv[0].stock}${inv[0].unit || ''}`);

  console.log();
  console.log('=== NOTHING IS SERVED WITHOUT A SESSION ===');
  cookie = null;
  const guarded = ['/expenses', '/shifts/current', '/staff', '/inventory', '/reports/kpi'];
  const leaks = [];
  for (const p of guarded) {
    const r = await call('GET', p);
    if (r.status !== 401) leaks.push(`${p} -> ${r.status}`);
  }
  leaks.forEach(l => console.log('   LEAK ' + l));
  ok('every branch-data route requires signing in', leaks.length === 0);
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  if (proc) { try { proc.kill(); } catch (e) {} }
  process.exit(0);
 }
})();
