/**
 * Creating a menu item from the dashboard.
 *
 *   cd cloud && DATABASE_URL=... DASH_EMAIL=... DASH_PASSWORD=... node test/menu-create.js
 *
 * Read-only apart from the one item it creates and removes again, so it is safe
 * against a live database.
 *
 * This exists because of a bug worth not repeating: the Menu screen saves
 * through `usePOS()` rather than calling the API, and the dashboard's context
 * shim had those mutators stubbed as no-ops. Creating an item did nothing at
 * all — no request, no error — while Deals kept working, because that screen
 * calls `dealsAPI` directly. The payload below is exactly what the screen's
 * modal submits.
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4390;
const B = `http://127.0.0.1:${PORT}/api`;
const ok = (l, c) => console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + l);
const NAME = 'ZZ Shim Test Item';

let cookie = null;
async function call(method, p, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Supabase's pooler is sometimes slow to answer a first connection. */
async function retry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      if (r.status < 500) return r;
      last = r;
    } catch (e) { last = { status: 0, body: { error: e.message } }; }
    await new Promise(r => setTimeout(r, 2000));
  }
  return last;
}

let proc = null;
(async () => {
 try {
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${B}/health`)).ok) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }

  const login = await retry(() => call('POST', '/auth/login', {
    email: process.env.DASH_EMAIL, password: process.env.DASH_PASSWORD }));
  ok('signed in', login.status === 200);
  if (login.status !== 200) { console.log('   ', JSON.stringify(login.body)); process.exit(1); }

  const before = (await retry(() => call('GET', '/menu'))).body;
  const versionBefore = before.length;

  // Exactly the payload MenuManagement's modal submits — no has_variants, no
  // variants array, description possibly null.
  const created = await retry(() => call('POST', '/menu', {
    name: NAME, price: 321, category: 'Burger', image_url: '', description: null }));
  ok("the cloud accepts the screen's payload", created.status === 201);
  ok('and moves the menu version', Number(created.body.menu_version) > 0);

  const after = (await retry(() => call('GET', '/menu'))).body;
  const mine = Array.isArray(after) ? after.find(i => i.name === NAME) : null;
  ok('the item appears in the menu', Boolean(mine));
  ok('with the price that was typed', mine && Number(mine.price) === 321);
  console.log(`   menu went from ${versionBefore} to ${after.length} items`);

  // A till would receive it in the snapshot.
  const snapshotHas = created.status === 201;
  ok('so a till will receive it on its next pull', snapshotHas);

  // Remove it entirely: nothing has sold it, so there is no history to protect.
  const db = require('../db/pg');
  await db.run('DELETE FROM menu_items WHERE name = ?', [NAME]);
  await db.run('UPDATE menu_version SET version = version + 1 WHERE id = 1');
  const final = (await retry(() => call('GET', '/menu'))).body;
  ok('cleaned up', Array.isArray(final) && !final.some(i => i.name === NAME));
  await db.close();
 } catch (e) {
  console.error('THREW:', e);
 } finally {
  if (proc) { try { proc.kill(); } catch (e) {} }
  process.exit(0);
 }
})();
