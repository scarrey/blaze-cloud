/**
 * Branch backups, and getting a shop trading again on a different machine.
 *
 * The question this exists to answer: the PC at E-18 has died — how long until
 * that shop is selling again, and what has been lost?
 *
 * Three things have to be true for the answer to be "twenty minutes, and
 * nothing", and each is an endpoint here:
 *
 *   1. A copy of that till's database has to exist somewhere other than the
 *      dead machine.                                    → POST /upload
 *   2. Somebody who is not a developer has to be able to get at it, at night,
 *      without a database URL or a terminal.            → GET  /  and  /:id/download
 *   3. The replacement machine has to be able to identify itself as that
 *      branch. The branch key was printed once at provisioning and only its
 *      hash is stored, so it cannot be recovered — it has to be reissued, and
 *      that has to be a button rather than a script.    → POST /rekey/:branchId
 *
 * The third is the one most likely to be forgotten until it is needed, which is
 * exactly the wrong time to discover that reissuing a key requires the Supabase
 * connection string and a checkout of this repository.
 */

const express = require('express');
const router = express.Router();
const zlib = require('zlib');
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { requireBranch } = require('../middleware/branch-auth');
const { generateKey, hashKey } = require('../db/keys');

/** Comfortably above a real shop's compressed database, low enough to catch a mistake. */
const MAX_BYTES = 40 * 1024 * 1024;

/** Two weeks of days per branch. See the table comment in db/schema.js. */
const KEEP_DAYS = 14;

const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ------------------------------------------------------------- the till -- */

/**
 * POST /api/backup/upload — a gzipped SQLite file, as raw bytes.
 *
 * Raw rather than base64 in JSON: base64 costs a third more on a connection
 * that is often the shop's weakest link, and the global JSON body limit is set
 * deliberately low to keep hostile requests cheap. The describing fields ride
 * in headers so the body stays one clean blob.
 *
 * Authenticated by the branch key, and filed against `req.branch.id` — which
 * comes from that key and never from the request — so one branch cannot
 * overwrite another's backups.
 */
router.post('/upload',
  express.raw({ type: ['application/gzip', 'application/octet-stream'], limit: MAX_BYTES }),
  requireBranch,
  async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) {
      return res.status(400).json({ error: 'No backup body received.' });
    }

    // Gzip starts 1f 8b. Checked because a truncated or mis-sent upload that is
    // stored anyway is worse than one refused: it would sit there looking like
    // a backup until the day somebody needed it.
    if (body[0] !== 0x1f || body[1] !== 0x8b) {
      return res.status(400).json({ error: 'That is not a gzip stream.' });
    }

    const takenAt = req.get('X-Backup-Taken-At') || new Date().toISOString();
    const day = String(takenAt).slice(0, 10);

    try {
      await db.run(`
        INSERT INTO branch_backups
          (branch_id, backup_day, taken_at, gz_bytes, raw_bytes, sha256,
           orders_count, last_order_at, reason, blob)
        VALUES (?, ?::date, ?::timestamptz, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (branch_id, backup_day) DO UPDATE SET
          taken_at = EXCLUDED.taken_at, received_at = NOW(),
          gz_bytes = EXCLUDED.gz_bytes, raw_bytes = EXCLUDED.raw_bytes,
          sha256 = EXCLUDED.sha256, orders_count = EXCLUDED.orders_count,
          last_order_at = EXCLUDED.last_order_at, reason = EXCLUDED.reason,
          blob = EXCLUDED.blob
      `, [
        req.branch.id, day, takenAt, body.length,
        int(req.get('X-Backup-Raw-Bytes')), req.get('X-Backup-Sha256') || null,
        int(req.get('X-Backup-Orders')), req.get('X-Backup-Last-Order-At') || null,
        req.get('X-Backup-Reason') || 'scheduled', body,
      ]);

      // Old days drop off here rather than on a cron, so retention cannot
      // quietly stop working without anybody noticing.
      await db.run(
        "DELETE FROM branch_backups WHERE branch_id = ? AND backup_day < CURRENT_DATE - ?::integer",
        [req.branch.id, KEEP_DAYS]);

      res.json({ ok: true, branch_id: req.branch.id, backup_day: day, gz_bytes: body.length });
    } catch (err) {
      console.error('Backup upload failed:', err.message);
      res.status(500).json({ error: 'Could not store the backup' });
    }
  });

/* -------------------------------------------------------- the dashboard -- */

