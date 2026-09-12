/**
 * Deals — owned by the cloud, like the menu it is built from.
 *
 * Response shapes match the till's `routes/deals.js` so its Deals screen works
 * on the dashboard unchanged. Every write moves `menu_version`, because a deal
 * is part of the menu the tills pull: changing a deal's price without the tills
 * hearing about it would have them selling at yesterday's price indefinitely.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { bumpVersion } = require('./menu');

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

/** The same per-deal line shape the till returns, including the pizza fields. */
const DEAL_ITEMS_SQL = `
  SELECT di.quantity, di.description, di.variant_id,
         mi.id AS menu_item_id, mi.name, mi.price, mi.category, mi.has_variants,
         iv.label AS variant_label, iv.price AS variant_price
    FROM deal_items di
    LEFT JOIN menu_items mi ON mi.id = di.menu_item_id
    LEFT JOIN item_variants iv ON iv.id = di.variant_id
   WHERE di.deal_id = ?
   ORDER BY di.id
`;

async function withItems(deal) {
  return { ...deal, items: await db.q(DEAL_ITEMS_SQL, [deal.id]) };
}

router.get('/', requireUser, async (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  try {
    const deals = await db.q(
      `SELECT * FROM deals ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name`);
    res.json(await Promise.all(deals.map(withItems)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireUser, async (req, res) => {
  try {
    const deal = await db.one('SELECT * FROM deals WHERE id = ?', [req.params.id]);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json(await withItems(deal));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Replace a deal's lines wholesale — the screen sends the complete list. */
async function writeItems(client, dealId, items) {
  await client.query('DELETE FROM deal_items WHERE deal_id = $1', [dealId]);
  for (const it of items || []) {
    await client.query(`
      INSERT INTO deal_items (deal_id, menu_item_id, quantity, variant_id, description)
      VALUES ($1, $2, $3, $4, $5)
    `, [dealId, num(it.menu_item_id), num(it.quantity) || 1,
        num(it.variant_id), str(it.description)]);
  }
}

router.post('/', requireUser, async (req, res) => {
  const { name, description, price, deal_group, items, image_url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const created = await db.tx(async (client) => {
      const r = await client.query(`
        INSERT INTO deals (name, description, price, image_url, deal_group, active)
        VALUES ($1,$2,$3,$4,$5,1) RETURNING *
      `, [str(name), str(description), num(price) || 0, str(image_url), str(deal_group)]);
      await writeItems(client, r.rows[0].id, items);
      await bumpVersion(client);
      return r.rows[0];
    });
    res.status(201).json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireUser, async (req, res) => {
  const { name, description, price, deal_group, items, active, image_url } = req.body || {};
  try {
    const updated = await db.tx(async (client) => {
      const r = await client.query(`
        UPDATE deals SET
          name = COALESCE($1, name),
          description = COALESCE($2, description),
          price = COALESCE($3, price),
          image_url = COALESCE($4, image_url),
          deal_group = COALESCE($5, deal_group),
          active = COALESCE($6, active)
        WHERE id = $7 RETURNING *
      `, [str(name), str(description), num(price), str(image_url), str(deal_group),
          active == null ? null : (active ? 1 : 0), req.params.id]);

      if (!r.rows.length) return null;
      if (Array.isArray(items)) await writeItems(client, req.params.id, items);
      await bumpVersion(client);
      return r.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Deal not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Retired, not deleted — past orders reference these. */
router.delete('/:id', requireUser, async (req, res) => {
  try {
    const done = await db.tx(async (client) => {
      const r = await client.query(
        'UPDATE deals SET active = 0 WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return null;
      await bumpVersion(client);
      return true;
    });
    if (!done) return res.status(404).json({ error: 'Deal not found' });
    res.json({ success: true, retired: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
