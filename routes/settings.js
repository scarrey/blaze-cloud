/**
 * Shop-wide settings — the second thing the cloud owns, after the menu.
 *
 * **Only some settings belong here.** The tills' settings table is a flat
 * key/value store with no notion of scope, so pushing all of it down would have
 * one branch's printed address and delivery charge overwrite the other's on
 * every sync. The split is by whether the answer is the same at both shops:
 *
 *   Shop-wide, owned here      tax rate, staff discount, currency, shop name
 *   Branch's own, never synced delivery price, receipt footer, address, phone,
 *                              printer type, paper size, auto-print, receipt
 *                              toggles
 *
 * Anything not on the allow-list below is untouched on the till, so a branch
 * can still set its own address without the next sync erasing it.
 *
 * Like the menu, this rides a version integer the tills read from their
 * heartbeat response, so the ordinary "nothing changed" case costs nothing.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { requireBranch } = require('../middleware/branch-auth');

/**
 * The keys the cloud owns.
 *
 * Deliberately a list rather than "everything except…": adding a branch-owned
 * setting to the till later should not silently start overwriting it here.
 */
const CLOUD_OWNED = [
  'restaurant_name',
  'restaurant_tagline',
  'tax_rate',
  'employee_discount_rate',
  'currency_symbol',
  'currency_position',
];

/** What each key means, for the dashboard's form. Kept here so both halves agree. */
const FIELDS = [
  { key: 'restaurant_name', label: 'Shop name', type: 'text',
    help: 'Printed at the top of every receipt, at both branches.' },
  { key: 'restaurant_tagline', label: 'Tagline', type: 'text',
    help: 'Optional line under the name.' },
  { key: 'tax_rate', label: 'Tax rate (%)', type: 'number',
    help: 'Applied to every sale. 0 for none.' },
  { key: 'employee_discount_rate', label: 'Staff discount (%)', type: 'number',
    help: 'Taken off when a sale is marked as a staff purchase.' },
  { key: 'currency_symbol', label: 'Currency symbol', type: 'text',
    help: 'Shown on screen and on receipts.' },
  { key: 'currency_position', label: 'Symbol position', type: 'select',
    options: ['before', 'after'], help: 'Rs 500, or 500 Rs.' },
];

async function currentVersion() {
  const row = await db.one('SELECT version FROM settings_version WHERE id = 1');
  return row ? Number(row.version) : 0;
}

async function readAll() {
  const rows = await db.q('SELECT key, value FROM cloud_settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/* ------------------------------------------------------- the dashboard -- */

router.get('/', requireUser, async (req, res) => {
  try {
    res.json({
      settings: await readAll(),
      version: await currentVersion(),
      fields: FIELDS,
      // Named so the dashboard can say plainly what it does not control,
      // rather than leaving the owner to wonder where the printer settings are.
      branch_owned: [
        'delivery_price', 'receipt_footer', 'restaurant_address',
        'restaurant_phone', 'paper_size', 'auto_print',
        'show_tax', 'show_cashier', 'show_order_number', 'show_payment',
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/', requireUser, async (req, res) => {
  const incoming = req.body || {};
  const keys = Object.keys(incoming).filter(k => CLOUD_OWNED.includes(k));

  if (!keys.length) {
    return res.status(400).json({
      error: 'No shop-wide settings in that request. Branch settings are changed on the till.',
    });
  }

  try {
    const version = await db.tx(async (client) => {
      for (const key of keys) {
        await client.query(`
          INSERT INTO cloud_settings (key, value) VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `, [key, String(incoming[key])]);
      }
      const r = await client.query(
        'UPDATE settings_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
      return r.rows[0].version;
    });

    res.json({ settings: await readAll(), version: Number(version), updated: keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------- the tills -- */

/**
 * GET /api/settings/snapshot — the shop-wide settings, for a till.
 *
 * Returns only the allow-listed keys, so a till applying this wholesale still
 * cannot lose its own address or printer configuration.
 */
router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const all = await readAll();
    const shared = {};
    CLOUD_OWNED.forEach(k => { if (all[k] != null) shared[k] = all[k]; });
    res.json({ version: await currentVersion(), settings: shared });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.CLOUD_OWNED = CLOUD_OWNED;
module.exports.currentVersion = currentVersion;
