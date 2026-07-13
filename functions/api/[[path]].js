const DEFAULT_TENANT = "zhaotao";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const getPath = (context) => {
  const path = context.params.path;
  return Array.isArray(path) ? path.join("/") : path || "";
};

const requireDb = (env) => {
  if (!env.DB) {
    throw Object.assign(new Error("D1 binding DB is not configured."), { status: 503 });
  }
  return env.DB;
};

const readJson = async (request) => {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
};

const requireText = (value, field) => {
  const text = String(value || "").trim();
  if (!text) {
    throw Object.assign(new Error(`${field} is required.`), { status: 400 });
  }
  return text;
};

const normalizeSlug = (value) => {
  const slug = requireText(value, "tenant").toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(slug)) {
    throw Object.assign(new Error("Tenant must be 2-63 lowercase letters, numbers, hyphens, or underscores."), {
      status: 400,
    });
  }
  return slug;
};

const requireUrl = (value) => {
  const url = requireText(value, "url");
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only http and https URLs are supported.");
    }
  } catch {
    throw Object.assign(new Error("A valid URL is required."), { status: 400 });
  }
  return url;
};

const toId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("A valid id is required."), { status: 400 });
  }
  return id;
};

const bearerToken = (request) => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

const requestedTenantSlug = (request) => {
  const url = new URL(request.url);
  return normalizeSlug(url.searchParams.get("tenant") || request.headers.get("x-tenant-slug") || DEFAULT_TENANT);
};

async function getTenantBySlug(db, slug) {
  const tenant = await db
    .prepare("SELECT id, slug, name, admin_token, sort_order FROM tenants WHERE slug = ?")
    .bind(slug)
    .first();
  if (!tenant) {
    throw Object.assign(new Error("Tenant not found."), { status: 404 });
  }
  return tenant;
}

async function requireActor(request, env, db) {
  const token = bearerToken(request);
  const platformToken = env.ADMIN_TOKEN || "";
  const tenantSlug = requestedTenantSlug(request);
  const tenant = await getTenantBySlug(db, tenantSlug);

  if (platformToken && token === platformToken) {
    return { role: "platform", tenant };
  }

  if (token && token === tenant.admin_token) {
    return { role: "tenant", tenant };
  }

  throw Object.assign(new Error("Unauthorized"), { status: 401 });
}

function requirePlatform(actor) {
  if (actor.role !== "platform") {
    throw Object.assign(new Error("Platform administrator token is required."), { status: 403 });
  }
}

async function getNav(db, slug) {
  const tenant = await getTenantBySlug(db, slug);
  const { results: categories } = await db
    .prepare(
      "SELECT id, name AS category, icon, sort_order FROM categories WHERE tenant_id = ? ORDER BY sort_order, id"
    )
    .bind(tenant.id)
    .all();
  const { results: bookmarks } = await db
    .prepare(
      `SELECT bookmarks.id, bookmarks.category_id, bookmarks.title, bookmarks.url, bookmarks.sort_order
       FROM bookmarks
       JOIN categories ON categories.id = bookmarks.category_id
       WHERE categories.tenant_id = ?
       ORDER BY bookmarks.category_id, bookmarks.sort_order, bookmarks.id`
    )
    .bind(tenant.id)
    .all();

  return {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    data: categories.map((category) => ({
      id: category.id,
      category: category.category,
      icon: category.icon,
      sort_order: category.sort_order,
      links: bookmarks
        .filter((bookmark) => bookmark.category_id === category.id)
        .map((bookmark) => ({
          id: bookmark.id,
          category_id: bookmark.category_id,
          title: bookmark.title,
          url: bookmark.url,
          sort_order: bookmark.sort_order,
        })),
    })),
  };
}

async function listTenants(db) {
  const { results } = await db
    .prepare("SELECT id, slug, name, sort_order, created_at, updated_at FROM tenants ORDER BY sort_order, id")
    .all();
  return results;
}

