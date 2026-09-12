/**
 * Sales ingest.
 *
 * The opposite contract to the heartbeat next door: this channel must never
 * lose a row. A missed heartbeat is superseded a moment later; a missed sale is
 * money the owner never sees.
 *
 * The design that makes that survivable on a bad link is **idempotency**, not
 * careful delivery. On a fluctuating connection the till frequently cannot tell
 * whether a batch arrived — the request may have been answered after it gave
 * up, or the reply lost on the way back. Rather than trying to resolve that
 * ambiguity, re-sending is made harmless: every row is keyed on
 * `(branch_id, local_id)`, so the same batch applied three times leaves exactly
 * one copy of each sale.
 *
 * The branch always comes from the API key, never from the body.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireBranch } = require('../middleware/branch-auth');

/** Caps a single request. The till batches to match; a bad payload is refused before it is worked on. */
const MAX_ROWS = 200;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

/**
 * Build one multi-row upsert for a whole batch.
 *
 * The first version issued a statement per row, which was correct and far too
 * slow: a hundred orders with three hundred line items meant four hundred
 * sequential round trips to a database in another country. At a couple of
 * hundred milliseconds each that is well over a minute, and the till's push
 * timed out before it finished — so a shop with a real backlog could never
 * catch up at all.
 *
 * One statement per table per batch turns that into three round trips.
 *
 * Postgres caps a statement at 65535 parameters. The widest table here is
 * orders at 25 columns, so the till's batch of 100 uses 2,500 — comfortably
 * inside it, but the cap is why BATCH_SIZE and MAX_ROWS exist rather than
 * sending everything at once.
 *
 * `RETURNING` is what makes the order_items remap possible in the same trip:
 * it hands back each row's cloud id alongside the till's local_id.
 */
function buildUpsert(table, columns, rows, valuesFor, receivedAt, branchId, conflictWhere) {
  const cols = ['branch_id', 'local_id', ...columns, 'received_at'];
  const params = [];
  const tuples = [];

  rows.forEach((row) => {
    const values = [branchId, num(row.id), ...valuesFor(row), receivedAt];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    tuples.push(`(${placeholders.join(', ')})`);
  });

  // received_at is refreshed too, so "when did the cloud last hear about this
  // row" stays honest after an update.
  const updates = [...columns, 'received_at'].map(c => `${c} = EXCLUDED.${c}`).join(', ');

  return {
    sql: `
      INSERT INTO ${table} (${cols.join(', ')})
      VALUES ${tuples.join(', ')}
      ON CONFLICT (branch_id, local_id) DO UPDATE SET ${updates}
      ${conflictWhere ? `WHERE ${conflictWhere}` : ''}
      RETURNING id, local_id
    `,
    params,
  };
}

/*
 * The columns each table carries, beyond the (branch_id, local_id) key and
 * received_at. Order matters: it has to match the values function beneath it.
 *
 * Orders are mutable — one already sent can later be voided — so every column
 * is refreshed on conflict rather than only the void fields, and a correction
 * of any kind lands.
 */
const ORDER_COLS = [
  'total', 'discount', 'payment_method', 'status', 'cashier_name', 'cashier_id',
  'created_at', 'order_type', 'delivery_charge', 'local_shift_id', 'table_number',
  'voided_at', 'tax_rate', 'tax_amount', 'is_employee', 'employee_discount',
  'employee_discount_rate', 'voided_by', 'voided_by_id',
  'customer_name', 'customer_phone', 'customer_address',
];
// A shift is sent while open and again once counted, so it must update too.
const SHIFT_COLS = [
  'staff_id', 'staff_name', 'opening_cash', 'closing_cash', 'expected_cash',
  'variance', 'opened_at', 'closed_at', 'status',
];
const EXPENSE_COLS = [
  'local_shift_id', 'staff_id', 'staff_name', 'category', 'description',
  'amount', 'from_drawer', 'created_at',
];
// Note what is absent: the PIN, hashed or otherwise. It is of no use to the
// dashboard, and every copy of a credential is another place it can leak from.
const STAFF_COLS = ['name', 'role', 'color', 'active'];
const INGREDIENT_COLS = ['name', 'unit', 'stock', 'low_stock_threshold', 'cost_per_unit'];
const CUSTOMER_COLS = [
  'name', 'phone', 'address', 'order_count', 'total_spent',
  'first_order_at', 'last_order_at',
];

