/**
 * The menu — the one thing the cloud owns outright.
 *
 * Everything else in this system travels upward: the branches record sales and
 * the cloud reports on them. The menu goes the other way, and that only works
 * because there is exactly **one writer**. The owner edits here; the tills only
 * ever read. With a single writer there are no conflicts to resolve, which
 * removes the hardest part of synchronisation by design rather than solving it.
 *
 * The consequence, accepted deliberately: the tills' own Menu and Deals screens
 * become read-only, for the owner too. A local edit would be silently discarded
 * by the next snapshot, and silently discarding somebody's work is worse than
 * not letting them start.
 *
 * Two endpoints exist for the tills, and the split between them is what makes
 * this survivable on a bad connection:
 *
 *   GET /api/menu/version   a single integer, a few bytes, asked constantly
 *   GET /api/menu/snapshot  the whole menu, fetched only when that number moves
 *
 * A till on a weak link can always afford the first. It downloads the second
 * rarely, and if that download fails it simply keeps selling from the menu it
 * already has.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { requireBranch } = require('../middleware/branch-auth');

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

/**
 * Every edit moves the version.
 *
 * Called inside the same transaction as the change itself, so a till can never
 * see a version that promises a menu the cloud did not manage to save.
 */
async function bumpVersion(client) {
  const r = await client.query(
    'UPDATE menu_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
  return r.rows[0].version;
}

async function currentVersion() {
  const row = await db.one('SELECT version FROM menu_version WHERE id = 1');
  return row ? Number(row.version) : 0;
}

/* ------------------------------------------------------- the dashboard -- */

/** Matches the till's own `GET /api/menu`, so its Menu screen works unchanged. */
router.get('/', requireUser, async (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  try {
    const items = await db.q(
      `SELECT * FROM menu_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, name`);
    const variants = await db.q('SELECT * FROM item_variants ORDER BY sort_order');

    const byItem = new Map();
    variants.forEach(v => {
      if (!byItem.has(v.menu_item_id)) byItem.set(v.menu_item_id, []);
      byItem.get(v.menu_item_id).push({
        id: v.id, label: v.label, price: v.price, sort_order: v.sort_order,
      });
    });

    res.json(items.map(item => ({
      ...item,
      variants: item.has_variants ? (byItem.get(item.id) || []) : [],
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireUser, async (req, res) => {
  const { name, category, price, description, has_variants, variants, image_url } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });

  try {
    const result = await db.tx(async (client) => {
      const item = await client.query(`
        INSERT INTO menu_items (name, category, price, image_url, has_variants, description, active)
        VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING *
      `, [str(name), str(category), num(price) || 0, str(image_url),
          has_variants ? 1 : 0, str(description)]);

      const id = item.rows[0].id;
      if (has_variants && Array.isArray(variants)) {
        for (const [i, v] of variants.entries()) {
          await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4)',
            [id, str(v.label), num(v.price) || 0, num(v.sort_order) ?? i]);
        }
      }
      const version = await bumpVersion(client);
      return { ...item.rows[0], menu_version: version };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireUser, async (req, res) => {
  const { name, category, price, description, has_variants, variants, active, image_url } = req.body || {};
  try {
    const result = await db.tx(async (client) => {
      const item = await client.query(`
        UPDATE menu_items SET
          name = COALESCE($1, name),
          category = COALESCE($2, category),
          price = COALESCE($3, price),
          image_url = COALESCE($4, image_url),
          has_variants = COALESCE($5, has_variants),
          description = COALESCE($6, description),
          active = COALESCE($7, active)
        WHERE id = $8 RETURNING *
      `, [str(name), str(category), num(price), str(image_url),
          has_variants == null ? null : (has_variants ? 1 : 0),
          str(description), active == null ? null : (active ? 1 : 0), req.params.id]);

      if (!item.rows.length) return null;

      // Variants are replaced wholesale rather than diffed: the screen sends the
      // complete list, and matching them up by hand would be guesswork.
      if (Array.isArray(variants)) {
        await client.query('DELETE FROM item_variants WHERE menu_item_id = $1', [req.params.id]);
        for (const [i, v] of variants.entries()) {
          await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4)',
            [req.params.id, str(v.label), num(v.price) || 0, num(v.sort_order) ?? i]);
        }
      }
      const version = await bumpVersion(client);
      return { ...item.rows[0], menu_version: version };
    });

    if (!result) return res.status(404).json({ error: 'Menu item not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retire an item rather than deleting it.
 *
 * Exactly as the till does. Sales reporting joins order_items back to the menu,
 * so a hard delete would take the category off every past order — rewriting
 * figures that have already been reported and exported. Retired items vanish
 * from the menu and still resolve for reporting.
 */
router.delete('/:id', requireUser, async (req, res) => {
  try {
    const result = await db.tx(async (client) => {
      const r = await client.query(
        'UPDATE menu_items SET active = 0 WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return null;
      await bumpVersion(client);
      return true;
    });
    if (!result) return res.status(404).json({ error: 'Menu item not found' });
    res.json({ success: true, retired: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------- the tills -- */

/**
 * GET /api/menu/version — a few bytes, asked constantly.
 *
 * Open to a branch key rather than a session: this is a till asking.
 */
router.get('/version', requireBranch, async (req, res) => {
  try {
    res.json({ version: await currentVersion() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/menu/snapshot — the whole menu, in db/menu-data.js's shape.
 *
 * A whole snapshot, never a diff. Diffs have to arrive in order and in full;
 * a snapshot either applies or it does not, and missing three of them is the
 * same as missing one. On a link that drops mid-download that difference is
 * the whole game.
 *
 * The version is returned *with* the document so the till records exactly what
 * it applied, rather than whatever the version happens to be by the time it
 * finishes writing.
 */
router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const version = await currentVersion();
    const items = await db.q('SELECT * FROM menu_items WHERE active = 1 ORDER BY category, name');
    const variants = await db.q('SELECT * FROM item_variants ORDER BY sort_order');
    const deals = await db.q('SELECT * FROM deals WHERE active = 1 ORDER BY name');
    const dealItems = await db.q(`
      SELECT di.deal_id, di.quantity, di.description,
             mi.name AS item_name, iv.label AS variant_label
        FROM deal_items di
        LEFT JOIN menu_items mi ON mi.id = di.menu_item_id
        LEFT JOIN item_variants iv ON iv.id = di.variant_id
       ORDER BY di.id
    `);

    const variantsByItem = new Map();
    variants.forEach(v => {
      if (!variantsByItem.has(v.menu_item_id)) variantsByItem.set(v.menu_item_id, []);
      variantsByItem.get(v.menu_item_id).push(v);
    });

    // The till's applyMenu() links deal lines by *name*, not by id, precisely
    // because ids differ per machine. So the snapshot speaks in names.
    const linesByDeal = new Map();
    dealItems.forEach(d => {
      if (!d.item_name) return;
      if (!linesByDeal.has(d.deal_id)) linesByDeal.set(d.deal_id, []);
      linesByDeal.get(d.deal_id).push([d.item_name, d.quantity || 1, d.variant_label || null]);
    });

    res.json({
      version,
      MENU: items.map(i => ({
        n: i.name,
        c: i.category,
        p: i.price,
        d: i.description || undefined,
        v: i.has_variants
          ? (variantsByItem.get(i.id) || []).map(v => [v.label, v.price])
          : undefined,
      })),
      DEALS: deals.map(d => ({
        n: d.name,
        d: d.description || '',
        p: d.price,
        g: d.deal_group,
        items: linesByDeal.get(d.id) || [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.currentVersion = currentVersion;
module.exports.bumpVersion = bumpVersion;