async function createTenant(db, body) {
  const slug = normalizeSlug(body.slug);
  const name = requireText(body.name || body.slug, "name");
  const adminToken = requireText(body.admin_token || body.adminToken, "admin_token");
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : Date.now();
  const result = await db
    .prepare("INSERT INTO tenants (slug, name, admin_token, sort_order) VALUES (?, ?, ?, ?)")
    .bind(slug, name, adminToken, sortOrder)
    .run();
  return { id: result.meta.last_row_id, slug, name };
}

async function updateTenant(db, id, body) {
  const slug = normalizeSlug(body.slug);
  const name = requireText(body.name || body.slug, "name");
  const adminToken = String(body.admin_token || body.adminToken || "").trim();

  if (adminToken) {
    await db
      .prepare("UPDATE tenants SET slug = ?, name = ?, admin_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(slug, name, adminToken, id)
      .run();
  } else {
    await db
      .prepare("UPDATE tenants SET slug = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(slug, name, id)
      .run();
  }

  return { id, slug, name };
}

async function createCategory(db, tenantId, body) {
  const name = requireText(body.name || body.category, "name");
  const icon = requireText(body.icon || "book", "icon");
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : Date.now();
  const result = await db
    .prepare("INSERT INTO categories (tenant_id, name, icon, sort_order) VALUES (?, ?, ?, ?)")
    .bind(tenantId, name, icon, sortOrder)
    .run();
  return { id: result.meta.last_row_id };
}

async function updateCategory(db, tenantId, id, body) {
  const name = requireText(body.name || body.category, "name");
  const icon = requireText(body.icon || "book", "icon");
  await db
    .prepare("UPDATE categories SET name = ?, icon = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?")
    .bind(name, icon, id, tenantId)
    .run();
  return { id };
}

async function createBookmark(db, tenantId, body) {
  const categoryId = toId(body.category_id);
  const title = requireText(body.title, "title");
  const url = requireUrl(body.url);
  const category = await db
    .prepare("SELECT id FROM categories WHERE id = ? AND tenant_id = ?")
    .bind(categoryId, tenantId)
    .first();
  if (!category) {
    throw Object.assign(new Error("Category not found for tenant."), { status: 404 });
  }

  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : Date.now();
  const result = await db
    .prepare("INSERT INTO bookmarks (category_id, title, url, sort_order) VALUES (?, ?, ?, ?)")
    .bind(categoryId, title, url, sortOrder)
    .run();
  return { id: result.meta.last_row_id };
}

async function updateBookmark(db, tenantId, id, body) {
  const categoryId = toId(body.category_id);
  const title = requireText(body.title, "title");
  const url = requireUrl(body.url);
  const category = await db
    .prepare("SELECT id FROM categories WHERE id = ? AND tenant_id = ?")
    .bind(categoryId, tenantId)
    .first();
  if (!category) {
    throw Object.assign(new Error("Category not found for tenant."), { status: 404 });
  }

  await db
    .prepare(
      `UPDATE bookmarks
       SET category_id = ?, title = ?, url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM categories WHERE categories.id = bookmarks.category_id AND categories.tenant_id = ?
       )`
    )
    .bind(categoryId, title, url, id, tenantId)
    .run();
  return { id };
}

async function reorder(db, tenantId, table, ids, categoryId) {
  if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(Number(id)))) {
    throw Object.assign(new Error("ids must be an array of numeric ids."), { status: 400 });
  }

  if (table === "bookmarks") {
    const category = await db
      .prepare("SELECT id FROM categories WHERE id = ? AND tenant_id = ?")
      .bind(categoryId, tenantId)
      .first();
    if (!category) {
      throw Object.assign(new Error("Category not found for tenant."), { status: 404 });
    }
  }

  const statements = ids.map((id, index) => {
    if (table === "bookmarks") {
      return db
        .prepare(
          `UPDATE bookmarks
           SET sort_order = ?, category_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM categories WHERE categories.id = bookmarks.category_id AND categories.tenant_id = ?
           )`
        )
        .bind(index, categoryId, Number(id), tenantId);
    }

    return db
      .prepare("UPDATE categories SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?")
      .bind(index, Number(id), tenantId);
  });

  if (statements.length) {
    await db.batch(statements);
  }

  return { ok: true };
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const path = getPath(context).replace(/^\/+|\/+$/g, "");
  const parts = path.split("/").filter(Boolean);

  try {
    const db = requireDb(env);

    if (method === "GET" && path === "nav") {
      const slug = requestedTenantSlug(request);
      return json(await getNav(db, slug));
    }

    if (path === "health") {
      return json({ ok: true });
    }

    if (method === "POST" && path === "auth/tenant") {
      const body = await readJson(request);
      const fakeUrl = new URL(request.url);
      fakeUrl.searchParams.set("tenant", normalizeSlug(body.slug));
      const authRequest = new Request(fakeUrl, { headers: { authorization: `Bearer ${requireText(body.token, "token")}` } });
      const actor = await requireActor(authRequest, env, db);
      return json({
        role: actor.role,
        tenant: { id: actor.tenant.id, slug: actor.tenant.slug, name: actor.tenant.name },
      });
    }

    const actor = await requireActor(request, env, db);
    const tenantId = actor.tenant.id;

    if (method === "GET" && path === "tenants") {
      requirePlatform(actor);
      return json({ data: await listTenants(db) });
    }

    if (method === "POST" && path === "tenants") {
      requirePlatform(actor);
      return json(await createTenant(db, await readJson(request)), 201);
    }

    if (method === "PUT" && parts[0] === "tenants" && parts[1]) {
      requirePlatform(actor);
      return json(await updateTenant(db, toId(parts[1]), await readJson(request)));
    }

    if (method === "DELETE" && parts[0] === "tenants" && parts[1]) {
      requirePlatform(actor);
      await db.prepare("DELETE FROM tenants WHERE id = ? AND slug <> ?").bind(toId(parts[1]), DEFAULT_TENANT).run();
      return json({ ok: true });
    }

    if (method === "POST" && path === "categories") {
      return json(await createCategory(db, tenantId, await readJson(request)), 201);
    }

    if (method === "PUT" && parts[0] === "categories" && parts[1]) {
      return json(await updateCategory(db, tenantId, toId(parts[1]), await readJson(request)));
    }

    if (method === "DELETE" && parts[0] === "categories" && parts[1]) {
      await db.prepare("DELETE FROM categories WHERE id = ? AND tenant_id = ?").bind(toId(parts[1]), tenantId).run();
      return json({ ok: true });
    }

    if (method === "POST" && path === "bookmarks") {
      return json(await createBookmark(db, tenantId, await readJson(request)), 201);
    }

    if (method === "PUT" && parts[0] === "bookmarks" && parts[1]) {
      return json(await updateBookmark(db, tenantId, toId(parts[1]), await readJson(request)));
    }

    if (method === "DELETE" && parts[0] === "bookmarks" && parts[1]) {
      await db
        .prepare(
          `DELETE FROM bookmarks
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM categories WHERE categories.id = bookmarks.category_id AND categories.tenant_id = ?
           )`
        )
        .bind(toId(parts[1]), tenantId)
        .run();
      return json({ ok: true });
    }

    if (method === "POST" && path === "reorder/categories") {
      const body = await readJson(request);
      return json(await reorder(db, tenantId, "categories", body.ids));
    }

    if (method === "POST" && path === "reorder/bookmarks") {
      const body = await readJson(request);
      return json(await reorder(db, tenantId, "bookmarks", body.ids, toId(body.category_id)));
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error.message || "Unexpected error" }, error.status || 500);
  }
}