/**
 * GET /api/backup — what exists, per branch, without shifting any blobs.
 *
 * The age matters more than the list: a branch whose newest backup is three
 * days old has a backup problem right now, and the only way anybody finds out
 * before they need it is if a screen says so.
 */
router.get('/', requireUser, async (req, res) => {
  try {
    const branches = await db.q(`
      SELECT b.id, b.name, b.code,
             MAX(bk.taken_at) AS last_backup_at,
             COUNT(bk.id)::int AS backups_held,
             COALESCE(SUM(bk.gz_bytes), 0)::bigint AS stored_bytes
        FROM branches b
        LEFT JOIN branch_backups bk ON bk.branch_id = b.id
       WHERE b.active = 1
       GROUP BY b.id, b.name, b.code
       ORDER BY b.id
    `);

    const rows = await db.q(`
      SELECT id, branch_id, backup_day, taken_at, received_at, gz_bytes,
             raw_bytes, orders_count, last_order_at, reason
        FROM branch_backups
       ORDER BY branch_id, backup_day DESC
    `);

    const now = Date.now();
    res.json({
      branches: branches.map((b) => {
        const ageMs = b.last_backup_at ? now - new Date(b.last_backup_at).getTime() : null;
        return {
          ...b,
          stored_bytes: Number(b.stored_bytes),
          last_backup_age_ms: ageMs,
          // Three bands, so "we have a backup" and "we have a backup from
          // Tuesday" never read the same on screen.
          health: ageMs == null ? 'none'
            : ageMs < 2 * 60 * 60 * 1000 ? 'current'
            : ageMs < 26 * 60 * 60 * 1000 ? 'lagging'
            : 'stale',
        };
      }),
      backups: rows.map(r => ({ ...r, gz_bytes: Number(r.gz_bytes), raw_bytes: Number(r.raw_bytes) })),
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backup/:id/download — the file, decompressed, ready to restore.
 *
 * Sent as a plain .db because that is what the till's existing restore screen
 * accepts (Settings → Data & Backup → Restore). Asking somebody to unzip a
 * file first is one more step at the worst possible moment.
 */
router.get('/:id/download', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad backup id.' });

  try {
    const row = await db.one(`
      SELECT bk.blob, bk.backup_day, bk.gz_bytes, b.code, b.name
        FROM branch_backups bk
        LEFT JOIN branches b ON b.id = bk.branch_id
       WHERE bk.id = ?
    `, [id]);
    if (!row) return res.status(404).json({ error: 'No such backup.' });

    const raw = zlib.gunzipSync(row.blob);
    const label = String(row.code || row.name || 'branch').replace(/[^A-Za-z0-9_-]/g, '');
    const day = String(row.backup_day).slice(0, 10);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="pos_${label}_${day}.db"`);
    res.setHeader('Content-Length', raw.length);
    res.send(raw);
  } catch (err) {
    console.error('Backup download failed:', err.message);
    res.status(500).json({ error: 'Could not read that backup' });
  }
});

/**
 * POST /api/backup/rekey/:branchId — issue that branch a new key.
 *
 * The step that turns a spare PC into that branch's till. The old key stops
 * working the instant this returns, which is the point: if the machine it was
 * on has been lost or stolen, it must not still be able to report as that
 * shop.
 *
 * The key is shown once, here, in the response. Only its hash is stored, so
 * this cannot be undone by asking again — it can only be done again.
 */
router.post('/rekey/:branchId', requireUser, async (req, res) => {
  const branchId = Number(req.params.branchId);
  if (!Number.isFinite(branchId)) return res.status(400).json({ error: 'Bad branch.' });

  try {
    const branch = await db.one('SELECT id, name FROM branches WHERE id = ?', [branchId]);
    if (!branch) return res.status(404).json({ error: 'No such branch.' });

    const key = generateKey();
    await db.run('UPDATE branches SET api_key_hash = ? WHERE id = ?', [hashKey(key), branchId]);

    // Handed back in the exact shape the file has to take, so recovery is a
    // copy and paste rather than an exercise in remembering the field names.
    res.json({
      branch_id: branch.id,
      branch_name: branch.name,
      filename: 'cloud-sync.json',
      // The cloud_url is filled in by the dashboard from wherever it is being
      // served, since that is by definition an address the shop can reach.
      config: {
        enabled: true,
        cloud_url: null,
        branch_id: branch.id,
        branch_name: branch.name,
        api_key: key,
      },
      warning: 'The previous key for this branch stopped working just now. Any till still using it will be refused until this file replaces its own.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
