/**
 * Reporting — the cloud's copy.
 *
 * Ported from `backend/routes/reports.js`. It is kept as textually close to the
 * till's copy as the dialect allows, because when the till's reporting changes
 * this has to change with it, and a readable diff is what makes that possible.
 *
 * **This is a Postgres translation, not a copy.** The earlier SQLite cloud let
 * the file across untouched; Supabase does not. Every difference below is a
 * place where a mistake would produce a query that still runs and quietly
 * returns a different number — which is why the port is guarded by a test that
 * compares all ten endpoints against the till's output field by field, rather
 * than by reading.
 *
 * What had to change, beyond `?` placeholders (handled mechanically by `toPg`
 * in db/pg.js):
 *
 *   - `DATE(x)` -> `x::date`. Timestamps are stored as the till's own local
 *     wall-clock text, so casting compares exactly what the shop recorded.
 *   - `strftime(...)` -> `to_char(...)` / `EXTRACT(...)`. No equivalent exists.
 *   - `GROUP_CONCAT` -> `STRING_AGG`.
 *   - **Every aggregate is cast.** `pg` returns `bigint` and `numeric` as
 *     strings to avoid precision loss, so an uncast `COUNT(*)` arrives as "32"
 *     and reaches the dashboard as a string.
 *   - **Dates are formatted, not cast, in SELECT lists.** `x::date` returns a
 *     JS Date that JSON-encodes as a full ISO timestamp, so an evening sale on
 *     the 7th would come back as the 6th.
 *   - Postgres requires SELECT and GROUP BY to agree; SQLite did not.
 *
 * And three differences from the till that are about role rather than dialect,
 * each marked CLOUD: below — scoping, the stored `order_items.category`, and
 * reporting the till's own `local_id` as the order number.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');

const { localToday } = require('../db/local-date');
const { requireUser } = require('../middleware/session');

/**
 * CLOUD: narrow a report to one branch.
 *
 * The till's copy also scopes a manager to their own sales. Here the reader is
 * the owner, who sees the whole shop and may narrow with `?branch=<id>`.
 *
 * A dashboard account carrying a `branch_id` — none today, but the column
 * exists so per-branch logins are a row rather than a migration — is pinned to
 * that branch and cannot widen the view by passing a different one.
 */
function scopeOrders(req, alias = 'orders') {
  const pinned = req.user && req.user.branchId;
  const branch = pinned || Number(req.query.branch) || null;
  if (!branch) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.branch_id = ?`, params: [branch] };
}

/** CLOUD: the same, for expenses. */
function scopeExpenses(req, alias = 'expenses') {
  const pinned = req.user && req.user.branchId;
  const branch = pinned || Number(req.query.branch) || null;
  if (!branch) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.branch_id = ?`, params: [branch] };
}

function getDateRange(req) {
  // Local wall-clock, not toISOString's UTC — at UTC+5 that named yesterday
  // for the first five hours of every trading day.
  const today = localToday();
  const from = req.query.from || today;
  const to = req.query.to || today;
  return { from, to };
}

