/**
 * Payroll. The dashboard only, and deliberately nowhere else.
 *
 * There is no till-facing endpoint in this file and no downlink for any of it.
 * What a person earns is between them and the owner; a manager standing at a
 * drawer has no business seeing a colleague's salary, and the surest way to
 * guarantee that is for the figure never to reach the machine they are
 * standing at. That is a property of where the data lives, not a permission
 * somebody can misconfigure later.
 *
 * Two ideas hold the rest together.
 *
 * **The roster is not the staff list.** A rider, a cook and a cleaner draw a
 * wage and never touch the POS; a till account is a credential, not a person on
 * the payroll. So `employees` is its own roster, and the rows that are both
 * things are linked by `staff_local_id`. Anybody with a till account is added
 * to the roster automatically the first time payroll is opened, so the owner
 * never has to type in somebody the system already knows about.
 *
 * **A month's figures are copied, not referenced.** Each payslip carries its
 * own `base_salary` rather than reading through to the employee record, so
 * giving somebody a raise in March does not silently rewrite what they were
 * paid in January. This is the same instinct as stamping an order with its
 * branch at write time.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');

/** 'YYYY-MM'. A label for a pay cycle, not a point in time. */
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

const clean = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t.length ? t : null;
};

/** Money, floored at zero. A negative bonus is a deduction, and has its own box. */
const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function thisPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * What somebody is owed for the month.
 *
 * Additions first, then what has already been handed over or withheld. Floored
 * at zero: if the advances exceed the salary the shop is owed money, which is a
 * conversation, not a negative payslip.
 */
function netOf(p) {
  const gross = money(p.base_salary) + money(p.bonus) + money(p.overtime);
  const taken = money(p.advance) + money(p.deduction);
  return Math.max(0, gross - taken);
}

/** Only ever this branch, when one is asked for. */
function branchFilter(req, alias) {
  const id = Number(req.query.branch);
  return Number.isFinite(id) && id > 0
    ? { sql: ` AND ${alias}.branch_id = ?`, params: [id] }
    : { sql: '', params: [] };
}

/**
 * Put every till account on the roster.
 *
 * Run when payroll is opened rather than as a one-off migration, so a manager
 * created on the Staff tab this morning is on the payroll this afternoon
 * without anybody remembering to add them twice.
 *
 * DO NOTHING on conflict, so an employee the owner has since edited — renamed,
 * given a salary, marked as left — is never overwritten by the till's version
 * of their name.
 */
async function adoptTillStaff() {
  await db.run(`
    INSERT INTO employees (branch_id, staff_local_id, name, job_title, monthly_salary, active)
    SELECT st.branch_id, st.local_id, st.name, st.role, 0, st.active
      FROM staff st
     WHERE st.branch_id IS NOT NULL
    ON CONFLICT (branch_id, staff_local_id) WHERE staff_local_id IS NOT NULL
    DO NOTHING
  `);
}

/* ------------------------------------------------------------- the month -- */

/**
 * GET /api/payroll?period=YYYY-MM&branch=1
 *
 * The whole roster for one month, each person with their payslip if one has
 * been started. People with no payslip yet come back with a blank one carrying
 * their agreed salary, so the screen has something to show and the owner only
 * has to touch what differs from the norm.
 */
