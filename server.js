/**
 * Blaze cloud API.
 *
 * Sits behind the admin dashboard at blaze.virtiqo.com. Two kinds of caller,
 * with two entirely separate credentials:
 *
 *   - **Tills**, authenticated by a per-branch API key. They only ever push:
 *     live status now, sales later. They never read another branch's data.
 *   - **The owner**, authenticated by an httpOnly session cookie. Reads only.
 *
 * Deployment: Node listens on loopback and Virtualmin's Apache/nginx vhost
 * reverse-proxies blaze.virtiqo.com to it, terminating TLS. This process never
 * faces the internet directly, which is why it binds 127.0.0.1 by default —
 * the same reasoning as the till's backend.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

require('./env').loadEnv();

const db = require('./db/pg');
const { attachUser, startSessionCleanup } = require('./middleware/session');
const { createSchema } = require('./db/schema');
const { requireBranch } = require('./middleware/branch-auth');

const app = express();

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.BLAZE_CLOUD_HOST || '127.0.0.1';

/*
 * Behind a reverse proxy, so trust its forwarded address — otherwise every
 * request appears to come from 127.0.0.1 and the login rate limiter would be
 * keyed on a single value for the whole internet.
 */
app.set('trust proxy', 1);

// Bodies here are small: a heartbeat is a few hundred bytes and a sales batch
// is capped by the till. A low limit means a malformed or hostile request is
// rejected before it is parsed rather than after.
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

/** Liveness probe. Open, and deliberately says nothing about the shop. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'blaze-cloud', time: new Date().toISOString() });
});

// --- Till-facing: branch key ------------------------------------------------
app.use('/api/ping', requireBranch, require('./routes/ping'));
app.use('/api/ingest', require('./routes/ingest'));

// --- Owner-facing: session cookie -------------------------------------------
app.use('/api/auth', require('./routes/auth'));

// Mixed: the write half takes a branch key, the read half a session cookie, so
// each is guarded inside the router rather than at the mount.
app.use('/api/live', require('./routes/live'));

// Both-branch reporting. Every route inside requires a signed-in owner.
app.use('/api/reports', require('./routes/reports'));
app.use('/api/branches', require('./routes/branches'));

/*
 * Staff, which the cloud now owns the way it owns the menu.
 *
 * Mounted ahead of branch-data because both answer under /api/staff. This
 * router holds the writes and the two till-facing endpoints; the reads it does
 * not define — the list and the performance figures — fall through to
 * branch-data below. Guards are inside, as with the menu: editing needs a
 * signed-in owner, /version and /snapshot answer a branch key.
 */
app.use('/api/staff', require('./routes/staff'));

/*
 * Payroll. The dashboard and nowhere else.
 *
 * There is no branch-key route in here and no downlink: wages never travel to
 * a till, so a manager on a drawer cannot see what a colleague earns even if a
 * permission were misconfigured. See routes/payroll.js.
 */
app.use('/api/payroll', require('./routes/payroll'));

/*
 * Backups: a till uploading one, and the owner getting it back onto a
 * different machine. Guards are inside — the upload answers a branch key, the
 * rest needs a signed-in owner. Mounted before the JSON body parser matters
 * here: the upload route brings its own raw parser, since a gzipped database
 * is not JSON. See routes/backup.js.
 */
app.use('/api/backup', require('./routes/backup'));

/*
 * Pairing a till to a branch. The claim endpoint inside is the only
 * unauthenticated write in this API — a till that has never been paired has
 * nothing to authenticate with — which is why it is rate limited and why every
 * code is single use and expires. See routes/pairing.js.
 */
app.use('/api/pairing', require('./routes/pairing'));

// Expenses, shifts, staff figures and stock — read-only, in the till's own
// response shapes so the POS screens can be reused on the dashboard unaltered.
app.use('/api', require('./routes/branch-data'));

/*
 * The menu, which the cloud owns outright. Guards are inside the router: the
 * dashboard's editing needs a session, while /version and /snapshot answer a
 * branch key, because those two are a till asking.
 */
app.use('/api/menu', require('./routes/menu'));
app.use('/api/deals', require('./routes/deals'));

// Shop-wide settings — tax, staff discount, currency, shop name. Branch-owned
// settings (printer, receipt wording, delivery price) stay on each till.
app.use('/api/settings', require('./routes/settings'));

/*
 * Serve the dashboard build from this same process, and therefore the same
 * origin as the API.
 *
 * That is what lets the session cookie be a plain SameSite=Lax httpOnly cookie
 * with no CORS negotiation and no SameSite=None. Serving the UI from a
 * different host would make the cookie a cross-site one, which modern browsers
 * increasingly refuse outright.
 *
 * Optional: if the build is absent, the API still runs. Useful in development,
 * where Vite serves the UI itself and proxies /api across.
 */
const DASHBOARD_DIST = process.env.BLAZE_DASHBOARD_DIST
  || path.join(__dirname, '..', 'dashboard', 'dist');

if (fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'))) {
  app.use(express.static(DASHBOARD_DIST));
  // Anything not matched above and not under /api is a client-side route, so
  // hand back index.html rather than a 404.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
  });
  console.log(`Serving dashboard from ${DASHBOARD_DIST}`);
} else {
  console.log('No dashboard build found — API only. (Run `npm run build` in dashboard/.)');
}

// 404 as JSON, so a dashboard fetch gets a parseable body rather than HTML.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Server error' });
});

/*
 * Schema first, then listen.
 *
 * The schema is idempotent, so a deploy is just a restart. Refusing to listen
 * when it cannot be applied is deliberate: a server that answers requests
 * against a database it could not reach would report an empty shop, which reads
 * exactly like a shop that sold nothing.
 */
createSchema(db)
  .then(() => {
    startSessionCleanup();
    server = app.listen(PORT, HOST, () => {
      console.log(`Blaze cloud API on http://${HOST}:${PORT}`);
      console.log('Database: Supabase (Postgres)');
    });
    server.on('error', onListenError);
  })
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    console.error('Check DATABASE_URL points at the Supabase connection string.');
    process.exit(1);
  });

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
}

// systemd sends SIGTERM on restart and on deploy. Closing the database on the
// way out means WAL is checkpointed rather than left for the next start to
// recover.
let server = null;

function shutdown() {
  if (!server) process.exit(0);
  server.close(async () => {
    try { await db.close(); } catch (e) { /* pool already ended */ }
    process.exit(0);
  });
  // Do not hang forever on a connection that will not close.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
