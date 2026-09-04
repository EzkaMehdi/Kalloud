/**
 * OPS-04: retention, export, anonymisation and purge — DEC-10 turned into
 * code.
 *
 * The whole ticket turns on one fact about this schema: a `users` row cannot
 * be deleted once the person has done anything. Seven tables point at it
 * with `NO ACTION` — orders, payments, cash movements, stock movements,
 * stock counts, business days and the audit log — because DEC-10 keeps
 * transactional records for six years, and none of them means anything
 * without the identity of who recorded them.
 *
 * So a deletion request is honoured by **anonymising in place**, not by
 * deleting: the row and its id survive so every ledger entry still joins to
 * a stable actor, while the person behind it stops being identifiable. That
 * is what lets "les données personnelles sont anonymisées" and "les données
 * agrégées nécessaires à une obligation légale sont conservées" both hold —
 * which is exactly this ticket's acceptance criterion, "sans casser les
 * obligations comptables retenues".
 *
 * Lives in `scripts/lib/` and speaks SQL directly, like `seed.mjs` and
 * `migrate.mjs`: these are rare operator acts run from a terminal, never
 * from a route, and SEC-06's "no direct queries" guard is about route
 * handlers. Putting them behind an HTTP endpoint would mean a token that
 * can erase an establishment, which is a worse thing to have than a script
 * someone must deliberately run.
 */

/** DEC-10: "au minimum 6 ans", aligned with French accounting obligations. */
export const RETENTION_YEARS = 6;

/** The tables DEC-10 names as transactional, and the column that dates each. */
const ACCOUNTING_TABLES = [
  { table: "orders", dateColumn: "created_at" },
  { table: "payments", dateColumn: "created_at" },
  { table: "cash_movements", dateColumn: "created_at" },
  { table: "stock_movements", dateColumn: "created_at" },
  { table: "business_days", dateColumn: "opened_at" },
  { table: "audit_events", dateColumn: "created_at" },
];