const ORDER_VALUES = (r) => [
  num(r.total), num(r.discount), str(r.payment_method), str(r.status),
  str(r.cashier_name), num(r.cashier_id), str(r.created_at),
  str(r.order_type), num(r.delivery_charge), num(r.shift_id),
  str(r.table_number), str(r.voided_at), num(r.tax_rate), num(r.tax_amount),
  num(r.is_employee), num(r.employee_discount), num(r.employee_discount_rate),
  str(r.voided_by), num(r.voided_by_id),
  str(r.customer_name), str(r.customer_phone), str(r.customer_address),
];

async function ingestOrders(client, branchId, rows, receivedAt) {
  const orderUpsert = buildUpsert('orders', ORDER_COLS, rows, ORDER_VALUES, receivedAt, branchId);
  const result = await client.query(orderUpsert.sql, orderUpsert.params);

  /*
   * Remap the line items onto the CLOUD's order id.
   *
   * The till sends its own order id, which is only unique within that branch.
   * Storing it unchanged would make E-18's items join onto CBR Town's order of
   * the same number — quietly attributing one shop's food to the other's sale.
   */
  const cloudIdFor = new Map(result.rows.map(r => [Number(r.local_id), r.id]));

  const items = [];
  for (const row of rows) {
    const orderId = cloudIdFor.get(num(row.id));
    for (const item of row.items || []) {
      items.push({ item, orderId });
    }
  }
  if (!items.length) return;

  const params = [];
  const tuples = items.map(({ item, orderId }) => {
    const values = [
      branchId, num(item.id), orderId, num(item.menu_item_id), str(item.name),
      num(item.price), num(item.quantity), num(item.is_deal), num(item.variant_id),
      // Resolved by the till, because menu item ids are per-machine and cannot
      // be resolved here.
      str(item.category),
    ];
    return `(${values.map(v => { params.push(v); return `$${params.length}`; }).join(', ')})`;
  });

  await client.query(`
    INSERT INTO order_items (
      branch_id, local_id, order_id, menu_item_id, name, price, quantity,
      is_deal, variant_id, category
    ) VALUES ${tuples.join(', ')}
    ON CONFLICT (branch_id, local_id) DO UPDATE SET
      order_id = EXCLUDED.order_id, name = EXCLUDED.name, price = EXCLUDED.price,
      quantity = EXCLUDED.quantity, is_deal = EXCLUDED.is_deal,
      variant_id = EXCLUDED.variant_id, category = EXCLUDED.category
  `, params);
}

/** The simple tables: one multi-row upsert, no children to remap. */
function simpleIngest(table, columns, valuesFor, conflictWhere, after) {
  return async (client, branchId, rows, receivedAt) => {
    const { sql, params } = buildUpsert(
      table, columns, rows, valuesFor, receivedAt, branchId, conflictWhere);
    await client.query(sql, params);
    if (after) await after(client, branchId);
  };
}

/**
 * Undo anything this push resurrected.
 *
 * A till pushes its whole staff list every five minutes and knows nothing about
 * deletions until its next pull. Without this, deleting somebody on the
 * dashboard would work and then silently undo itself within the next five
 * minutes — which looks exactly like the delete button not working.
 *
 * Done after the upsert rather than by filtering rows beforehand: the upsert is
 * one multi-row statement, and one extra DELETE is both cheaper and much harder
 * to get subtly wrong than per-row filtering inside it.
 */