// KPI summary
router.get('/kpi', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req);
  const expScope = scopeExpenses(req);
  try {
    const summary = await db.one(`
      SELECT
        COUNT(*)::int as total_orders,
        COALESCE(SUM(total)::float8, 0) as total_revenue,
        COALESCE(AVG(total)::float8, 0) as avg_order_value,
        COALESCE(SUM(discount)::float8, 0) as total_discounts
      FROM orders
      WHERE created_at::date BETWEEN ?::date AND ?::date
      AND status != 'voided'${scope.sql}
    `, [from, to, ...scope.params]);

    const prevFrom = new Date(from);
    prevFrom.setDate(prevFrom.getDate() - (new Date(to) - new Date(from)) / 86400000 - 1);
    const prevTo = new Date(from);
    prevTo.setDate(prevTo.getDate() - 1);

    const prev = await db.one(`
      SELECT COALESCE(SUM(total)::float8, 0) as total_revenue, COUNT(*)::int as total_orders
      FROM orders
      WHERE created_at::date BETWEEN ?::date AND ?::date
      AND status != 'voided'${scope.sql}
    `, [prevFrom.toISOString().split('T')[0], prevTo.toISOString().split('T')[0], ...scope.params]);

    /*
     * Expenses belong on the headline, not in a corner.
     *
     * Takings alone flatter the day: a shop can ring up 40,000 and still be
     * down if 9,000 went out on fuel and supplies. `net_revenue` is what the
     * owner actually keeps, and it is the figure the KPI row leads with.
     *
     * Every expense counts here, not only the ones paid out of the drawer —
     * the drawer flag is about reconciling the till, whereas this is about
     * what the day cost. That distinction is preserved in the split below so
     * the two questions never get confused.
     */
    const expenses = await db.one(`
      SELECT
        COALESCE(SUM(amount)::float8, 0) AS total_expenses,
        COALESCE(SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8, 0) AS drawer_expenses,
        COUNT(*)::int AS expense_count
      FROM expenses
      WHERE created_at::date BETWEEN ?::date AND ?::date${expScope.sql}
    `, [from, to, ...expScope.params]);

    /*
     * Wages, counted separately from expenses.
     *
     * Kept out of `total_expenses` on purpose. That figure means petty cash out
     * of the shop — fuel, supplies, a staff meal — and it is what the drawer is
     * reconciled against. Wages are a different kind of cost, paid monthly and
     * never through the till, and folding them in would both distort the daily
     * expense figures and make the drawer look short by a month's salaries.
     *
     * Dated on when the money was handed over, not on the month the payslip is
     * labelled with: August's wages paid in September are what September cost.
     *
     * The till has no payroll, so its own /kpi never returns this and the
     * Reports screen simply does not draw the card. See routes/payroll.js.
     */
    // Scoped through the employees table, which is where a wage's branch
    // lives — scopeExpenses defaults to the expenses table's own alias.
    const wageScope = scopeExpenses(req, 'e');
    const wages = await db.one(`
      SELECT COALESCE(SUM(p.paid_amount)::float8, 0) AS wages_paid
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
       WHERE p.paid_on BETWEEN ?::date AND ?::date${wageScope.sql}
    `, [from, to, ...wageScope.params]);

    const revenueTrend = prev.total_revenue > 0
      ? (((summary.total_revenue - prev.total_revenue) / prev.total_revenue) * 100).toFixed(1)
      : 0;
    const ordersTrend = prev.total_orders > 0
      ? (((summary.total_orders - prev.total_orders) / prev.total_orders) * 100).toFixed(1)
      : 0;

    res.json({
      ...summary,
      ...expenses,
      wages_paid: Number(wages.wages_paid) || 0,
      // Net is what the owner actually keeps, so it has to carry the wage bill
      // too. Without it a month with a full payroll behind it reads as pure
      // profit, which is the single most misleading number this API could
      // return.
      net_revenue: summary.total_revenue - expenses.total_expenses - (Number(wages.wages_paid) || 0),
      revenue_trend: revenueTrend,
      orders_trend: ordersTrend,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revenue over time
router.get('/revenue-over-time', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const groupBy = req.query.groupBy || 'day';
  const scope = scopeOrders(req);
  try {
    let query;
    if (groupBy === 'hour') {
      query = `
        SELECT to_char(created_at::timestamp, 'HH24:00') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'HH24:00')
        ORDER BY to_char(created_at::timestamp, 'HH24:00')
      `;
    } else if (groupBy === 'month') {
      query = `
        SELECT to_char(created_at::timestamp, 'YYYY-MM') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'YYYY-MM')
        ORDER BY period
      `;
    } else {
      query = `
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
        ORDER BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      `;
    }
    const data = await db.q(query, [from, to, ...scope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top selling items
router.get('/top-items', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    const items = await db.q(`
      SELECT
        oi.name,
        SUM(oi.quantity)::int as total_qty,
        SUM(oi.price * oi.quantity)::float8 as total_revenue,
        COUNT(DISTINCT oi.order_id)::int as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY oi.name
      -- Tie-broken deliberately. Ordering by total_qty alone means items that sold
      -- the same number of units come back in whatever order the engine
      -- happens to produce, so the tenth row — and therefore every
      -- percentage, which is computed against the ten — could change between
      -- runs for no reason at all.
      ORDER BY total_qty DESC, total_revenue DESC, oi.name ASC
      LIMIT 10
    `, [from, to, ...scope.params]);

    const totalRevenue = items.reduce((s, i) => s + i.total_revenue, 0);
    const result = items.map(i => ({
      ...i,
      percentage: totalRevenue > 0 ? ((i.total_revenue / totalRevenue) * 100).toFixed(1) : 0
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sales by category
router.get('/by-category', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    // CLOUD: the till resolves the category at push time and sends it, because
    // menu item ids are per-machine and the join is not resolvable here. The
    // till's own version of this query carries the reasoning behind the CASE it
    // uses — deals share an id space with menu items, so they get their own
    // bucket rather than being filed under an unrelated item's category.
    const data = await db.q(`
      SELECT
        COALESCE(oi.category, 'Uncategorized') AS category,
        SUM(oi.quantity)::int as total_qty,
        SUM(oi.price * oi.quantity)::float8 as total_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY category
      ORDER BY total_revenue DESC
    `, [from, to, ...scope.params]);

    const totalRevenue = data.reduce((s, i) => s + i.total_revenue, 0);
    const result = data.map(i => ({
      ...i,
      percentage: totalRevenue > 0 ? ((i.total_revenue / totalRevenue) * 100).toFixed(1) : 0
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hourly heatmap — last 7 days by default
router.get('/hourly-heatmap', requireUser, async (req, res) => {
  const scope = scopeOrders(req);
  try {
    const data = await db.q(`
      SELECT
        CASE EXTRACT(DOW FROM created_at::timestamp)::int
          WHEN '0' THEN 'Sun'
          WHEN '1' THEN 'Mon'
          WHEN '2' THEN 'Tue'
          WHEN '3' THEN 'Wed'
          WHEN '4' THEN 'Thu'
          WHEN '5' THEN 'Fri'
          WHEN '6' THEN 'Sat'
        END as day,
        -- ::text because SQLite's strftime('%w') returns text, and the
        -- dashboard reuses the till's own screens — a number where they
        -- expect a string would compare unequal and quietly render nothing.
        EXTRACT(DOW FROM created_at::timestamp)::int::text as day_num,
        EXTRACT(HOUR FROM created_at::timestamp)::int as hour,
        COUNT(*)::int as orders,
        COALESCE(SUM(total)::float8, 0) as revenue
      FROM orders
      WHERE created_at::date >= (CURRENT_DATE - INTERVAL '30 days')
      AND status != 'voided'${scope.sql}
      -- Grouped by the raw expressions rather than the output aliases.
      -- Postgres matches a selected expression against the grouping ones
      -- textually, so once day_num gained its ::text cast the CASE above no
      -- longer looked like the thing being grouped. Naming the underlying
      -- EXTRACTs keeps every derived column valid.
      GROUP BY EXTRACT(DOW FROM created_at::timestamp),
               EXTRACT(HOUR FROM created_at::timestamp)
      ORDER BY EXTRACT(DOW FROM created_at::timestamp),
               EXTRACT(HOUR FROM created_at::timestamp)
    `, [...scope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cashier performance
router.get('/cashier-performance', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    const data = await db.q(`
      SELECT
        o.cashier_id,
        o.cashier_name,
        COUNT(*)::int as total_orders,
        COALESCE(SUM(o.total)::float8, 0) as total_revenue,
        COALESCE(AVG(o.total)::float8, 0) as avg_order_value,
        COALESCE(SUM(o.discount)::float8, 0) as total_discounts
      FROM orders o
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY o.cashier_id, o.cashier_name
      ORDER BY total_revenue DESC
    `, [from, to, ...scope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Detailed report — one row per order. Backs the Reports table and the
 * "Detailed" CSV export.
 *
 * Previously this returned `o.*` plus `items_summary`, but both the table and
 * the exporter read `row.subtotal` and `row.items`. Neither existed:
 * `subtotal` is not a column on `orders` (only total/discount/delivery_charge
 * are), and the concatenated item list was named `items_summary`. The result
 * was `undefined.toLocaleString()` — a hard render crash on the Detailed tab —
 * and `undefined.replace()` in the exporter, so the CSV never downloaded.
 *
 * `subtotal` is now derived from the order's own line items, which is the
 * authoritative figure: total = subtotal - discount + delivery_charge.
 *
 * Voided orders are excluded by default so these rows reconcile with the KPI
 * cards and every other report; pass include_voided=1 to audit them.
 */
router.get('/detailed', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = scopeOrders(req, 'o');

  try {
    const orders = await db.q(`
      SELECT
        -- CLOUD: the till's own number, not the cloud's row id. This is the
        -- number printed on the customer's receipt and written in the shop's
        -- own records, so it is the only one the owner can cross-reference.
        -- The cloud's own id exists purely to join rows together.
        o.local_id AS id,
        o.created_at,
        o.cashier_id,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        o.discount,
        o.tax_rate,
        o.tax_amount,
        o.is_employee,
        o.employee_discount,
        o.employee_discount_rate,
        o.voided_by,
        o.customer_name,
        o.customer_phone,
        o.customer_address,
        o.delivery_charge,
        o.total,
        br.name AS branch_name,
        -- The label the shop actually uses for this sale. Built here rather
        -- than in the browser so the dashboard, the till's Orders screen and
        -- the printed receipt cannot drift apart: one format, one place.
        -- Falls back to the bare number for a branch with no code set.
        CASE WHEN COALESCE(br.code, '') = '' THEN o.local_id::text
             ELSE br.code || '-' || LPAD(o.local_id::text, 3, '0') END AS order_no,
        COALESCE(SUM(oi.price * oi.quantity)::float8, 0) AS subtotal,
        COALESCE(SUM(oi.quantity)::int, 0)            AS total_qty,
        COUNT(oi.id)::int                             AS line_count,
        STRING_AGG(oi.name || ' x' || oi.quantity, ', ') AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      -- Postgres, unlike SQLite, requires every selected column to be grouped
      -- or aggregated. Grouping by orders' primary key covers o.*, but br.name
      -- comes from a joined table and has to be named explicitly.
      GROUP BY o.id, br.name, br.code
      ORDER BY o.created_at ASC
    `, [from, to, ...scope.params]);

    // GROUP_CONCAT returns NULL for an order with no line items.
    res.json(orders.map(o => ({ ...o, items: o.items || '' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Line-item report — one row per item sold, rather than per order.
 *
 * This is what makes an item-level CSV possible: which dish sold, when, at
 * what unit price, on whose till. Category is resolved through menu_items and
 * falls back to 'Deal / Removed Item' when the id does not resolve, which is
 * the case for deals (they record the deal's id, not a menu item's) and for
 * items deleted from the menu after the sale.
 */
router.get('/line-items', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = scopeOrders(req, 'o');

  try {
    const rows = await db.q(`
      SELECT
        -- CLOUD: the till's own order number — see /detailed above.
        o.local_id      AS order_id,
        o.created_at,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        br.name         AS branch_name,
        oi.name         AS item_name,
        -- CLOUD: resolved by the till at push time.
        COALESCE(oi.category, 'Removed Item') AS category,
        oi.quantity,
        oi.price        AS unit_price,
        (oi.price * oi.quantity) AS line_total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      ORDER BY o.created_at ASC, oi.id ASC
    `, [from, to, ...scope.params]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily summary
router.get('/daily', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req);
  const expScope = scopeExpenses(req);
  try {
    /*
     * The day-by-day summary, with what was spent set against what was taken.
     *
     * The list of days is a UNION of both tables rather than just the sales
     * table. A day the shop was shut but still paid a supplier has expenses
     * and no orders; driving the report off orders alone would drop that day
     * entirely and quietly overstate the period's net.
     */
    const data = await db.q(`
      WITH days AS (
        SELECT DISTINCT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date FROM orders
         WHERE created_at::date BETWEEN ?::date AND ?::date
           AND status != 'voided'${scope.sql}
        UNION
        SELECT DISTINCT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date FROM expenses
         WHERE created_at::date BETWEEN ?::date AND ?::date${expScope.sql}
      )
      SELECT
        d.date,
        COALESCE(o.total_orders, 0)     AS total_orders,
        COALESCE(o.total_revenue, 0)    AS total_revenue,
        COALESCE(o.total_discounts, 0)  AS total_discounts,
        COALESCE(o.avg_order_value, 0)  AS avg_order_value,
        COALESCE(x.total_expenses, 0)   AS total_expenses,
        COALESCE(x.drawer_expenses, 0)  AS drawer_expenses,
        COALESCE(o.total_revenue, 0) - COALESCE(x.total_expenses, 0) AS net_revenue
      FROM days d
      LEFT JOIN (
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS total_orders,
               SUM(total)::float8 AS total_revenue,
               SUM(discount)::float8 AS total_discounts,
               AVG(total)::float8 AS avg_order_value
          FROM orders
         WHERE status != 'voided'${scope.sql}
         GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      ) o ON o.date = d.date
      LEFT JOIN (
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date,
               SUM(amount)::float8 AS total_expenses,
               SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8 AS drawer_expenses
          FROM expenses
         WHERE 1 = 1${expScope.sql}
         GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      ) x ON x.date = d.date
      ORDER BY d.date DESC
    `, [from, to, ...scope.params,
      from, to, ...expScope.params,
      ...scope.params,
      ...expScope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Expenses grouped by what the money went on.
 *
 * The mirror image of Sales by Category: that answers where the money came
 * from, this answers where it went. Together they are the whole day.
 */
router.get('/expenses-by-category', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeExpenses(req);
  try {
    res.json(await db.q(`
      SELECT
        category,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount)::float8, 0) AS total,
        COALESCE(SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8, 0) AS from_drawer_total
      FROM expenses
      WHERE created_at::date BETWEEN ?::date AND ?::date${scope.sql}
      GROUP BY category
      ORDER BY total DESC
    `, [from, to, ...scope.params]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Every expense in the period, line by line.
 *
 * Feeds both the on-screen table and the CSV/Excel export, so the owner can
 * account for each payout individually — who recorded it, what for, whether it
 * came out of the till, and which branch it belongs to.
 */
router.get('/expenses-detail', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeExpenses(req, 'e');
  try {
    res.json(await db.q(`
      SELECT
        -- CLOUD: the till's own number — see /detailed above.
        e.local_id AS id,
        e.created_at,
        e.category,
        e.description,
        e.amount,
        e.from_drawer,
        e.staff_name,
        -- CLOUD: the till's own shift number, which is only unique within its
        -- branch — hence the column name.
        e.local_shift_id AS shift_id,
        b.name AS branch_name
      FROM expenses e
      LEFT JOIN branches b ON b.id = e.branch_id
      WHERE e.created_at::date BETWEEN ?::date AND ?::date${scope.sql}
      ORDER BY e.created_at DESC, e.id DESC
    `, [from, to, ...scope.params]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
