/**
 * Load the shop's menu into the cloud, once.
 *
 *   DATABASE_URL=... node scripts/import-menu.js
 *
 * The cloud becomes the menu's owner, so it needs the current menu to start
 * from. This reads `backend/db/menu-data.js` — the same file that seeds a fresh
 * till — so both sides begin identical rather than the cloud starting empty and
 * wiping every branch on the first snapshot.
 *
 * Refuses to run twice. Re-importing would duplicate every item, and since the
 * tills pull whatever is here, that would land on the shop floor.
 */
const path = require('path');
const db = require('../db/pg');
const { createSchema } = require('../db/schema');
const { MENU, DEALS } = require(path.join(__dirname, '..', '..', 'backend', 'db', 'menu-data.js'));

(async () => {
  await createSchema(db);

  const existing = await db.one('SELECT COUNT(*)::int AS n FROM menu_items');
  if (existing.n > 0) {
    console.error(`\n  The cloud already holds ${existing.n} menu items.`);
    console.error('  Refusing to import again — edit on the dashboard instead.\n');
    process.exit(1);
  }

  const result = await db.tx(async (client) => {
    const itemIds = new Map();
    const variantIds = new Map();

    for (const m of MENU) {
      const hasVariants = Array.isArray(m.v) && m.v.length > 0;
      const r = await client.query(`
        INSERT INTO menu_items (name, category, price, has_variants, description, active)
        VALUES ($1,$2,$3,$4,$5,1) RETURNING id
      `, [m.n, m.c, hasVariants ? 0 : (m.p || 0), hasVariants ? 1 : 0, m.d || null]);
      itemIds.set(m.n, r.rows[0].id);

      if (hasVariants) {
        for (const [i, [label, price]] of m.v.entries()) {
          const v = await client.query(
            'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
            [r.rows[0].id, label, price, i]);
          variantIds.set(`${m.n} ${label}`, v.rows[0].id);
        }
      }
    }

    const warnings = [];
    for (const d of DEALS) {
      const r = await client.query(`
        INSERT INTO deals (name, description, price, deal_group, active)
        VALUES ($1,$2,$3,$4,1) RETURNING id
      `, [d.n, d.d, d.p, d.g]);

      for (const [itemName, qty, variantLabel] of d.items) {
        const itemId = itemIds.get(itemName);
        if (!itemId) { warnings.push(`${d.n}: no menu item "${itemName}"`); continue; }
        const variantId = variantLabel ? (variantIds.get(`${itemName} ${variantLabel}`) || null) : null;
        if (variantLabel && !variantId) warnings.push(`${d.n}: "${itemName}" has no variant "${variantLabel}"`);
        await client.query(
          'INSERT INTO deal_items (deal_id, menu_item_id, quantity, variant_id) VALUES ($1,$2,$3,$4)',
          [r.rows[0].id, itemId, qty, variantId]);
      }
    }

    // Starts at 1, not 0: a till that has never synced records 0, so any
    // imported menu must look newer than "no menu at all".
    const v = await client.query(
      'UPDATE menu_version SET version = GREATEST(version, 0) + 1, updated_at = NOW() WHERE id = 1 RETURNING version');

    return { items: MENU.length, deals: DEALS.length, warnings, version: v.rows[0].version };
  });

  console.log(`\n  Imported ${result.items} menu items and ${result.deals} deals.`);
  console.log(`  Menu version is now ${result.version}; tills will pull it on their next heartbeat.`);
  if (result.warnings.length) {
    console.log('\n  Warnings:');
    result.warnings.forEach(w => console.log('    - ' + w));
  }
  console.log('');
  await db.close();
})().catch(async (err) => {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
});