function addYears(date, years) {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

/** What the retention policy still protects for one establishment. */
export async function getRetentionStatus(db, locationId, now = new Date()) {
  const boundary = addYears(now, -RETENTION_YEARS);

  const protectedRows = [];
  let newestOverall = null;

  for (const { table, dateColumn } of ACCOUNTING_TABLES) {
    // Identifiers cannot be parameterised; both come from the constant
    // above and never from a caller.
    const { rows } = await db.query(
      `SELECT COUNT(*)::TEXT AS rows, MAX(${dateColumn}) AS newest
         FROM ${table} WHERE location_id = $1 AND ${dateColumn} >= $2`,
      [locationId, boundary],
    );
    const count = Number(rows[0].rows);
    const newest = rows[0].newest;
    if (newest && (!newestOverall || newest > newestOverall)) newestOverall = newest;
    protectedRows.push({ table, rows: count, newest: newest ? newest.toISOString() : null });
  }

  const totalProtectedRows = protectedRows.reduce((sum, entry) => sum + entry.rows, 0);
  const purgeAllowedFrom = newestOverall ? addYears(newestOverall, RETENTION_YEARS) : null;

  return {
    locationId,
    retentionYears: RETENTION_YEARS,
    boundary: boundary.toISOString(),
    protectedRows,
    totalProtectedRows,
    purgeAllowed: totalProtectedRows === 0,
    purgeAllowedFrom: purgeAllowedFrom ? purgeAllowedFrom.toISOString() : null,
  };
}

/**
 * DEC-10's "export préalable": everything the establishment owns, in one
 * archive, before anything is anonymised or purged.
 *
 * Raw rows rather than the cockpit's CSV exports (BI-12). Those answer
 * business questions and omit what they do not need; this one exists so a
 * customer keeps what the deletion is about to remove, and an omission here
 * is unrecoverable.
 */
export async function exportEstablishmentArchive(db, locationId) {
  const location = await one(
    db,
    "SELECT * FROM locations WHERE id = $1",
    [locationId],
    "Établissement introuvable.",
  );
  const all = async (sql, params = [locationId]) => (await db.query(sql, params)).rows;

  return {
    exportedAt: new Date().toISOString(),
    retention: await getRetentionStatus(db, locationId),
    organization: await one(
      db,
      "SELECT * FROM organizations WHERE id = $1",
      [location.organization_id],
      "Organisation introuvable.",
    ),
    location,
    settings: (await all("SELECT * FROM location_settings WHERE location_id = $1"))[0] ?? null,
    // The member list is the one place personal data is exported on
    // purpose: it is the customer's own record of who had access, and it is
    // what the anonymisation is about to make unreadable.
    members: await all(
      `SELECT m.id, m.role, m.status, m.created_at,
              u.id AS user_id, u.name, u.email, u.status AS user_status
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.location_id = $1 ORDER BY m.id`,
    ),
    tables: await all("SELECT * FROM dining_tables WHERE location_id = $1 ORDER BY id"),
    categories: await all("SELECT * FROM categories WHERE location_id = $1 ORDER BY id"),
    taxClasses: await all("SELECT * FROM tax_classes WHERE location_id = $1 ORDER BY id"),
    products: await all("SELECT * FROM products WHERE location_id = $1 ORDER BY id"),
    businessDays: await all("SELECT * FROM business_days WHERE location_id = $1 ORDER BY id"),
    orders: await all("SELECT * FROM orders WHERE location_id = $1 ORDER BY id"),
    orderItems: await all(
      `SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.location_id = $1 ORDER BY i.id`,
    ),
    payments: await all("SELECT * FROM payments WHERE location_id = $1 ORDER BY id"),
    cashMovements: await all("SELECT * FROM cash_movements WHERE location_id = $1 ORDER BY id"),
    stockMovements: await all("SELECT * FROM stock_movements WHERE location_id = $1 ORDER BY id"),
    stockCounts: await all("SELECT * FROM stock_counts WHERE location_id = $1 ORDER BY id"),
    auditEvents: await all("SELECT * FROM audit_events WHERE location_id = $1 ORDER BY id"),
  };
}

export const ANONYMIZED_NAME = "Compte anonymisé";
export const anonymizedEmailFor = (userId) => `anonymise-${userId}@supprime.invalid`;

/**
 * Honours a deletion request for one person: name, e-mail and credentials
 * are replaced, the account is disabled, and every session and reset token
 * is revoked.
 *
 * Irreversible by design — nothing is kept to restore the original from,
 * which is the difference between anonymising and hiding.
 *
 * The row itself stays, because seven tables DEC-10 requires keeping for
 * six years point at it: a ledger that cannot say *which* actor recorded an
 * entry is not an anonymised ledger, it is a broken one. The placeholder
 * address satisfies the unique index and can never receive mail —
 * `.invalid` is reserved by RFC 2606 for exactly this.
 *
 * Runs inside the caller's transaction so a failure leaves the account
 * untouched rather than half-erased.
 */
export async function anonymizeUser(client, userId, { actorUserId = null } = {}) {
  const user = await one(
    client,
    "SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE",
    [userId],
    "Utilisateur introuvable.",
  );

  const placeholderEmail = anonymizedEmailFor(user.id);
  if (user.email === placeholderEmail) {
    throw new Error("Ce compte est déjà anonymisé.");
  }

  await client.query(
    `UPDATE users
        SET name = $3,
            email = $2,
            -- Not a hash of anything: no password can ever match it, so the
            -- account cannot be signed into even by accident.
            password_hash = 'anonymized',
            status = 'DISABLED'
      WHERE id = $1`,
    [user.id, placeholderEmail, ANONYMIZED_NAME],
  );

  // Personal traces with no accounting value at all.
  await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);
  await client.query("DELETE FROM login_attempts WHERE email = $1", [user.email]);
  await client.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);

  // Audited on every establishment the person belonged to (SEC-09): each one
  // keeps ledger entries attributed to this id, and its operator has to be
  // able to explain why that name changed.
  const { rows: memberships } = await client.query(
    "SELECT location_id FROM memberships WHERE user_id = $1",
    [user.id],
  );
  for (const membership of memberships) {
    await client.query(
      `INSERT INTO audit_events (location_id, actor_user_id, action, target_type, target_id, after_data)
       VALUES ($1, $2, 'user.anonymize', 'user', $3, $4)`,
      [
        membership.location_id,
        actorUserId,
        String(user.id),
        // The old address is deliberately NOT recorded: writing it into the
        // audit log would preserve the very identifier the request asked to
        // erase, in a table nothing is allowed to delete from.
        JSON.stringify({ status: "DISABLED", anonymized: true }),
      ],
    );
  }

  return {
    userId: user.id,
    email: placeholderEmail,
    locationsAudited: memberships.map((row) => row.location_id),
  };
}

