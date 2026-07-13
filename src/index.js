import { onRequest as apiHandler } from "../functions/api/[[path]].js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.replace(/^\/api\/?/, "");
      return apiHandler({
        request,
        env,
        params: { path },
      });
    }

    if (url.pathname === "/admin") {
      url.pathname = "/admin/";
      return Response.redirect(url.toString(), 308);
    }

    return env.ASSETS.fetch(request);
  },
};
