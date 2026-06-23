/**
 * seed.js
 *
 * Generates ~200,000 products directly inside Postgres using
 * generate_series + INSERT ... SELECT, instead of looping in JS and
 * sending 200,000 individual INSERT statements (which would be slow:
 * mostly network round-trip and per-statement overhead, not real work).
 *
 * This single set-based INSERT typically finishes in well under a second
 * on a modest Postgres instance.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/seed.js
 *   node scripts/seed.js --count=200000   (optional override, default 200000)
 */

import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

dotenv.config();

const { Pool } = pg;

const args = process.argv.slice(2);
const countArg = args.find((a) => a.startsWith("--count="));
const TOTAL_PRODUCTS = countArg ? parseInt(countArg.split("=")[1], 10) : 200_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CATEGORIES = [
  "Electronics",
  "Home & Kitchen",
  "Books",
  "Clothing",
  "Sports & Outdoors",
  "Toys & Games",
  "Beauty & Personal Care",
  "Automotive",
  "Office Supplies",
  "Garden & Patio",
  "Pet Supplies",
  "Health & Wellness",
];

const ADJECTIVES = [
  "Premium",
  "Compact",
  "Wireless",
  "Eco-Friendly",
  "Heavy-Duty",
  "Portable",
  "Deluxe",
  "Classic",
  "Smart",
  "Ergonomic",
  "Rechargeable",
  "Adjustable",
];

const NOUNS = [
  "Backpack",
  "Blender",
  "Headphones",
  "Desk Lamp",
  "Water Bottle",
  "Notebook",
  "Charger",
  "Office Chair",
  "Running Shoes",
  "Coffee Maker",
  "Bluetooth Speaker",
  "Yoga Mat",
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL env var is required.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  console.log(`Connecting to database...`);
  const client = await pool.connect();

  try {
    console.log("Ensuring schema exists...");
    const schemaSql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf-8");
    await client.query(schemaSql);

    console.log(`Seeding ${TOTAL_PRODUCTS.toLocaleString()} products...`);
    const start = Date.now();

    // We pass the word lists in as arrays and let Postgres pick random
    // combinations + a random recent timestamp for created_at, all in one
    // set-based statement. This avoids 200k network round trips.
    //
    // created_at is spread across the last 30 days so "newest first"
    // browsing has realistic variety, and a small random jitter on
    // updated_at vs created_at means most rows start with updated_at ==
    // created_at (as a fresh insert should).
    const insertSql = `
      INSERT INTO products (name, category, price_cents, created_at, updated_at)
      SELECT
        adjectives[1 + floor(random() * array_length(adjectives, 1))::int]
          || ' ' ||
          nouns[1 + floor(random() * array_length(nouns, 1))::int]
          || ' #' || gs::text AS name,
        categories[1 + floor(random() * array_length(categories, 1))::int] AS category,
        (500 + floor(random() * 49500))::bigint AS price_cents, -- $5.00 - $500.00
        ts AS created_at,
        ts AS updated_at
      FROM generate_series(1, $1::int) AS gs
      CROSS JOIN LATERAL (
        SELECT now() - (random() * interval '30 days')
                      - (floor(random() * 86400) || ' seconds')::interval AS ts
      ) t
      CROSS JOIN (SELECT $2::text[] AS categories) c
      CROSS JOIN (SELECT $3::text[] AS adjectives) a
      CROSS JOIN (SELECT $4::text[] AS nouns) n;
    `;

    await client.query(insertSql, [TOTAL_PRODUCTS, CATEGORIES, ADJECTIVES, NOUNS]);

    const elapsedMs = Date.now() - start;
    console.log(`Inserted ${TOTAL_PRODUCTS.toLocaleString()} rows in ${elapsedMs}ms.`);

    const { rows } = await client.query("SELECT count(*)::int AS count FROM products");
    console.log(`Total products in table: ${rows[0].count.toLocaleString()}`);

    console.log("Running ANALYZE so the query planner has fresh statistics...");
    await client.query("ANALYZE products");

    console.log("Done.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
