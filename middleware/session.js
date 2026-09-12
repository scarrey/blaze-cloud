/**
 * Dashboard sessions.
 *
 * An httpOnly cookie rather than a token in JavaScript's reach: the dashboard
 * is a public URL showing the shop's whole trading history, so a session that
 * page script cannot read is worth the small extra plumbing.
 *
 * Sessions live in the database rather than in memory. The till gets away with
 * an in-memory Map (`backend/middleware/auth.js`) because its backend restarts
 * only when the app is closed; this process is restarted by systemd on every
 * crash and every deploy, and signing the owner out each time would be
 * baffling and, mid-deploy, relentless.
 */

const crypto = require('crypto');
const db = require('../db/pg');

const COOKIE = 'blaze_session';

/** Twelve hours, refreshed on use: long enough for a trading day, short enough that a forgotten laptop expires. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Refreshing on every request would mean a write per request; hourly keeps an active session alive for far less. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

async function createSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  await db.run(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
    [token, user.id, now, now + TTL_MS]
  );

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set behind the reverse proxy in production, where the connection is
    // HTTPS. Off in local development, where it is not — a Secure cookie over
    // http is simply never stored, and the symptom ("login succeeds, then I am
    // immediately signed out") is genuinely hard to read.
    secure: process.env.NODE_ENV === 'production',
    maxAge: TTL_MS,
    path: '/',
  });

  return token;
}

async function destroySession(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token = $1', [token]);
  res.clearCookie(COOKIE, { path: '/' });
}

/**
 * Attach `req.user` when the cookie names a live session. Never rejects —
 * routes decide what they require, the same shape as the till's `attachUser`.
 */
async function attachUser(req, res, next) {
  req.user = null;
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return next();

  try {
    const row = await db.one(`
      SELECT s.token, s.expires_at, u.id, u.email, u.name, u.role, u.branch_id, u.active
        FROM sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token = $1
    `, [token]);

    if (!row || !row.active) return next();

    const now = Date.now();
    // expires_at is a bigint, which pg hands back as a string.
    const expiresAt = Number(row.expires_at);

    if (expiresAt < now) {
      await db.run('DELETE FROM sessions WHERE token = $1', [token]);
      return next();
    }

    // Sliding expiry, written at most once an hour.
    if (expiresAt - now < TTL_MS - REFRESH_AFTER_MS) {
      await db.run('UPDATE sessions SET expires_at = $1 WHERE token = $2', [now + TTL_MS, token]);
    }

    req.user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      // NULL means every branch. Set on a future per-branch account to scope it
      // without touching this code again.
      branchId: row.branch_id,
    };
  } catch (err) {
    // A database blip must not sign everybody out mid-request; treat it as
    // "not signed in for this request" and let the route return 401.
    console.error('Session lookup failed:', err.message);
  }

  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in required', code: 'UNAUTHENTICATED' });
  }
  next();
}

/** Clear out expired rows periodically; unref'd so it never holds the process open. */
function startSessionCleanup() {
  const prune = () => {
    db.run('DELETE FROM sessions WHERE expires_at < $1', [Date.now()])
      .catch(err => console.error('Session prune failed:', err.message));
  };
  prune();
  const timer = setInterval(prune, 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { COOKIE, createSession, destroySession, attachUser, requireUser, startSessionCleanup };
