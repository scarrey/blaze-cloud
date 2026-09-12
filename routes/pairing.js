/**
 * Turning a freshly installed till into a particular branch.
 *
 * The problem this solves is not technical. A branch API key is 64 hex
 * characters; the alternative to this file is telling a restaurant manager to
 * open AppData, create a JSON file, and paste a key into it without typos. That
 * is not a handover, it is a support call waiting to happen, and the failure
 * mode is a shop that files its takings under the wrong branch.
 *
 * So the owner generates a short code on the dashboard, reads it out, and the
 * till exchanges it for the real credential itself. The manager never learns
 * that cloud-sync.json exists.
 *
 * **Claiming rotates the branch's key.** This is deliberate and it is the same
 * decision as the one behind rekeying: pairing a new machine to a branch means
 * the old one is being replaced — it has died, or been stolen, or is being
 * retired — and it must stop being able to report as that shop. The deployment
 * is one till per branch. If that ever changes, this is the line to revisit,
 * because it is what makes two tills at one branch impossible.
 *
 * The claim endpoint is the only unauthenticated write in the cloud, which is
 * why it is rate limited and why every code is single use and short lived.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { generateKey, hashKey } = require('../db/keys');

/**
 * No O, I, 0 or 1.
 *
 * The code gets read down a telephone and typed by somebody who did not write
 * it. Removing the characters people confuse is worth more than the handful of
 * bits it costs: 32^8 is still 1.1 trillion, and guessing is rate limited.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/** Long enough to install and set up a machine; short enough to stop mattering. */
const TTL_HOURS = 24;

const hashCode = (code) => crypto.createHash('sha256').update(normalise(code)).digest('hex');

/** Hyphens and case are cosmetic — "8f3k-29pq" and "8F3K29PQ" are one code. */
function normalise(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Shown as 8F3K-29PQ. Grouping halves the transcription errors. */
const pretty = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/* ------------------------------------------------------- rate limiting -- */

/*
 * The same shape as the dashboard login limiter in routes/auth.js.
 *
 * In memory, so it resets when the process does. That is a real limit and it is
 * accepted: this runs as a single process, an attacker cannot restart it, and
 * the window is short enough that a restart costs them little. A shared store
 * would be the answer if this were ever load balanced.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function tooMany(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

function recordAttempt(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

/* --------------------------------------------------------- the owner -- */

/**
 * POST /api/pairing/codes — issue one for a branch.
 *
 * Returned once, in clear. Only the hash is stored, so a code that is lost is
 * not recovered, it is reissued — the same rule as the branch keys themselves.
 */
router.post('/codes', requireUser, async (req, res) => {
  const branchId = Number(req.body && req.body.branch_id);
  if (!Number.isFinite(branchId)) return res.status(400).json({ error: 'Choose a branch.' });

  try {
    const branch = await db.one('SELECT id, name FROM branches WHERE id = ? AND active = 1', [branchId]);
    if (!branch) return res.status(404).json({ error: 'No such branch.' });

    const code = generateCode();

    // Any code still outstanding for this branch is retired. Two live codes for
    // one branch is a way to pair the wrong machine, and there is no reason to
    // want it.
    await db.run(
      'UPDATE pairing_codes SET expires_at = NOW() WHERE branch_id = ? AND claimed_at IS NULL AND expires_at > NOW()',
      [branchId]);

    await db.run(`
      INSERT INTO pairing_codes (branch_id, code_hash, hint, expires_at, created_by)
      VALUES (?, ?, ?, NOW() + (? || ' hours')::interval, ?)
    `, [branchId, hashCode(code), code.slice(-4), String(TTL_HOURS),
        (req.user && req.user.email) || null]);

    res.status(201).json({
      branch_id: branch.id,
      branch_name: branch.name,
      code: pretty(code),
      expires_in_hours: TTL_HOURS,
      note: 'Type this into the till: Settings, then Branch & Cloud. It works once, and it replaces whatever machine that branch is using now.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** What is outstanding, without ever showing a usable code. */
router.get('/codes', requireUser, async (req, res) => {
  try {
    res.json(await db.q(`
      SELECT p.id, p.branch_id, b.name AS branch_name, p.hint, p.created_at,
             p.expires_at, p.claimed_at, p.created_by,
             (p.claimed_at IS NULL AND p.expires_at > NOW()) AS live
        FROM pairing_codes p
        LEFT JOIN branches b ON b.id = p.branch_id
       ORDER BY p.created_at DESC
       LIMIT 50
    `));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------------------- the till -- */

/**
 * POST /api/pairing/claim — a till exchanging a code for its credentials.
 *
 * Unauthenticated, necessarily: a till that has never been paired has nothing
 * to authenticate with. That is what the rate limit, the single use and the
 * expiry are all protecting.
 *
 * Everything happens in one transaction. A code marked spent without the key
 * having been rotated, or a key rotated without the code being spent, would
 * each leave a branch in a state somebody has to be called out to fix.
 */
router.post('/claim', async (req, res) => {
  const code = normalise(req.body && req.body.code);
  const ip = req.ip || 'unknown';

  if (tooMany(ip)) {
    return res.status(429).json({
      error: 'Too many pairing attempts. Try again in a few minutes.',
      code: 'RATE_LIMITED',
    });
  }
  recordAttempt(ip);

  if (code.length !== CODE_LENGTH) {
    return res.status(400).json({ error: 'A pairing code is eight characters, like 8F3K-29PQ.' });
  }

  try {
    const result = await db.tx(async (client) => {
      // Claimed inside the transaction and only if still unclaimed, so two
      // machines racing on the same code cannot both win.
      const claim = await client.query(db.toPg(`
        UPDATE pairing_codes
           SET claimed_at = NOW(), claimed_ip = ?
         WHERE code_hash = ? AND claimed_at IS NULL AND expires_at > NOW()
        RETURNING branch_id
      `), [ip, hashCode(code)]);

      if (!claim.rowCount) return null;

      const branchId = claim.rows[0].branch_id;
      const branch = await client.query(db.toPg(
        'SELECT id, name FROM branches WHERE id = ? AND active = 1'), [branchId]);
      if (!branch.rowCount) throw new Error('That branch is no longer active.');

      // The machine being replaced stops reporting as this shop from here on.
      const apiKey = generateKey();
      await client.query(db.toPg('UPDATE branches SET api_key_hash = ? WHERE id = ?'),
        [hashKey(apiKey), branchId]);

      return { branch: branch.rows[0], apiKey };
    });

    if (!result) {
      // One message for expired, spent and wrong alike. Distinguishing them
      // tells somebody guessing which codes exist.
      return res.status(400).json({
        error: 'That pairing code is not valid, or has already been used.',
        code: 'BAD_PAIRING_CODE',
      });
    }

    // Spent, so the limiter should not hold a successful pairing against the
    // next machine set up from the same shop.
    attempts.delete(ip);

    console.log(`Branch ${result.branch.id} (${result.branch.name}) paired to a new till from ${ip}.`);

    res.json({
      enabled: true,
      branch_id: result.branch.id,
      branch_name: result.branch.name,
      api_key: result.apiKey,
    });
  } catch (err) {
    console.error('Pairing claim failed:', err.message);
    res.status(500).json({ error: 'Could not complete pairing' });
  }
});

module.exports = router;
