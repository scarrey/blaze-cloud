/**
 * The cloud schema, in Postgres.
 *
 * Applied on boot and idempotent, so a deploy is just a restart. Supabase also
 * offers migration files; this stays in code because the till's own schema
 * (`backend/db/database.js`) works the same way, and one convention across both
 * halves is worth more than following each platform's house style.
 *
 * Deliberate shape decisions, all inherited from the sync design:
 *
 * **Every synced row is keyed on `(branch_id, local_id)`.** Each till assigns
 * its own ids, so E-18's order #12 and CBR Town's order #12 are different sales
 * wearing the same number. The cloud keeps a `id` of its own for joins,
 * and the unique constraint on the pair is what makes a re-sent batch harmless
 * — which matters because on a flaky link a till often cannot tell whether a
 * batch landed and must be free to send it again.
 *
 * **Integer flags stay integers.** Postgres has a real boolean, but the tills
 * send 0 and 1 and the reporting SQL compares against them. Converting here
 * would mean translating in both directions forever, for nothing.
 *
 * **Timestamps are text, not `timestamptz`.** The tills record local wall-clock
 * time as `'2026-09-07 14:32:11'`, with no zone. Storing that as `timestamptz`
 * would make Postgres attach the *server's* zone to it, so the same sale would
 * read differently depending on where the server happened to be. Keeping the
 * till's own string and comparing with `::date` preserves exactly what the shop
 * recorded. The `_ms` columns, which are epoch integers, carry anything that
 * genuinely needs to be compared across machines.
 */

