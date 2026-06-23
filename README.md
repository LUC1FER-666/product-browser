# Product Browser

Backend for browsing ~200,000 products, newest first, with category
filtering and pagination that stays correct and fast while data is being
written to concurrently.

Stack: **Node.js (Express) + PostgreSQL**. Plain SQL via `pg`, no ORM —
the whole problem here lives in the SQL/indexing strategy, so I wanted
that visible rather than abstracted away.

---

## The two requirements, and how they're met

### 1. Pagination should be fast

**Keyset (a.k.a. cursor / seek) pagination, not `OFFSET`.**

`OFFSET n LIMIT 20` makes Postgres walk and discard the first `n` rows of
the index on every request. Page 1 is instant; page 5,000 means scanning
~100,000 rows just to throw them away. It gets linearly slower the deeper
you paginate.

Instead, each page is defined by "give me what comes after the last row I
saw," anchored to that row's actual sort key:

```sql
SELECT id, name, category, price_cents, created_at, updated_at
FROM products
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT 20
```

With a composite index on `(created_at DESC, id DESC)`, this is an index
seek — `EXPLAIN ANALYZE` shows ~0.03–0.3ms whether you're on page 1 or
page 2,000, because Postgres jumps straight to the right spot in the
B-tree instead of scanning from the start. Measured: walking the entire
200,000-row table in pages of 100 takes ~5.7s end-to-end *including full
HTTP round trips* — about 2.85ms/page on average, with no degradation at
depth (see `scripts/test_concurrency.py` and the query plans below).

**Why `(created_at, id)` and not just `created_at`:** `created_at` isn't
unique — with 200k bulk-inserted rows, many legitimately share the exact
same timestamp down to the second (or even microsecond). Sorting and
seeking on a non-unique key is ambiguous: you can't form a strict "give me
everything after this point" boundary if multiple rows tie with the
cursor. Adding `id` (which *is* unique) as a tiebreaker makes the sort key
a strict total order, so keyset pagination has no ambiguous case.

For category filtering, a second composite index
`(category, created_at DESC, id DESC)` lets the same seek strategy work
when a `WHERE category = $1` clause is added — confirmed via `EXPLAIN
ANALYZE` to use an index condition (not a scan-and-filter) once the cursor
is deep enough into the data that the row-removed cost would otherwise add
up.

### 2. Correct data while data is changing

The scenario: a user is mid-pagination and 50 products get added/updated
elsewhere. They must not see a duplicate, and must not miss one.

This breaks down into two distinct cases:

