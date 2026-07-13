const DEFAULT_TENANT = "zhaotao";
const COOKIE_NAME = "nav_token";
const COOKIE_MAX_AGE = 99 * 365 * 24 * 60 * 60;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
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

const requireRole = (value) => {
  const role = String(value || "admin").trim();
  if (!["admin", "editor"].includes(role)) {
    throw Object.assign(new Error("role must be admin or editor."), { status: 400 });
  }
  return role;
};

const parseCookies = (request) =>
  Object.fromEntries(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index > -1 ? [part.slice(0, index), decodeURIComponent(part.slice(index + 1))] : [part, ""];
      })
  );

const bearerToken = (request) => (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
const authToken = (request) => bearerToken(request) || parseCookies(request)[COOKIE_NAME] || "";

const authCookie = (token) => {
  const expires = new Date(Date.now() + COOKIE_MAX_AGE * 1000).toUTCString();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; Expires=${expires}; HttpOnly; SameSite=Lax`;
};

const clearAuthCookie = () => `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax`;

const rawRequestedTenantSlug = (request) => {
  const url = new URL(request.url);
  const value = url.searchParams.get("tenant") || request.headers.get("x-tenant-slug");
  return value ? normalizeSlug(value) : null;
};

const requestedTenantSlug = (request) => rawRequestedTenantSlug(request) || DEFAULT_TENANT;

const emptyNav = () => ({
  authenticated: false,
  tenant: null,
  data: [],
});

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
  const token = authToken(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }

  const platformToken = env.ADMIN_TOKEN || "";
  const requestedSlug = rawRequestedTenantSlug(request);
  const tenantSlug = requestedSlug || DEFAULT_TENANT;

  if (platformToken && token === platformToken) {
    const tenant = await getTenantBySlug(db, tenantSlug);
    return { role: "platform", tenant };
  }

  const tokenRow = await db
    .prepare(
      `SELECT tenant_tokens.id AS token_id, tenant_tokens.name AS token_name, tenant_tokens.role,
              tenants.id, tenants.slug, tenants.name, tenants.admin_token, tenants.sort_order
       FROM tenant_tokens
       JOIN tenants ON tenants.id = tenant_tokens.tenant_id
       WHERE tenant_tokens.token = ?`
    )
    .bind(token)
    .first();

  if (tokenRow) {
    if (requestedSlug && requestedSlug !== tokenRow.slug) {
      throw Object.assign(new Error("Token does not belong to requested tenant."), { status: 403 });
    }
    return {
      role: tokenRow.role,
      token: { id: tokenRow.token_id, name: tokenRow.token_name },
      tenant: {
        id: tokenRow.id,
        slug: tokenRow.slug,
        name: tokenRow.name,
        admin_token: tokenRow.admin_token,
        sort_order: tokenRow.sort_order,
      },
    };
  }

  const tenant = await getTenantBySlug(db, tenantSlug);
  if (token === tenant.admin_token) {
    return { role: "admin", tenant };
  }

  throw Object.assign(new Error("Unauthorized"), { status: 401 });
}

async function getOptionalActor(request, env, db) {
  try {
    return await requireActor(request, env, db);
  } catch (error) {
    if (error.status === 401) {
      return null;
    }
    throw error;
  }
}

function requirePlatform(actor) {
  if (actor.role !== "platform") {
    throw Object.assign(new Error("Platform administrator token is required."), { status: 403 });
  }
}

function requireTenantAdmin(actor) {
  if (!["platform", "admin"].includes(actor.role)) {
    throw Object.assign(new Error("Tenant administrator token is required."), { status: 403 });
  }
}

async function getNavForTenant(db, tenant) {
  const { results: categories } = await db
    .prepare(
      "SELECT id, name AS category, icon, sort_order FROM categories WHERE tenant_id = ? ORDER BY sort_order, id"
    )
    .bind(tenant.id)
    .all();
  const { results: bookmarks } = await db
    .prepare(
      `SELECT id, tenant_id, category_id, title, url, sort_order
       FROM bookmarks
       WHERE tenant_id = ?
       ORDER BY category_id, sort_order, id`
    )
    .bind(tenant.id)
    .all();

  const bookmarksByCategory = new Map();
  for (const bookmark of bookmarks) {
    if (!bookmarksByCategory.has(bookmark.category_id)) {
      bookmarksByCategory.set(bookmark.category_id, []);
    }
    bookmarksByCategory.get(bookmark.category_id).push({
      id: bookmark.id,
      tenant_id: bookmark.tenant_id,
      category_id: bookmark.category_id,
      title: bookmark.title,
      url: bookmark.url,
      sort_order: bookmark.sort_order,
    });
  }

  return {
    authenticated: true,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    data: categories.map((category) => ({
      id: category.id,
      category: category.category,
      icon: category.icon,
      sort_order: category.sort_order,
      links: bookmarksByCategory.get(category.id) || [],
    })),
  };
}

async function getNav(db, slug) {
  return getNavForTenant(db, await getTenantBySlug(db, slug));
}

async function listTenants(db) {
  const { results } = await db
    .prepare("SELECT id, slug, name, sort_order, created_at, updated_at FROM tenants ORDER BY sort_order, id")
    .all();
  return results;
}

function ownTenant(actor) {
  return [{
    id: actor.tenant.id,
    slug: actor.tenant.slug,
    name: actor.tenant.name,
    sort_order: actor.tenant.sort_order,
  }];
}

async function createTenant(db, body) {
  const slug = normalizeSlug(body.slug);
  const name = requireText(body.name || body.slug, "name");
  const adminToken = requireText(body.admin_token || body.adminToken, "admin_token");
  const tokenRole = requireRole(body.token_role || body.tokenRole || body.role);
  const sortOrder = Number.isInteger(body.sort_order) ? body.sort_order : Date.now();
  const result = await db
    .prepare("INSERT INTO tenants (slug, name, admin_token, sort_order) VALUES (?, ?, ?, ?)")
    .bind(slug, name, adminToken, sortOrder)
    .run();
  await db
    .prepare("INSERT OR IGNORE INTO tenant_tokens (tenant_id, name, token, role) VALUES (?, ?, ?, ?)")
    .bind(result.meta.last_row_id, `${name} ${tokenRole === "admin" ? "管理员" : "编辑者"}`, adminToken, tokenRole)
    .run();
  return { id: result.meta.last_row_id, slug, name };
}

async function updateTenant(db, id, body) {
  const slug = normalizeSlug(body.slug);
  const name = requireText(body.name || body.slug, "name");
  const adminToken = String(body.admin_token || body.adminToken || "").trim();
  const tokenRole = requireRole(body.token_role || body.tokenRole || body.role);

  if (adminToken) {
    await db
      .prepare("UPDATE tenants SET slug = ?, name = ?, admin_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(slug, name, adminToken, id)
      .run();
    await db
      .prepare("INSERT OR IGNORE INTO tenant_tokens (tenant_id, name, token, role) VALUES (?, ?, ?, ?)")
      .bind(id, `${name} ${tokenRole === "admin" ? "管理员" : "编辑者"}`, adminToken, tokenRole)
      .run();
  } else {
    await db
      .prepare("UPDATE tenants SET slug = ?, name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(slug, name, id)
      .run();
  }

  return { id, slug, name };
}

async function listTokens(db, tenantId) {
  const { results } = await db
    .prepare("SELECT id, name, role, created_at, updated_at FROM tenant_tokens WHERE tenant_id = ? ORDER BY id")
    .bind(tenantId)
    .all();
  return results;
}

async function createToken(db, tenantId, body) {
  const name = requireText(body.name, "name");
  const token = requireText(body.token, "token");
  const role = requireRole(body.role || "editor");
  const result = await db
    .prepare("INSERT INTO tenant_tokens (tenant_id, name, token, role) VALUES (?, ?, ?, ?)")
    .bind(tenantId, name, token, role)
    .run();
  return { id: result.meta.last_row_id, name, role };
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
    .prepare("INSERT INTO bookmarks (tenant_id, category_id, title, url, sort_order) VALUES (?, ?, ?, ?, ?)")
    .bind(tenantId, categoryId, title, url, sortOrder)
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
       SET tenant_id = ?, category_id = ?, title = ?, url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`
    )
    .bind(tenantId, categoryId, title, url, id, tenantId)
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
           SET sort_order = ?, tenant_id = ?, category_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(index, tenantId, categoryId, Number(id), tenantId);
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
      const actor = await getOptionalActor(request, env, db);
      if (!actor) {
        return json(emptyNav());
      }
      const requestedSlug = rawRequestedTenantSlug(request);
      const nav = actor.role === "platform" && requestedSlug && requestedSlug !== actor.tenant.slug
        ? await getNav(db, requestedSlug)
        : await getNavForTenant(db, actor.tenant);
      return json({ ...nav, role: actor.role });
    }

    if (path === "health") {
      return json({ ok: true });
    }

    if (method === "GET" && path === "auth/session") {
      const actor = await requireActor(request, env, db);
      return json({
        role: actor.role,
        tenant: { id: actor.tenant.id, slug: actor.tenant.slug, name: actor.tenant.name },
      });
    }

    if (method === "POST" && path === "auth/token") {
      const body = await readJson(request);
      const authRequest = new Request(request.url, { headers: { authorization: `Bearer ${requireText(body.token, "token")}` } });
      const actor = await requireActor(authRequest, env, db);
      return json({
        role: actor.role,
        tenant: { id: actor.tenant.id, slug: actor.tenant.slug, name: actor.tenant.name },
      }, 200, {
        "set-cookie": authCookie(requireText(body.token, "token")),
      });
    }

    if (method === "POST" && path === "auth/logout") {
      return json({ ok: true }, 200, { "set-cookie": clearAuthCookie() });
    }

    const actor = await requireActor(request, env, db);
    const tenantId = actor.tenant.id;

    if (method === "GET" && path === "tenants") {
      requireTenantAdmin(actor);
      return json({ data: actor.role === "platform" ? await listTenants(db) : ownTenant(actor) });
    }

    if (method === "POST" && path === "tenants") {
      requirePlatform(actor);
      return json(await createTenant(db, await readJson(request)), 201);
    }

    if (method === "PUT" && parts[0] === "tenants" && parts[1]) {
      requireTenantAdmin(actor);
      const id = toId(parts[1]);
      if (actor.role !== "platform" && id !== actor.tenant.id) {
        throw Object.assign(new Error("Tenant administrators can only update their own tenant."), { status: 403 });
      }
      return json(await updateTenant(db, id, await readJson(request)));
    }

    if (method === "DELETE" && parts[0] === "tenants" && parts[1]) {
      requirePlatform(actor);
      await db.prepare("DELETE FROM tenants WHERE id = ? AND slug <> ?").bind(toId(parts[1]), DEFAULT_TENANT).run();
      return json({ ok: true });
    }

    if (method === "GET" && path === "tokens") {
      requireTenantAdmin(actor);
      return json({ data: await listTokens(db, tenantId) });
    }

    if (method === "POST" && path === "tokens") {
      requireTenantAdmin(actor);
      return json(await createToken(db, tenantId, await readJson(request)), 201);
    }

    if (method === "DELETE" && parts[0] === "tokens" && parts[1]) {
      requireTenantAdmin(actor);
      await db.prepare("DELETE FROM tenant_tokens WHERE id = ? AND tenant_id = ?").bind(toId(parts[1]), tenantId).run();
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
           WHERE id = ? AND tenant_id = ?`
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
