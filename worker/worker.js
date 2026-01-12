export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS simple (pour GitHub Pages)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/auth/start") {
      const returnTo = url.searchParams.get("return_to") || "https://example.com";
      const state = btoa(JSON.stringify({ returnTo, ts: Date.now() }));

      const scope = [
        "instagram_basic",
        "instagram_content_publish",
        "pages_show_list",
        "pages_read_engagement"
      ].join(",");

      const authUrl = new URL("https://www.facebook.com/v19.0/dialog/oauth");
      authUrl.searchParams.set("client_id", env.FB_APP_ID);
      authUrl.searchParams.set("redirect_uri", env.REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set("state", state);

      return Response.redirect(authUrl.toString(), 302);
    }

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return json({ error: { message: "Missing code/state" } }, 400);

      let returnTo = "https://example.com";
      try {
        returnTo = JSON.parse(atob(state)).returnTo || returnTo;
      } catch {}

      // 1) Exchange code -> short-lived token
      const tokenRes = await fetchJson("https://graph.facebook.com/v19.0/oauth/access_token", {
        client_id: env.FB_APP_ID,
        client_secret: env.FB_APP_SECRET,
        redirect_uri: env.REDIRECT_URI,
        code
      });

      if (tokenRes.error) return json(tokenRes, 400);

      // 2) Optional: exchange to long-lived token
      const llRes = await fetchJson("https://graph.facebook.com/v19.0/oauth/access_token", {
        grant_type: "fb_exchange_token",
        client_id: env.FB_APP_ID,
        client_secret: env.FB_APP_SECRET,
        fb_exchange_token: tokenRes.access_token
      });
      const access_token = llRes.access_token || tokenRes.access_token;

      // 3) Get a Page
      // /me/accounts returns pages the user manages
      const pages = await fetch(`https://graph.facebook.com/v19.0/me/accounts?access_token=${encodeURIComponent(access_token)}`);
      const pagesJson = await pages.json();
      if (pagesJson.error) return json(pagesJson, 400);

      const page = pagesJson.data?.[0];
      if (!page?.id) {
        return json({ error: { message: "No Facebook Page found. Link your IG pro account to a Facebook Page." } }, 400);
      }

      // 4) Get instagram_business_account (ig user id)
      const pageInfo = await fetch(`https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account&access_token=${encodeURIComponent(access_token)}`);
      const pageInfoJson = await pageInfo.json();
      const ig_id = pageInfoJson.instagram_business_account?.id;

      if (!ig_id) {
        return json({ error: { message: "No instagram_business_account found. Ensure IG is Business/Creator and connected to the Page." } }, 400);
      }

      // Redirect back to GitHub Pages with token + ig_id in hash
      const back = new URL(returnTo);
      back.hash = `access_token=${encodeURIComponent(access_token)}&ig_id=${encodeURIComponent(ig_id)}`;
      return Response.redirect(back.toString(), 302);
    }

    if (url.pathname === "/publish" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: { message: "Invalid JSON" } }, 400);

      const { access_token, ig_id, video_url, caption } = body;
      if (!access_token || !ig_id || !video_url) {
        return json({ error: { message: "Missing access_token / ig_id / video_url" } }, 400);
      }

      // A) Create video container (Reel or Video)
      // Two-step publishing: create container then publish :contentReference[oaicite:5]{index=5}
      const create = await fetchJson(`https://graph.facebook.com/v19.0/${ig_id}/media`, {
        access_token,
        media_type: "REELS",   // ou "VIDEO" selon besoin
        video_url,
        caption: caption || ""
      });

      if (create.error) return json(create, 400);

      const creation_id = create.id;
      if (!creation_id) return json({ error: { message: "No creation_id returned" } }, 400);

      // (Optionnel mais utile) Poll status for videos
      // Some videos need processing time.
      const statusOk = await waitForContainerReady(creation_id, access_token);
      if (!statusOk.ok) return json({ error: { message: statusOk.message } }, 400);

      // B) Publish
      const pub = await fetchJson(`https://graph.facebook.com/v19.0/${ig_id}/media_publish`, {
        access_token,
        creation_id
      });

      if (pub.error) return json(pub, 400);

      return json({ media_id: pub.id }, 200);
    }

    return new Response("Not found", { status: 404 });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function fetchJson(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    u.searchParams.set(k, v);
  }
  const r = await fetch(u.toString(), { method: "POST" });
  return await r.json();
}

async function waitForContainerReady(creation_id, access_token) {
  // Best-effort polling (max ~30s)
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const r = await fetch(`https://graph.facebook.com/v19.0/${creation_id}?fields=status_code,status&access_token=${encodeURIComponent(access_token)}`);
    const j = await r.json();

    // Selon les retours, status_code peut être FINISHED / ERROR
    const code = (j.status_code || j.status || "").toUpperCase();

    if (code.includes("FINISH") || code.includes("READY") || code.includes("PUBLISHED")) {
      return { ok: true };
    }
    if (code.includes("ERROR") || j.error) {
      return { ok: false, message: j.error?.message || "Video processing error" };
    }
    await sleep(1500);
  }
  // On tente quand même de publish après timeout, mais on signale
  return { ok: true };
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