async function dropDeletedStaff(client, branchId) {
  await client.query(db.toPg(`
    DELETE FROM staff s
     USING staff_deletions d
     WHERE s.branch_id = ? AND d.branch_id = s.branch_id AND d.local_id = s.local_id
  `), [branchId]);
}

const HANDLERS = {
  orders: ingestOrders,

  shifts: simpleIngest('shifts', SHIFT_COLS, r => [
    num(r.staff_id), str(r.staff_name), num(r.opening_cash), num(r.closing_cash),
    num(r.expected_cash), num(r.variance), str(r.opened_at), str(r.closed_at), str(r.status),
  ]),

  expenses: simpleIngest('expenses', EXPENSE_COLS, r => [
    num(r.shift_id), num(r.staff_id), str(r.staff_name), str(r.category),
    str(r.description), num(r.amount), num(r.from_drawer), str(r.created_at),
  ]),

  /*
   * Staff and stock are pushed so the owner can see them on the dashboard.
   *
   * STAFF_COLS still carries no PIN. The till has no reason to send one up: the
   * hash travels the other way now, from routes/staff.js down to the till, and
   * a push that carried it back would achieve nothing but a second copy in
   * flight.
   *
   * The WHERE clause is what makes the two directions coexist. A row the owner
   * has touched is marked origin = 'cloud', and this push must not overwrite
   * it — otherwise deactivating somebody on the dashboard would be undone by
   * that same till's next push thirty seconds later, which looks exactly like
   * the button not working.
   */
  staff: simpleIngest('staff', STAFF_COLS, r => [
    str(r.name), str(r.role), str(r.color), num(r.active),
  ], "staff.origin <> 'cloud'", dropDeletedStaff),

  ingredients: simpleIngest('ingredients', INGREDIENT_COLS, r => [
    str(r.name), str(r.unit), num(r.stock), num(r.low_stock_threshold), num(r.cost_per_unit),
  ]),

  // The delivery customer book. Counts and totals are maintained by the till as
  // orders are taken, so they arrive already correct and are simply carried.
  customers: simpleIngest('customers', CUSTOMER_COLS, r => [
    str(r.name), str(r.phone), str(r.address),
    num(r.order_count), num(r.total_spent),
    str(r.first_order_at), str(r.last_order_at),
  ]),
};

/**
 * POST /api/ingest/batch — one table's worth of pending rows.
 *
 * All-or-nothing: the whole batch commits or none of it does. A partial batch
 * would leave the till marking rows synced that the cloud never stored.
 */
router.post('/batch', requireBranch, async (req, res) => {
  const { table, rows } = req.body || {};
  const handler = HANDLERS[table];

  if (!handler) {
    return res.status(400).json({ error: `Unknown table "${table}"` });
  }
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows must be an array' });
  }
  if (rows.length > MAX_ROWS) {
    return res.status(413).json({ error: `Batch too large (max ${MAX_ROWS} rows)` });
  }
  if (rows.length === 0) {
    return res.json({ ok: true, accepted: 0 });
  }

  try {
    const receivedAt = Date.now();

    await db.tx(async (client) => {
      await handler(client, req.branch.id, rows, receivedAt);
      await client.query(`
        INSERT INTO sync_cursor (branch_id, table_name, rows_received, last_synced_ms)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, table_name) DO UPDATE SET
          rows_received = sync_cursor.rows_received + EXCLUDED.rows_received,
          last_synced_ms = EXCLUDED.last_synced_ms
      `, [req.branch.id, table, rows.length, receivedAt]);
    });

    // The till marks rows synced only on this reply, so it is the till's proof
    // that the data is durable here.
    res.json({ ok: true, accepted: rows.length });
  } catch (err) {
    console.error(`Ingest of ${table} failed:`, err.message);
    res.status(500).json({ error: 'Could not store batch' });
  }
});

module.exports = router;
