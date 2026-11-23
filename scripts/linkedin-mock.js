/**
 * Prueba del flujo OAuth de LinkedIn sin salir a internet: levanta la app en un puerto libre y
 * simula los endpoints de LinkedIn (accessToken y userinfo) interceptando fetch.
 * Uso: npm run test:linkedin   (necesita la base de datos; no necesita la API en marcha)
 */
process.env.LINKEDIN_CLIENT_ID ||= "mock-client";
process.env.LINKEDIN_CLIENT_SECRET ||= "mock-secret";

const { createApp } = await import("../src/app.js");
const { pool } = await import("../src/db.js");

const SUB = `mock-sub-${Date.now()}`;
const EMAIL = `${SUB}@linkedin.test`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://www.linkedin.com/oauth/v2/accessToken")) {
    return new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), { status: 200 });
  }
  if (u.startsWith("https://api.linkedin.com/v2/userinfo")) {
    return new Response(JSON.stringify({ sub: SUB, name: "Laura Mock", email: EMAIL, email_verified: true, picture: "https://example.com/p.jpg" }), { status: 200 });
  }
  return realFetch(url, init);
};

const server = createApp().listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const RETURN = "http://localhost:5173/";
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failed++; };
const get = (p) => realFetch(BASE + p, { redirect: "manual" });

async function start(scopes) {
  const r = await get(`/api/auth/linkedin?scopes=${scopes}&legalVersion=1.2&returnTo=${encodeURIComponent(RETURN)}`);
  const loc = new URL(r.headers.get("location"));
  return { status: r.status, loc, state: loc.searchParams.get("state") };
}

try {
  const bad = await get(`/api/auth/linkedin?legalVersion=1.2&returnTo=${encodeURIComponent("https://evil.example/")}`);
  ok(bad.status === 400, "returnTo fuera de CORS_ORIGIN → 400");

  const s1 = await start("work");
  ok(s1.status === 302 && s1.loc.host === "www.linkedin.com" && s1.loc.searchParams.get("scope") === "openid profile email", "redirige a LinkedIn con openid profile email");

  const cancel = await get(`/api/auth/linkedin/callback?error=user_cancelled_login&state=${s1.state}`);
  ok(cancel.status === 302 && new URL(cancel.headers.get("location")).searchParams.get("knet_auth_error") === "linkedin_denied", "cancelar vuelve al front con knet_auth_error");
  const reuse = await get(`/api/auth/linkedin/callback?code=x&state=${s1.state}`);
  ok(reuse.status === 400, "el state es de un solo uso");

  const s2 = await start("work,skills,hackeo");
  const cb = await get(`/api/auth/linkedin/callback?code=mock-code&state=${s2.state}`);
  const code = new URL(cb.headers.get("location")).searchParams.get("knet_auth");
  ok(cb.status === 302 && !!code, "callback vuelve al front con un código de un solo uso");

  const ex = await realFetch(BASE + "/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const sess = await ex.json();
  ok(ex.status === 200 && sess.accessToken && sess.created === true, "canje → sesión de una cuenta nueva");
  ok(JSON.stringify(sess.linkedinScopes) === JSON.stringify(["basic", "work", "skills"]), "solo se guardan los permisos válidos que marcó el usuario");
  ok(sess.user.name === "Laura Mock" && sess.user.role === "" && sess.user.company === "" && sess.user.linkedinConnected, "importa nombre; cargo y empresa quedan para el usuario");
  ok(sess.user.legalVersion === "1.2" && sess.user.emailVerified && sess.user.photoUrl, "versión legal, correo verificado y foto");

  const again = await realFetch(BASE + "/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  ok(again.status === 401, "el código no se puede canjear dos veces");

  const cons = await realFetch(BASE + "/api/me/consents", { headers: { Authorization: `Bearer ${sess.accessToken}` } }).then((r) => r.json());
  const types = cons.consents.map((c) => c.type);
  ok(types.includes("autorizacion_linkedin") && types.includes("aceptacion") && cons.chain.valid, "registra autorización de LinkedIn y aceptación con la cadena válida");

  const s3 = await start("");
  const cb3 = await get(`/api/auth/linkedin/callback?code=mock-code&state=${s3.state}`);
  const ex3 = await realFetch(BASE + "/api/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: new URL(cb3.headers.get("location")).searchParams.get("knet_auth") }) }).then((r) => r.json());
  ok(ex3.created === false && ex3.user.id === sess.user.id, "segundo login con el mismo sub reutiliza la cuenta");

  const del = await realFetch(BASE + "/api/me", { method: "DELETE", headers: { Authorization: `Bearer ${ex3.accessToken}` } });
  ok(del.status === 200, "limpieza: borra la cuenta de prueba");
} finally {
  server.close();
  await pool.end();
}
console.log(failed ? `\n${failed} prueba(s) fallaron` : "\nFlujo de LinkedIn OK");
process.exit(failed ? 1 : 0);