const DDL = `
-- ---------------------------------------------------------------- branches --
CREATE TABLE IF NOT EXISTS branches (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------- dashboard accounts --
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  branch_id     INTEGER REFERENCES branches(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ------------------------------------------------------------ live status --
-- One row per branch, overwritten on every heartbeat. No history: the live
-- view is deliberately not reconstructable, and historical questions belong to
-- the synced tables below, which arrive with completely different guarantees.
CREATE TABLE IF NOT EXISTS live_status (
  branch_id            INTEGER PRIMARY KEY REFERENCES branches(id),
  state                TEXT NOT NULL,
  shift_local_id       INTEGER,
  staff_name           TEXT,
  opened_at            TEXT,
  opening_cash         DOUBLE PRECISION,
  total_orders         INTEGER,
  total_revenue        DOUBLE PRECISION,
  cash_revenue         DOUBLE PRECISION,
  non_cash_revenue     DOUBLE PRECISION,
  drawer_expenses      DOUBLE PRECISION,
  expense_count        INTEGER,
  expected_cash        DOUBLE PRECISION,
  expenses_today_total DOUBLE PRECISION,
  expenses_today_count INTEGER,
  menu_version         INTEGER,
  payload              JSONB,
  till_sent_ms         BIGINT,
  server_received_ms   BIGINT NOT NULL,
  clock_skew_ms        BIGINT,
  agent_started_ms     BIGINT
);

-- ---------------------------------------------------------------- orders --
CREATE TABLE IF NOT EXISTS orders (
  id                     SERIAL PRIMARY KEY,
  branch_id              INTEGER NOT NULL,
  local_id               INTEGER NOT NULL,
  total                  DOUBLE PRECISION,
  discount               DOUBLE PRECISION,
  payment_method         TEXT,
  status                 TEXT,
  cashier_name           TEXT,
  cashier_id             INTEGER,
  created_at             TEXT,
  order_type             TEXT,
  delivery_charge        DOUBLE PRECISION,
  local_shift_id         INTEGER,
  table_number           TEXT,
  voided_at              TEXT,
  tax_rate               DOUBLE PRECISION,
  tax_amount             DOUBLE PRECISION,
  is_employee            INTEGER,
  employee_discount      DOUBLE PRECISION,
  employee_discount_rate DOUBLE PRECISION,
  voided_by              TEXT,
  voided_by_id           INTEGER,
  customer_name          TEXT,
  customer_phone         TEXT,
  customer_address       TEXT,
  received_at            BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_branch     ON orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER NOT NULL,
  local_id     INTEGER NOT NULL,
  -- The CLOUD's orders.id, remapped at ingest. The till's own order id is only
  -- unique within its branch, so storing it here would join one shop's food
  -- onto the other shop's sale of the same number.
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name         TEXT,
  price        DOUBLE PRECISION,
  quantity     INTEGER,
  is_deal      INTEGER,
  variant_id   INTEGER,
  -- Resolved by the till at push time: menu item ids are per-machine, so the
  -- join to menu_items cannot be done here.
  category     TEXT,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS shifts (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER NOT NULL,
  local_id      INTEGER NOT NULL,
  staff_id      INTEGER,
  staff_name    TEXT,
  opening_cash  DOUBLE PRECISION,
  closing_cash  DOUBLE PRECISION,
  expected_cash DOUBLE PRECISION,
  variance      DOUBLE PRECISION,
  opened_at     TEXT,
  closed_at     TEXT,
  status        TEXT,
  received_at   BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id);

CREATE TABLE IF NOT EXISTS expenses (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  local_id       INTEGER NOT NULL,
  local_shift_id INTEGER,
  staff_id       INTEGER,
  staff_name     TEXT,
  category       TEXT,
  description    TEXT,
  amount         DOUBLE PRECISION,
  from_drawer    INTEGER,
  created_at     TEXT,
  received_at    BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_expenses_branch     ON expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at);

-- ------------------------------------------------------- staff & inventory --
-- Both are read-only on the dashboard: the branch owns them, and a stock count
-- or a PIN edited in two places at once has no safe resolution.
CREATE TABLE IF NOT EXISTS staff (
  id         SERIAL PRIMARY KEY,
  branch_id  INTEGER NOT NULL,
  local_id   INTEGER NOT NULL,
  name       TEXT,
  role       TEXT,
  color      TEXT,
  active     INTEGER,
  -- No PIN, hashed or otherwise. It is of no use to the dashboard and every
  -- copy of a credential is another place it can leak from.
  received_at BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);

/*
 * Delivery customers, for demographics.
 *
 * Keyed per branch like everything else that syncs, because each till maintains
 * its own book. The same household ordering from both shops therefore arrives
 * as two rows; the read route sums them by phone number, so "how many times has
 * this customer ordered" answers across the whole business rather than one
 * branch's view of them.
 */
CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  local_id       INTEGER NOT NULL,
  name           TEXT,
  phone          TEXT,
  address        TEXT,
  order_count    INTEGER DEFAULT 0,
  total_spent    DOUBLE PRECISION DEFAULT 0,
  first_order_at TEXT,
  last_order_at  TEXT,
  received_at    BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS ingredients (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER NOT NULL,
  local_id    INTEGER NOT NULL,
  name        TEXT,
  unit        TEXT,
  stock       DOUBLE PRECISION,
  low_stock_threshold DOUBLE PRECISION,
  cost_per_unit DOUBLE PRECISION,
  received_at BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_ingredients_branch ON ingredients(branch_id);

-- ------------------------------------------------------------ sync cursor --
-- Read by the dashboard, not by the sync. A report that silently omits the
-- last three hours of a disconnected branch is worse than no report, so the
-- reports screen shows how complete its data actually is.
CREATE TABLE IF NOT EXISTS sync_cursor (
  branch_id      INTEGER NOT NULL,
  table_name     TEXT NOT NULL,
  rows_received  INTEGER NOT NULL DEFAULT 0,
  last_synced_ms BIGINT,
  PRIMARY KEY (branch_id, table_name)
);

-- ------------------------------------------------------------------- menu --
-- The cloud is the single writer for the menu (see routes/menu.js). Tills pull
-- a whole snapshot and never push one back, which removes conflict resolution
-- by design rather than solving it.
CREATE TABLE IF NOT EXISTS menu_items (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT,
  price        DOUBLE PRECISION DEFAULT 0,
  image_url    TEXT,
  has_variants INTEGER DEFAULT 0,
  active       INTEGER DEFAULT 1,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_variants (
  id           SERIAL PRIMARY KEY,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  label        TEXT,
  price        DOUBLE PRECISION DEFAULT 0,
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deals (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  price       DOUBLE PRECISION DEFAULT 0,
  image_url   TEXT,
  active      INTEGER DEFAULT 1,
  deal_group  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deal_items (
  id           SERIAL PRIMARY KEY,
  deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  quantity     INTEGER DEFAULT 1,
  variant_id   INTEGER REFERENCES item_variants(id) ON DELETE SET NULL,
  description  TEXT
);

/*
 * One integer the tills can check cheaply.
 *
 * A till asks "what version is the menu?" on every heartbeat -- a few bytes,
 * which succeeds on a link far too weak to download a menu. Only when the
 * number differs does it fetch the whole snapshot. That is what makes the
 * downlink survivable on a bad connection: the common case costs nothing.
 */
/*
 * Shop-wide settings, and their own version counter.
 *
 * Separate from menu_version on purpose: changing the tax rate should not make
 * every till re-download and re-apply the whole menu, which retires and
 * reinserts every item.
 */
CREATE TABLE IF NOT EXISTS cloud_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settings_version_single_row CHECK (id = 1)
);
INSERT INTO settings_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS menu_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT menu_version_single_row CHECK (id = 1)
);
INSERT INTO menu_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------ migrations --
--
-- Added after the tables above were already live, so they are ALTERs rather
-- than edits to the CREATE statements: a running database has to arrive at the
-- same shape a fresh one does. All idempotent, so this file stays safe to
-- re-run on every boot.

-- A branch's short code, printed in front of the order number: E-18-041.
-- Display only; the key is still (branch_id, local_id). See
-- backend/db/order-no.js for the reasoning and the format.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS code TEXT;

-- Staff, once the dashboard became the place they are created.
--
-- The PIN hash now lives here, which the first version of this file
-- deliberately refused. The reason it refused still stands: every copy of a
-- credential is another place it can leak from, and a four-digit PIN behind
-- bcrypt is brute-forceable by anyone who takes the database.
--
-- It is stored anyway because the alternative is worse. The owner asked to
-- create staff from the dashboard, and a till authenticates PINs offline
-- against its own SQLite — so a PIN set here that never reaches the till is a
-- staff account that cannot sign in at the only place it is used. There is no
-- version of "create staff from the dashboard" that does not move the
-- credential down the wire.
--
-- What limits the damage: the hash is never returned by any read route (see
-- routes/staff.js), a PIN is useful only to somebody standing at a physical
-- till in one of the two shops, and it grants no access to this database or
-- the dashboard, which authenticate entirely separately.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;
-- 'cloud' rows were created here and own their fields; 'branch' rows came up
-- from a till and are only mirrored. The distinction decides who wins when
-- both have a row for the same person.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_ms BIGINT;

-- Bumped on any staff change, so a till can ask for one integer and download a
-- roster only when it has actually moved — exactly as the menu works.
CREATE TABLE IF NOT EXISTS staff_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_version_single_row CHECK (id = 1)
);
INSERT INTO staff_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------- payroll --
--
-- Wages live only here. Nothing in this section is ever sent to a till, and no
-- till route can read it: what a person is paid is between them and the owner,
-- and a manager standing at a drawer has no business seeing a colleague's
-- salary. Keeping it cloud-only makes that a property of where the data sits
-- rather than a permission somebody could get wrong later.

/*
 * Everyone who draws a wage — which is not the same set as everyone who can
 * sign in to a till.
 *
 * A rider, a cook or a cleaner is paid every month and never touches the POS;
 * a till account is a credential, not a person on the payroll. So this is its
 * own roster, and staff_local_id links the rows that are both. It is NULL for
 * everybody else, which is why the uniqueness below is a partial index: two
 * riders at the same branch must both be allowed to have no till account.
 */
CREATE TABLE IF NOT EXISTS employees (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  staff_local_id INTEGER,
  name           TEXT NOT NULL,
  job_title      TEXT,
  phone          TEXT,
  -- The agreed monthly figure. Copied onto each month's payslip rather than
  -- read through it, so raising somebody's salary in March does not silently
  -- rewrite what they were paid in January.
  monthly_salary DOUBLE PRECISION NOT NULL DEFAULT 0,
  joined_on      DATE,
  active         INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_ms     BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_one_per_till_account
  ON employees (branch_id, staff_local_id) WHERE staff_local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_branch ON employees (branch_id);

/*
 * One row per person per month.
 *
 * The month is text, 'YYYY-MM', because that is exactly what it is — a label
 * for a pay cycle, not a point in time. A date would invite arithmetic that
 * makes no sense here.
 *
 * Two different dates matter and are kept apart: paid_on is the day the
 * money actually changed hands, which is what the reports count, and paid_at
 * is when it was recorded on the dashboard. They differ whenever somebody
 * writes up Friday's payments on Monday.
 */
CREATE TABLE IF NOT EXISTS payslips (
  id             SERIAL PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period         TEXT NOT NULL,
  base_salary    DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus          DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime       DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Money already handed over during the month, subtracted at the end of it.
  -- Extremely common here, and the single easiest thing to forget and pay twice.
  advance        DOUBLE PRECISION NOT NULL DEFAULT 0,
  deduction      DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes          TEXT,
  -- What was actually handed over. Recorded separately from the net figure so
  -- a short payment shows an outstanding balance instead of quietly redefining
  -- what was owed.
  paid_amount    DOUBLE PRECISION,
  paid_on        DATE,
  paid_at        TIMESTAMPTZ,
  payment_method TEXT,
  updated_ms     BIGINT,
  UNIQUE (employee_id, period)
);
CREATE INDEX IF NOT EXISTS payslips_period ON payslips (period);
CREATE INDEX IF NOT EXISTS payslips_paid_on ON payslips (paid_on);

-- ------------------------------------------------------------- backups --
--
-- A compressed copy of each till's whole SQLite database, so a branch can be
-- rebuilt on a different machine. This is the only copy of a till's own
-- history that is not on that till: the local backups sit on the same disk as
-- the database, which protects against a deleted record and against nothing
-- that happens to the machine.
--
-- One row per branch per day, replaced in place. That bounds the storage to a
-- fortnight of compressed copies per branch regardless of how often a till
-- uploads, while still letting it upload every half hour so the newest is
-- never far behind. Going back past a problem needs distinct days, not
-- distinct half-hours.
--
-- The blob is gzipped on the till and stored exactly as received; this server
-- never opens it. The counts beside it are what the till reported at the time,
-- which is what makes a stale or empty backup visible on the dashboard without
-- anything having to decompress 40 MB to find out.
CREATE TABLE IF NOT EXISTS branch_backups (
  id              SERIAL PRIMARY KEY,
  branch_id       INTEGER NOT NULL,
  backup_day      DATE NOT NULL,
  taken_at        TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gz_bytes        BIGINT NOT NULL,
  raw_bytes       BIGINT,
  sha256          TEXT,
  orders_count    INTEGER,
  last_order_at   TEXT,
  reason          TEXT,
  blob            BYTEA NOT NULL,
  UNIQUE (branch_id, backup_day)
);
CREATE INDEX IF NOT EXISTS branch_backups_recent ON branch_backups (branch_id, backup_day DESC);

-- ---------------------------------------------------- staff deletions --
--
-- A tombstone per removed staff member, and it is load-bearing in two places.
--
-- The till's roster downlink upserts and never deletes, because a row missing
-- from a snapshot usually means the cloud has not heard about that person yet
-- rather than that they are gone. So a deletion has to be stated rather than
-- inferred from an absence — otherwise somebody removed here would keep their
-- PIN working at the till forever.
--
-- And the till pushes its staff up every five minutes. Without a record that
-- the row was deleted on purpose, that push would simply put it back, and the
-- delete would appear to work and then quietly undo itself.
--
-- Past orders, shifts and expenses are unaffected: each stores the person's
-- name inline at the time it was recorded, so history keeps reading correctly
-- with nobody to point at.
CREATE TABLE IF NOT EXISTS staff_deletions (
  branch_id  INTEGER NOT NULL,
  local_id   INTEGER NOT NULL,
  name       TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  PRIMARY KEY (branch_id, local_id)
);

-- ------------------------------------------------------------- pairing --
--
-- Short codes that turn a freshly installed till into a particular branch.
--
-- The branch API key is 64 hex characters. Nobody is reading that down a phone
-- line to a manager in a shop, and asking them to create a JSON file in
-- AppData is worse. So the owner generates a code here, reads it out, and the
-- till exchanges it for the real key over HTTPS.
--
-- A code is a credential, and a weak one by design: eight characters, typed by
-- a person. Three things keep that safe, and all three are load-bearing:
--
--   * Single use. Claimed once and it is spent, so a code left on a WhatsApp
--     message cannot pair a second machine.
--   * Short lived. Hours, not forever, so a forgotten code stops mattering.
--   * Rate limited on the claim endpoint, because eight characters from a
--     32-letter alphabet is only strong while guessing is slow.
--
-- Stored as a SHA-256 hash for the same reason the branch keys are: whoever
-- reads this table should not come away with anything they can use. The lookup
-- is by hash, so it stays a single indexed read.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  -- The last four characters, in clear, so the owner can tell which code a
  -- listing row refers to without it being enough to pair with.
  hint        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  claimed_at  TIMESTAMPTZ,
  claimed_ip  TEXT,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS pairing_codes_live ON pairing_codes (branch_id, claimed_at, expires_at);

-- Same derivation the till uses, for branches that predate the column.
UPDATE branches
   SET code = NULLIF(regexp_replace(
                       regexp_replace(regexp_replace(name, '\\mbranch\\M', ' ', 'gi'),
                                      '[^A-Za-z0-9]+', '-', 'g'),
                       '^-+|-+$', '', 'g'), '')
 WHERE code IS NULL OR code = '';
`;

/**
 * Settings every connection needs, applied to the role rather than per session.
 *
 * See db/pg.js for why each matters. Doing it here means one statement at boot
 * instead of a query on every connection that races the pool.
 *
 * Non-fatal: a role without ALTER privileges still gets a working server, just
 * one whose floats are truncated on the wire — worth a loud warning, not a
 * refusal to start.
 */
async function applyRoleSettings(db) {
  try {
    const { rows } = await db.pool.query('SELECT current_user AS role');
    const role = rows[0].role;
    // The role name comes from the server, not from input, but quote it anyway
    // — ALTER ROLE takes an identifier, which cannot be parameterised.
    const quoted = '"' + String(role).replace(/"/g, '""') + '"';
    await db.pool.query(`ALTER ROLE ${quoted} SET extra_float_digits = 3`);
    await db.pool.query(`ALTER ROLE ${quoted} SET idle_in_transaction_session_timeout = '30s'`);
  } catch (err) {
    console.warn('Could not set role defaults (floats may lose precision):', err.message);
  }
}

async function createSchema(db) {
  await db.pool.query(DDL);
  await applyRoleSettings(db);
}

module.exports = { createSchema, applyRoleSettings, DDL };
