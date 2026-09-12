/**
 * Pairing check for a till.
 *
 * Authenticated by the branch key, so a newly provisioned till can confirm
 * three things in one call before any real data depends on them: that it can
 * reach the cloud at all, that its key is accepted, and — most usefully — which
 * branch the cloud believes it is. A till configured with the wrong branch id
 * would otherwise file a whole day's takings under the other shop before anyone
 * noticed.
 *
 * Also returns the server's clock, so the till can report skew rather than
 * silently writing orders with a wrong timestamp.
 */

const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  const sentMs = Number(req.body && req.body.sent_at_ms) || null;
  const nowMs = Date.now();

  res.json({
    ok: true,
    branch_id: req.branch.id,
    branch_name: req.branch.name,
    server_time_ms: nowMs,
    server_time: new Date(nowMs).toISOString(),
    // Positive means the till's clock is behind the server's.
    clock_skew_ms: sentMs ? nowMs - sentMs : null,
  });
});

module.exports = router;