/**
 * DEC-10's "purge complète […] en l'absence d'obligation légale
 * applicable", with that absence *checked* rather than asserted.
 *
 * Refuses outright while any transactional row still sits inside the
 * six-year window. That refusal is this ticket's acceptance criterion: a
 * purge that quietly took the accounting records with it would satisfy a
 * customer's request by breaking an obligation neither of them can waive.
 *
 * Deletion is children-first because this schema cascades in only one
 * direction: `locations` cascades to most tables, but `payments` → `orders`,
 * `order_items`/`stock_movements`/`stock_counts` → `products` and
 * `stock_counts` → `stock_movements` are all `NO ACTION` and must be
 * unwound by hand.
 */
export async function purgeEstablishment(client, locationId, { confirm = false, now } = {}) {
  if (!confirm) {
    throw new Error("Une purge complète exige une confirmation explicite du client (DEC-10).");
  }

  const status = await getRetentionStatus(client, locationId, now);
  if (!status.purgeAllowed) {
    throw new Error(
      `Purge refusée : ${status.totalProtectedRows} enregistrement(s) comptable(s) sont encore ` +
        `dans la période de conservation de ${RETENTION_YEARS} ans. ` +
        `Anonymisez les comptes ; la purge sera possible à partir du ${status.purgeAllowedFrom}.`,
    );
  }

  await one(
    client,
    "SELECT id FROM locations WHERE id = $1 FOR UPDATE",
    [locationId],
    "Établissement introuvable.",
  );

  const deleted = {};
  const remove = async (label, sql) => {
    const { rowCount } = await client.query(sql, [locationId]);
    deleted[label] = rowCount ?? 0;
  };

  await remove("stock_counts", "DELETE FROM stock_counts WHERE location_id = $1");
  await remove("stock_movements", "DELETE FROM stock_movements WHERE location_id = $1");
  await remove("payments", "DELETE FROM payments WHERE location_id = $1");
  // order_items cascade from orders.
  await remove("orders", "DELETE FROM orders WHERE location_id = $1");
  await remove("products", "DELETE FROM products WHERE location_id = $1");
  await remove("categories", "DELETE FROM categories WHERE location_id = $1");
  await remove("tax_classes", "DELETE FROM tax_classes WHERE location_id = $1");
  await remove("cash_movements", "DELETE FROM cash_movements WHERE location_id = $1");
  await remove("business_days", "DELETE FROM business_days WHERE location_id = $1");
  await remove("dining_tables", "DELETE FROM dining_tables WHERE location_id = $1");
  await remove("memberships", "DELETE FROM memberships WHERE location_id = $1");
  // audit_events, location_settings, idempotency_keys and
  // order_number_counters cascade from the location itself.
  await remove("locations", "DELETE FROM locations WHERE id = $1");

  // Deliberately not audited in the database: `audit_events` is scoped to
  // the location and has just been deleted with it, so the record of a purge
  // cannot live there. The archive taken beforehand and the operator's
  // receipt are the trace.
  return { locationId, deleted };
}

async function one(db, sql, params, missing) {
  const { rows } = await db.query(sql, params);
  if (!rows[0]) throw new Error(missing);
  return rows[0];
}
