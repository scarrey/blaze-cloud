/**
 * Refuse to wipe a database that is in use.
 *
 * Two of these tests TRUNCATE tables to start from a known state. That is fine
 * against a scratch project and ruinous against the real one — and the warning
 * in a README is worth exactly nothing, as I proved by running
 * menu-downlink.js against the live Supabase and leaving every menu item
 * retired. The dashboard's Menu tab went blank and the next person to run
 * import-menu.js was told, correctly and unhelpfully, that a menu already
 * existed.
 *
 * So the check is in the code now. A test that destroys data has to be told
 * twice: once by pointing DATABASE_URL somewhere, and again by saying out loud
 * that wiping it is intended.
 */

const db = require('../db/pg');

/**
 * @param what  a short description of what will be destroyed, for the message
 */
async function requireScratchDatabase(what) {
  if (!process.env.DATABASE_URL) {
    console.error('\n  DATABASE_URL is not set.\n');
    process.exit(1);
  }

  // Count what is actually at risk rather than guessing from the URL: a
  // "scratch" project that has been used for a fortnight is not scratch.
  let counts;
  try {
    counts = await db.one(`
      SELECT (SELECT COUNT(*)::int FROM orders)     AS orders,
             (SELECT COUNT(*)::int FROM menu_items) AS menu_items
    `);
  } catch (err) {
    // No tables yet: an empty project, which is exactly what this wants.
    return;
  }

  const populated = counts.orders > 0 || counts.menu_items > 0;
  if (!populated) return;

  if (process.env.BLAZE_ALLOW_DESTRUCTIVE === '1') {
    console.log(`  (wiping ${counts.orders} orders and ${counts.menu_items} menu items — BLAZE_ALLOW_DESTRUCTIVE=1)\n`);
    return;
  }

  console.error('');
  console.error(`  This test destroys ${what}.`);
  console.error(`  The database it is pointed at holds ${counts.orders} orders and ${counts.menu_items} menu items.`);
  console.error('');
  console.error('  Point DATABASE_URL at a scratch Supabase project, or, if you');
  console.error('  really mean to wipe this one, re-run with BLAZE_ALLOW_DESTRUCTIVE=1');
  console.error('');
  process.exit(1);
}

module.exports = { requireScratchDatabase };
