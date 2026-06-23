-- Schema for the product browser.
--
-- Pagination strategy: keyset (a.k.a. cursor/seek) pagination on
-- (created_at, id), NOT offset pagination. See README for why.
--
-- Because created_at has limited resolution and we bulk-insert 200k rows,
-- many rows can share the exact same created_at timestamp. id is used as
-- a tiebreaker so the (created_at, id) pair is always a strict total order
-- with no duplicates -- this is what makes the cursor unambiguous.

CREATE TABLE IF NOT EXISTS products (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite index supporting the unfiltered "newest first" keyset scan.
-- (created_at DESC, id DESC) lets Postgres do an index-only backward/forward
-- seek for "WHERE (created_at, id) < (cursor_created_at, cursor_id)"
-- instead of scanning + sorting the whole table.
CREATE INDEX IF NOT EXISTS idx_products_created_id
    ON products (created_at DESC, id DESC);

-- Composite index supporting the same keyset scan WHEN filtered by category.
-- category is the leading column so Postgres can seek directly to the
-- matching rows instead of scanning the whole table and filtering after.
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
    ON products (category, created_at DESC, id DESC);

-- NOTE: we intentionally do NOT add a standalone index on (category) --
-- idx_products_category_created_id above already covers category-only
-- lookups via its leftmost column, so a separate index would just add
-- write overhead without speeding up any query we actually run.

-- Keep updated_at correct automatically on any UPDATE, without relying on
-- application code to remember to set it (and so simulated "live edits"
-- in the demo are realistic).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