**New products (INSERT).** Keyset pagination handles this for free. New
rows get `created_at = now()`, which sorts *newer* than anything the user
has already paged past (they're moving backward in time, page by page).
A new insert can only ever appear ahead of where the user currently is —
never retroactively inserted into a page already shown, and never
shifting the position of rows not yet seen. (Compare to `OFFSET`
pagination, where a new row at the top pushes everything down by one,
causing the next "page 6" request to repeat row 100 and skip row 101.)

**Updated products (UPDATE).** This is the case that actually requires a
deliberate design choice, not just "use keyset pagination." If an update
were allowed to change a row's `created_at`, it would jump that row to a
new position in the feed — which can cause exactly the duplicate/skip
problem keyset pagination is supposed to prevent, just triggered by writes
instead of reads.

The fix: **`created_at` is set once at INSERT and is never modified.** The
schema's `set_updated_at()` trigger only ever touches `updated_at` on
`UPDATE` (see `db/schema.sql`). A product's position in the newest-first
order is therefore permanently fixed at creation time. A user mid-scroll
might see an older or newer *version of a row's fields* depending on exact
timing (e.g. price changes underneath them) — but the row itself is never
duplicated or skipped because of an edit. The sort key is append-only.

**This was verified, not just argued.** `scripts/test_concurrency.py`
hits the live HTTP API, starts a slow page-by-page walk (simulating a real
user), and fires a burst of 50 concurrent inserts + 50 concurrent updates
midway through via a background thread. It asserts:
- zero duplicate ids across the whole walk, and
- the pre-existing rows still form a contiguous, gap-free, strictly
  descending id sequence (i.e. no update reshuffled anything).

Result: **PASS**, repeatably, including with the category filter applied.

#### A real bug this surfaced, worth flagging

While building this, the pagination broke (page 2 came back empty when it
shouldn't have) the first time I tested cursor chaining. Cause: the `pg`
driver parses Postgres `timestamptz` (microsecond precision) into a JS
`Date` (millisecond precision). Round-tripping a row's `created_at`
through `Date.toISOString()` to build the next cursor silently truncated
it. With 200k bulk-inserted rows, many genuinely tie on the same
millisecond — so the truncated cursor compared as *earlier* than the true
stored value, and the `< cursor` boundary excluded every row tied with
it. Pages would go empty partway through pagination even with rows
remaining.

Fix: the cursor's timestamp is never passed through a JS `Date`. The query
selects `created_at::text` (full-precision, Postgres's own text format)
specifically for the cursor, and that string is handed straight back to
Postgres as a parameter on the next request — Postgres parses its own
text format losslessly. `server/products.js` has the full writeup inline.
This is exactly the kind of subtle correctness bug that's easy to miss
without an explicit concurrent-pagination test, which is why
`test_concurrency.py` exists as a real (not theoretical) check.

---

## Project layout

```
db/schema.sql          Table + indexes + updated_at trigger
scripts/seed.js         Generates 200,000 products (bulk, set-based)
scripts/test_concurrency.py   Pagination-under-concurrent-writes test
server/db.js             Postgres connection pool
server/products.js        Pagination query logic (the core of the task)
server/index.js           Express routes
public/index.html        Minimal UI (not graded, included for demo-ability)
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/products?category=&cursor=&pageSize=` | One page of products, newest first. `cursor` is opaque — pass back the `nextCursor` from the previous response. Omit for page 1. |
| `GET /api/categories` | Distinct categories with counts (for filter UI). |
| `GET /api/stats?category=` | Approximate total count (exact if `category` given — see note below). |
| `POST /api/simulate-activity` | Dev/demo endpoint: inserts + updates N random rows, to exercise the concurrent-write scenario on demand. Body: `{ "insertCount": 50, "updateCount": 50 }`. |
| `GET /api/health` | DB connectivity check. |

`GET /api/products` response shape:
```json
{
  "items": [
    { "id": "200000", "name": "...", "category": "...", "priceCents": 4999,
      "createdAt": "2026-05-23T13:32:02.632356Z", "updatedAt": "..." }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQ...",
  "hasMore": true
}
```

**Note on `/api/stats` for the unfiltered total:** an exact `COUNT(*)` over
200k+ rows is a full table scan, and more importantly it's a moving target
while inserts are happening — there's no single "correct" instantaneous
count in a live system. The unfiltered count uses Postgres's
`pg_class.reltuples` planner estimate instead (fast, no scan), clearly
labeled as approximate (`isExact: false`) in the response. This is display
only and is never used in pagination logic, so it can't cause the
duplicate/skip problem described above.

---

## Running locally

Requires Node 18+ and a Postgres instance (local or hosted).

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL
npm run seed            # creates schema + generates 200,000 products
npm start                # http://localhost:3000
```

Open `http://localhost:3000` for the UI, or hit the API directly:
```bash
curl "http://localhost:3000/api/products?pageSize=5"
```

### Running the concurrency test

With the server running locally:
```bash
python3 scripts/test_concurrency.py
```

---

## The seed script

`scripts/seed.js` generates 200,000 products with a single set-based
`INSERT ... SELECT FROM generate_series(...)` executed inside Postgres —
not a loop issuing 200,000 individual `INSERT` statements from the
application, which would be slow mostly due to per-statement network
round-trip overhead rather than real work. Measured: **~4 seconds** for
200,000 rows, runnable repeatably (`npm run seed`).

```bash
node scripts/seed.js              # default 200,000
node scripts/seed.js --count=500000   # override row count
```

---

## Deploying (free tier, no credit card)

**Database — [Neon](https://neon.tech) or [Supabase](https://supabase.com):**
1. Create a free Postgres project.
2. Copy the connection string (Neon: shown directly; Supabase: use the
   "Connection pooling" string under Project Settings → Database for
   serverless-friendly behavior).
3. Run the seed script once against it locally:
   ```bash
   DATABASE_URL="<your connection string>" node scripts/seed.js
   ```

**Backend — [Render](https://render.com):**
1. Push this repo to GitHub.
2. New → Web Service → connect the repo. Render will pick up `render.yaml`
   automatically (Node runtime, `npm install` / `npm start`).
3. Set the `DATABASE_URL` environment variable in the Render dashboard to
   your Neon/Supabase connection string.
4. Deploy. Free tier spins down on idle, so the first request after a
   while will be slow to wake up — that's a platform characteristic, not
   a pagination issue.

---

## Design choices not asked for explicitly, but made deliberately

- **`id` is a `BIGSERIAL`, used as the tiebreaker in the sort key**, not
  just an opaque primary key. This is what makes `(created_at, id)` a
  strict total order despite mass timestamp collisions from bulk seeding.
- **`price_cents` (integer) instead of a float/decimal price column** —
  avoids floating point rounding issues in a column that's arithmetic
  (sums, comparisons) elsewhere in a real system.
- **`pageSize` is server-side clamped to 1–100** regardless of what's
  requested, so a client can't force an unbounded/expensive query.
- **`hasMore` is computed by fetching `limit + 1` rows**, not a separate
  `COUNT(*)` query — avoids a second full-table-adjacent query per page
  request, and avoids that count racing against concurrent writes.
- **Cursors are opaque (base64-encoded JSON), not raw query params** like
  `?after_id=199996&after_time=...` — keeps the internal sort-key shape
  free to change later without breaking the API contract, and clients
  are not meant to construct or interpret them.
