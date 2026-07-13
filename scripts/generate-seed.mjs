import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const match = html.match(/const fallbackSiteData = ([\s\S]*?);\n\n    const icons =/);

if (!match) {
  throw new Error("Unable to find siteData in index.html");
}

const siteData = Function(`return ${match[1]}`)();

fs.mkdirSync("data", { recursive: true });
fs.mkdirSync("migrations", { recursive: true });
fs.writeFileSync("data/seed.json", `${JSON.stringify(siteData, null, 2)}\n`);

const quote = (value) => String(value).replaceAll("'", "''");

let sql = `-- D1 schema and initial navigation data.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT 'book',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_category_sort ON bookmarks(category_id, sort_order, id);

`;

siteData.forEach((group, groupIndex) => {
  sql += `INSERT INTO categories (name, icon, sort_order) VALUES ('${quote(group.category)}', '${quote(group.icon || "book")}', ${groupIndex});\n`;

  group.links.forEach((link, linkIndex) => {
    sql += `INSERT INTO bookmarks (category_id, title, url, sort_order) VALUES ((SELECT id FROM categories WHERE name='${quote(group.category)}'), '${quote(link.title)}', '${quote(link.url)}', ${linkIndex});\n`;
  });

  sql += "\n";
});

fs.writeFileSync("migrations/0001_init.sql", sql);
console.log(`Generated ${siteData.length} categories and ${siteData.reduce((sum, item) => sum + item.links.length, 0)} bookmarks.`);