router.get('/', requireUser, async (req, res) => {
  const period = clean(req.query.period) || thisPeriod();
  if (!PERIOD.test(period)) {
    return res.status(400).json({ error: 'A pay period looks like 2026-09.' });
  }
  const f = branchFilter(req, 'e');

  try {
    await adoptTillStaff();

    const rows = await db.q(`
      SELECT
        e.id, e.branch_id, e.staff_local_id, e.name, e.job_title, e.phone,
        e.monthly_salary, e.joined_on, e.active, e.notes,
        b.name AS branch_name,
        p.id           AS payslip_id,
        p.base_salary, p.bonus, p.overtime, p.advance, p.deduction,
        p.notes        AS payslip_notes,
        p.paid_amount, p.paid_on, p.payment_method
      FROM employees e
      LEFT JOIN branches b ON b.id = e.branch_id
      LEFT JOIN payslips p ON p.employee_id = e.id AND p.period = ?
      WHERE 1 = 1${f.sql}
      ORDER BY e.active DESC, b.name NULLS LAST, e.name
    `, [period, ...f.params]);

    const employees = rows.map((r) => {
      const started = r.payslip_id != null;
      // An untouched month is shown at the agreed salary rather than at zero:
      // that is what the shop expects to pay, and starting from a blank sheet
      // every month is how somebody ends up paid nothing by accident.
      const slip = {
        base_salary: started ? Number(r.base_salary) : Number(r.monthly_salary) || 0,
        bonus: started ? Number(r.bonus) : 0,
        overtime: started ? Number(r.overtime) : 0,
        advance: started ? Number(r.advance) : 0,
        deduction: started ? Number(r.deduction) : 0,
        notes: started ? r.payslip_notes : null,
      };
      const net = netOf(slip);
      const paid = r.paid_amount == null ? null : Number(r.paid_amount);
      return {
        id: r.id,
        branch_id: r.branch_id,
        branch_name: r.branch_name,
        staff_local_id: r.staff_local_id,
        // Says plainly whether this person can also sign in to a till, which is
        // the difference between a manager and a rider on this screen.
        has_till_account: r.staff_local_id != null,
        name: r.name,
        job_title: r.job_title,
        phone: r.phone,
        monthly_salary: Number(r.monthly_salary) || 0,
        joined_on: r.joined_on,
        active: r.active,
        notes: r.notes,
        period,
        started,
        ...slip,
        net,
        paid_amount: paid,
        paid_on: r.paid_on,
        payment_method: r.payment_method,
        // Three states, not two. "Short" is the one worth seeing: it means
        // somebody was paid something and is still owed the rest, which a
        // plain paid/unpaid flag would hide entirely.
        status: paid == null ? 'unpaid' : (paid + 0.001 >= net ? 'paid' : 'short'),
        outstanding: paid == null ? net : Math.max(0, net - paid),
      };
    });

    const active = employees.filter(e => e.active);
    const totals = {
      people: active.length,
      on_payroll: employees.length,
      net: active.reduce((t, e) => t + e.net, 0),
      paid: active.reduce((t, e) => t + (e.paid_amount || 0), 0),
      outstanding: active.reduce((t, e) => t + e.outstanding, 0),
      bonus: active.reduce((t, e) => t + e.bonus, 0),
      deduction: active.reduce((t, e) => t + e.deduction, 0),
      advance: active.reduce((t, e) => t + e.advance, 0),
      unpaid_people: active.filter(e => e.status !== 'paid').length,
    };

    res.json({ period, employees, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payroll/summary?from=&to=&branch=
 *
 * Wages actually paid in a date range, for the Reports screen.
 *
 * Counted on `paid_on` — the day the money left — not on the month the payslip
 * is labelled with. A shop pays August's wages in early September, and what the
 * reports are asked is what September cost, so the cash date is the honest one.
 */
router.get('/summary', requireUser, async (req, res) => {
  const from = clean(req.query.from);
  const to = clean(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'A date range is required.' });
  const f = branchFilter(req, 'e');

  try {
    const total = await db.one(`
      SELECT COALESCE(SUM(p.paid_amount)::float8, 0) AS wages_paid,
             COUNT(*)::int                           AS payments
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
       WHERE p.paid_on BETWEEN ?::date AND ?::date${f.sql}
    `, [from, to, ...f.params]);

    const byBranch = await db.q(`
      SELECT b.name AS branch_name,
             COALESCE(SUM(p.paid_amount)::float8, 0) AS wages_paid,
             COUNT(*)::int                           AS payments
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
        LEFT JOIN branches b ON b.id = e.branch_id
       WHERE p.paid_on BETWEEN ?::date AND ?::date${f.sql}
       GROUP BY b.name
       ORDER BY wages_paid DESC
    `, [from, to, ...f.params]);

    const byPerson = await db.q(`
      SELECT e.name, e.job_title, b.name AS branch_name,
             COALESCE(SUM(p.paid_amount)::float8, 0) AS wages_paid,
             COUNT(*)::int                           AS payments
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
        LEFT JOIN branches b ON b.id = e.branch_id
       WHERE p.paid_on BETWEEN ?::date AND ?::date${f.sql}
       GROUP BY e.name, e.job_title, b.name
       ORDER BY wages_paid DESC
    `, [from, to, ...f.params]);

    res.json({
      wages_paid: Number(total.wages_paid) || 0,
      payments: total.payments,
      by_branch: byBranch,
      by_person: byPerson,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------- the people -- */

/**
 * Add somebody who does not use a till.
 *
 * The riders and kitchen staff. They get no credential, no till account and no
 * way to sign in anywhere — this is a name and a wage, nothing more.
 */
router.post('/employees', requireUser, async (req, res) => {
  const body = req.body || {};
  const name = clean(body.name);
  const branchId = Number(body.branch_id) || null;

  if (!name) return res.status(400).json({ error: 'A name is required.' });
  if (!branchId) return res.status(400).json({ error: 'Choose which branch they work at.' });

  try {
    const branch = await db.one('SELECT id FROM branches WHERE id = ? AND active = 1', [branchId]);
    if (!branch) return res.status(400).json({ error: 'Unknown branch.' });

    const row = await db.one(`
      INSERT INTO employees (branch_id, name, job_title, phone, monthly_salary,
                             joined_on, notes, active, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      RETURNING id
    `, [branchId, name, clean(body.job_title), clean(body.phone),
        money(body.monthly_salary), clean(body.joined_on), clean(body.notes), Date.now()]);

    res.status(201).json({ id: row.id, name, branch_id: branchId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Edit one. A till-linked employee keeps their name in step with the Staff tab. */
router.put('/employees/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad employee.' });

  const sets = [];
  const params = [];
  const set = (col, val) => { sets.push(`${col} = ?`); params.push(val); };

  if (body.name !== undefined) {
    const n = clean(body.name);
    if (!n) return res.status(400).json({ error: 'A name is required.' });
    set('name', n);
  }
  if (body.job_title !== undefined) set('job_title', clean(body.job_title));
  if (body.phone !== undefined) set('phone', clean(body.phone));
  if (body.monthly_salary !== undefined) set('monthly_salary', money(body.monthly_salary));
  if (body.joined_on !== undefined) set('joined_on', clean(body.joined_on));
  if (body.notes !== undefined) set('notes', clean(body.notes));
  if (body.active !== undefined) set('active', body.active ? 1 : 0);

  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  set('updated_ms', Date.now());

  try {
    const existing = await db.one('SELECT id FROM employees WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'No such employee.' });
    await db.run(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Somebody who has left is marked inactive, never deleted.
 *
 * Their payslips are the record of what the shop paid out, and deleting the
 * person would take those months with them — the row cascades. An inactive
 * employee drops off the current month and keeps every month they were there
 * for.
 */
router.delete('/employees/:id', requireUser, (req, res) => {
  res.status(400).json({
    error: 'Somebody who has left is marked inactive, so the months you already paid them stay on the books.',
    code: 'DEACTIVATE_INSTEAD',
  });
});

/* ----------------------------------------------------------- the payslip -- */

/** A paid month is closed. Reopen it to change the figures. */
async function refuseIfPaid(employeeId, period, res) {
  const slip = await db.one(
    'SELECT paid_amount FROM payslips WHERE employee_id = ? AND period = ?', [employeeId, period]);
  if (slip && slip.paid_amount != null) {
    res.status(409).json({
      error: 'This month is marked paid. Undo the payment first if the figures need changing.',
      code: 'PAYSLIP_PAID',
    });
    return true;
  }
  return false;
}

/**
 * PUT /api/payroll/:employeeId/:period — set the month's figures.
 *
 * Creates the payslip on first touch, at the employee's agreed salary unless
 * told otherwise, so the ordinary month is one save with nothing typed.
 */
router.put('/:employeeId/:period', requireUser, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const period = req.params.period;
  const body = req.body || {};

  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Bad employee.' });
  if (!PERIOD.test(period)) return res.status(400).json({ error: 'A pay period looks like 2026-09.' });

  try {
    const employee = await db.one(
      'SELECT id, monthly_salary FROM employees WHERE id = ?', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'No such employee.' });
    if (await refuseIfPaid(employeeId, period, res)) return;

    const slip = {
      base_salary: body.base_salary !== undefined
        ? money(body.base_salary)
        : Number(employee.monthly_salary) || 0,
      bonus: money(body.bonus),
      overtime: money(body.overtime),
      advance: money(body.advance),
      deduction: money(body.deduction),
    };

    await db.run(`
      INSERT INTO payslips (employee_id, period, base_salary, bonus, overtime,
                            advance, deduction, notes, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (employee_id, period) DO UPDATE SET
        base_salary = EXCLUDED.base_salary, bonus = EXCLUDED.bonus,
        overtime = EXCLUDED.overtime, advance = EXCLUDED.advance,
        deduction = EXCLUDED.deduction, notes = EXCLUDED.notes,
        updated_ms = EXCLUDED.updated_ms
    `, [employeeId, period, slip.base_salary, slip.bonus, slip.overtime,
        slip.advance, slip.deduction, clean(body.notes), Date.now()]);

    res.json({ success: true, period, ...slip, net: netOf(slip) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/payroll/:employeeId/:period/pay — mark it paid.
 *
 * The amount defaults to what is owed, so the ordinary case is one press. Pay
 * less and the difference is carried as outstanding rather than written off:
 * paying somebody 20,000 of a 25,000 salary should not quietly redefine their
 * salary as 20,000.
 */
router.post('/:employeeId/:period/pay', requireUser, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const period = req.params.period;
  const body = req.body || {};

  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Bad employee.' });
  if (!PERIOD.test(period)) return res.status(400).json({ error: 'A pay period looks like 2026-09.' });

  try {
    const employee = await db.one(
      'SELECT id, monthly_salary FROM employees WHERE id = ?', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'No such employee.' });

    // A month nobody opened is still payable: it means the agreed salary, with
    // nothing added and nothing taken off, which is what most months are.
    let slip = await db.one(
      'SELECT * FROM payslips WHERE employee_id = ? AND period = ?', [employeeId, period]);
    if (!slip) {
      await db.run(`
        INSERT INTO payslips (employee_id, period, base_salary, updated_ms)
        VALUES (?, ?, ?, ?)
      `, [employeeId, period, Number(employee.monthly_salary) || 0, Date.now()]);
      slip = await db.one(
        'SELECT * FROM payslips WHERE employee_id = ? AND period = ?', [employeeId, period]);
    }

    const net = netOf(slip);
    const amount = body.amount === undefined || body.amount === null || body.amount === ''
      ? net
      : money(body.amount);
    if (amount <= 0) return res.status(400).json({ error: 'A payment has to be more than nothing.' });

    const paidOn = clean(body.paid_on) || new Date().toLocaleDateString('en-CA');

    await db.run(`
      UPDATE payslips
         SET paid_amount = ?, paid_on = ?::date, paid_at = NOW(),
             payment_method = ?, updated_ms = ?
       WHERE employee_id = ? AND period = ?
    `, [amount, paidOn, clean(body.payment_method) || 'Cash', Date.now(), employeeId, period]);

    res.json({
      success: true, period, net, paid_amount: amount, paid_on: paidOn,
      outstanding: Math.max(0, net - amount),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Undo a payment — recorded against the wrong person, or the wrong month. */
router.delete('/:employeeId/:period/pay', requireUser, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const period = req.params.period;
  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Bad employee.' });
  if (!PERIOD.test(period)) return res.status(400).json({ error: 'A pay period looks like 2026-09.' });

  try {
    const n = await db.run(`
      UPDATE payslips
         SET paid_amount = NULL, paid_on = NULL, paid_at = NULL,
             payment_method = NULL, updated_ms = ?
       WHERE employee_id = ? AND period = ?
    `, [Date.now(), employeeId, period]);
    if (!n) return res.status(404).json({ error: 'Nothing was recorded for that month.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/payroll/history/:employeeId — every month on file for one person.
 *
 * What the owner reaches for when somebody asks what they were paid in June,
 * or when a raise needs to be explained.
 */
router.get('/history/:employeeId', requireUser, async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isFinite(employeeId)) return res.status(400).json({ error: 'Bad employee.' });
  try {
    const rows = await db.q(`
      SELECT period, base_salary, bonus, overtime, advance, deduction,
             notes, paid_amount, paid_on, payment_method
        FROM payslips WHERE employee_id = ?
       ORDER BY period DESC
    `, [employeeId]);
    res.json(rows.map(r => ({ ...r, net: netOf(r) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
