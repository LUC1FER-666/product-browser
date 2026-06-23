import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL env var is required.");
}

// Most hosted free-tier Postgres providers (Neon, Supabase, Render) require
// SSL and present certs that aren't in a typical local trust store, so we
// disable strict verification for them. Localhost dev doesn't use SSL at all.
const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");

export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

pool.on("error", (err) => {
  // Idle client errors shouldn't crash the whole process.
  console.error("Unexpected Postgres pool error:", err);
});
