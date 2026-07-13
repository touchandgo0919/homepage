-- Add explicit tenant ownership to bookmarks.
PRAGMA foreign_keys = OFF;

CREATE TABLE bookmarks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO bookmarks_new (id, tenant_id, category_id, title, url, sort_order, created_at, updated_at)
SELECT
  bookmarks.id,
  categories.tenant_id,
  bookmarks.category_id,
  bookmarks.title,
  bookmarks.url,
  bookmarks.sort_order,
  bookmarks.created_at,
  bookmarks.updated_at
FROM bookmarks
JOIN categories ON categories.id = bookmarks.category_id;

DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

CREATE INDEX IF NOT EXISTS idx_bookmarks_category_sort ON bookmarks(category_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_tenant_sort ON bookmarks(tenant_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_tenant_category_sort ON bookmarks(tenant_id, category_id, sort_order, id);

PRAGMA foreign_keys = ON;
