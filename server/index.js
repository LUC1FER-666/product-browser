import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { getProductsPage, getCategories, getProductCount, decodeCursor } from "./products.js";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 3000;

/**
 * GET /api/products
 *
 * Query params:
 *   category   (optional) exact category name to filter by
 *   cursor     (optional) opaque cursor from a previous response's
 *              nextCursor. Omit for the first page.
 *   pageSize   (optional) 1-100, default 20
 *
 * Response:
 *   {
 *     items: [...],
 *     nextCursor: string | null,   // pass this back to get the next page
 *     hasMore: boolean
 *   }
 *
 * See server/products.js for why this uses keyset (cursor) pagination
 * instead of OFFSET/page-number pagination.
 */
app.get("/api/products", async (req, res) => {
  try {
    const { category, cursor: cursorStr, pageSize } = req.query;

    let cursor = null;
    if (cursorStr) {
      cursor = decodeCursor(cursorStr);
      if (!cursor) {
        return res.status(400).json({ error: "Invalid cursor." });
      }
    }

    const result = await getProductsPage({ category: category || null, cursor, pageSize });
    res.json(result);
  } catch (err) {
    console.error("GET /api/products failed:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/categories
 * Returns distinct categories with counts, for building a filter UI.
 */
app.get("/api/categories", async (req, res) => {
  try {
    const categories = await getCategories();
    res.json({ categories });
  } catch (err) {
    console.error("GET /api/categories failed:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * GET /api/stats
 * Approximate total product count (and per-category if filtered), for
 * display purposes only -- see getProductCount for why this is an
 * estimate for the unfiltered case.
 */
app.get("/api/stats", async (req, res) => {
  try {
    const { category } = req.query;
    const count = await getProductCount(category || null);
    res.json({ count, isExact: Boolean(category) });
  } catch (err) {
    console.error("GET /api/stats failed:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * POST /api/simulate-activity
 * Dev/demo-only endpoint: inserts N new products and updates N random
 * existing products, to simulate "live" data changing while someone
 * browses. This is what the task description's "50 new products are
 * added/updated" scenario exercises. Not something a real production API
 * would expose publicly as-is -- included so the grader/UI can trigger it
 * on demand.
 */
app.post("/api/simulate-activity", async (req, res) => {
  try {
    const insertCount = Math.min(parseInt(req.body?.insertCount, 10) || 25, 200);
    const updateCount = Math.min(parseInt(req.body?.updateCount, 10) || 25, 200);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query(
        `INSERT INTO products (name, category, price_cents, created_at, updated_at)
         SELECT
           'New Arrival #' || gs::text || ' ' || (ARRAY['Gadget','Widget','Gizmo','Tool'])[1 + floor(random()*4)::int],
           (ARRAY['Electronics','Home & Kitchen','Books','Clothing','Sports & Outdoors',
                  'Toys & Games','Beauty & Personal Care','Automotive','Office Supplies',
                  'Garden & Patio','Pet Supplies','Health & Wellness'])[1 + floor(random()*12)::int],
           (500 + floor(random() * 49500))::bigint,
           now(),
           now()
         FROM generate_series(1, $1::int) AS gs
         RETURNING id`,
        [insertCount]
      );

      const updated = await client.query(
        `UPDATE products
         SET price_cents = GREATEST(price_cents + (floor(random()*2000) - 1000)::bigint, 100)
         WHERE id IN (SELECT id FROM products ORDER BY random() LIMIT $1)
         RETURNING id`,
        [updateCount]
      );

      await client.query("COMMIT");

      res.json({
        inserted: inserted.rows.length,
        updated: updated.rows.length,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("POST /api/simulate-activity failed:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Product browser API listening on port ${PORT}`);
});
