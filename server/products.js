import { pool } from "./db.js";

/**
 * Keyset (cursor) pagination over products, sorted newest-first.
 *
 * WHY NOT OFFSET PAGINATION
 * --------------------------
 * `OFFSET n LIMIT 20` has two problems at this scale and under concurrent
 * writes:
 *
 *   1. Performance: Postgres has to walk and discard the first `n` rows of
 *      the index every single request. Page 1 is fast; page 5,000 is slow,
 *      and gets slower the deeper you paginate (O(n)).
 *
 *   2. Correctness under concurrent writes: OFFSET defines a page purely by
 *      *position* in the current result set. If a row is inserted ahead of
 *      the user's current offset (e.g. a new product, which sorts first
 *      since we order newest-first), everything after it shifts down by
 *      one. The user's next OFFSET-based request re-fetches a row they
 *      already saw (duplicate) and skips the row that shifted into the
 *      position they already passed (missed row).
 *
 * THE FIX: KEYSET PAGINATION
 * ---------------------------
 * Instead of "skip N rows", each page is defined by "give me the rows that
 * come after the last row I saw, in sort order". The cursor is the sort key
 * of the last row on the current page: (created_at, id).
 *
 *   WHERE (created_at, id) < (:cursor_created_at, :cursor_id)
 *   ORDER BY created_at DESC, id DESC
 *   LIMIT :pageSize
 *
 * This is anchored to actual row identity, not position:
 *   - New inserts always sort before the cursor (they're newer), so they
 *     never retroactively appear on a page the user already passed, and
 *     never shift the position of rows the user hasn't seen yet.
 *   - It's a direct index seek (see db/schema.sql), so it's O(log n) /
 *     effectively constant time no matter how deep into the dataset you
 *     are -- unlike OFFSET which is O(n).
 *
 * WHY (created_at, id) AND NOT JUST created_at
 * -----------------------------------------------
 * created_at has finite resolution (microseconds in Postgres, but with
 * 200k+ bulk-inserted rows, many legitimately share the exact same
 * timestamp). Sorting by created_at alone would make the order ambiguous
 * for ties, which breaks keyset pagination (you can't form a strict
 * "< cursor" boundary against a non-unique key without risking skipping or
 * repeating tied rows). Adding id (which IS unique) as a tiebreaker makes
 * the sort key a strict total order, so the "< cursor" comparison is always
 * unambiguous.
 *
 * WHY UPDATES DON'T BREAK THIS
 * ------------------------------
 * created_at is set once at INSERT time and is never modified after
 * (see db/schema.sql -- only updated_at changes on UPDATE, via trigger).
 * That means an update to a product's price/name/category never changes
 * its position in the newest-first order. A user mid-pagination might see
 * an older or newer version of a row's *fields* depending on exact timing,
 * but the row itself is never duplicated or skipped because of an update.
 * This is the key design choice that makes "show correct data while data
 * is changing" possible: the sort key is append-only / immutable.
 *
 * A SHARP EDGE: TIMESTAMP PRECISION IN THE CURSOR
 * --------------------------------------------------
 * Postgres `timestamptz` stores microsecond precision. The node `pg`
 * driver parses timestamptz columns into JS `Date` objects, which only
 * have *millisecond* precision -- so round-tripping a row's created_at
 * through `new Date(...).toISOString()` silently truncates/rounds the
 * last 3 digits. With 200k rows bulk-inserted, many rows legitimately
 * share the same timestamp down to the microsecond, so this truncation
 * is not a rare edge case here: it can make the "< cursor" boundary
 * exclude every row that actually ties with the cursor's true value,
 * because the truncated cursor compares as *earlier* than the real
 * timestamp those rows have. The practical symptom is pages going empty
 * partway through pagination even though rows remain.
 *
 * Fix: never round-trip the cursor's timestamp through a JS Date. We ask
 * Postgres for the raw text representation (full precision) specifically
 * for cursor purposes, and pass that string straight back into the next
 * query's parameter -- Postgres parses its own text format losslessly.
 */

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

/**
 * Encode a cursor (created_at + id of the last row on a page) into an
 * opaque, URL-safe string. Opaque so the API contract doesn't leak internal
 * column names/types, and so we can change the cursor's internal shape
 * later without breaking clients that just pass it back verbatim.
 *
 * `createdAt` here must be the full-precision text form straight from
 * Postgres (see the `created_at_raw` column in the SELECT below), not a
 * JS Date/ISO string -- see the precision note above.
 */
export function encodeCursor({ createdAt, id }) {
  const payload = JSON.stringify({ createdAt, id });
  return Buffer.from(payload, "utf-8").toString("base64url");
}

export function decodeCursor(cursorStr) {
  try {
    const json = Buffer.from(cursorStr, "base64url").toString("utf-8");
    const parsed = JSON.parse(json);
    if (!parsed.createdAt || parsed.id === undefined || parsed.id === null) return null;
    const id = Number(parsed.id);
    if (!Number.isFinite(id)) return null;
    // Intentionally NOT parsed into a JS Date here -- createdAt is kept as
    // the raw Postgres text representation and handed back to Postgres
    // as-is, so we never lose the microsecond precision a JS Date would
    // truncate. Postgres validates/parses it when it's bound as a
    // ::timestamptz parameter below, so a malformed value will surface as
    // a query error rather than silently misbehaving.
    if (typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0) return null;
    return { createdAt: parsed.createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Fetch one page of products, newest first, optionally filtered by
 * category, optionally starting after a cursor.
 *
 * Returns { items, nextCursor, hasMore }.
 * nextCursor is null when there are no more rows (end of dataset reached
 * at the time of this query).
 */
export async function getProductsPage({ category, cursor, pageSize }) {
  const limit = Math.min(Math.max(parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);

  const conditions = [];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  if (cursor) {
    // Composite row comparison: matches any row strictly "older" than the
    // cursor in (created_at, id) order. This is what makes the seek use
    // the index directly instead of scanning.
    params.push(cursor.createdAt);
    params.push(cursor.id);
    conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Fetch one extra row beyond the page size so we can tell whether
  // there's a next page without a separate COUNT query (which would be
  // slow over 200k rows and also race against concurrent writes).
  params.push(limit + 1);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT id, name, category, price_cents, created_at, updated_at,
           created_at::text AS created_at_raw
    FROM products
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limitParam}
  `;

  const { rows } = await pool.query(sql, params);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items = pageRows.map((r) => ({
    id: String(r.id),
    name: r.name,
    category: r.category,
    priceCents: Number(r.price_cents),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.created_at_raw, id: last.id }) : null;

  return { items, nextCursor, hasMore };
}

export async function getCategories() {
  const { rows } = await pool.query(
    `SELECT category, count(*)::int AS count
     FROM products
     GROUP BY category
     ORDER BY category ASC`
  );
  return rows.map((r) => ({ category: r.category, count: r.count }));
}

export async function getProductCount(category) {
  if (category) {
    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM products WHERE category = $1`, [category]);
    return rows[0].count;
  }
  // Use the much cheaper planner row-estimate for the unfiltered total --
  // an exact COUNT(*) over 200k+ rows is a full scan and, more importantly,
  // is a moving target while writes are happening concurrently. We only
  // use this for display purposes (e.g. "~200,000 products"), never for
  // pagination logic itself.
  const { rows } = await pool.query(
    `SELECT reltuples::bigint AS estimate FROM pg_class WHERE relname = 'products'`
  );
  return rows[0]?.estimate ?? null;
}
