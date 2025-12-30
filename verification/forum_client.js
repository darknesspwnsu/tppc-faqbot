// verification/forum_client.js (ESM)
//
// Minimal vBulletin-ish forums client for forums.tppc.info
// - Maintains a cookie jar
// - Logs in
// - Sends PMs (new PM -> extract securitytoken -> insertpm)
//
// Env (recommended):
//   FORUM_BASE_URL=https://forums.tppc.info
//   FORUM_BOT_USERNAME=YourBotAccount
//   FORUM_BOT_PASSWORD=YourBotPassword
//   FORUM_BOT_BCC=Piggachew   (optional)
//   FORUM_DEBUG=1             (optional, logs extra)
//
// Notes:
// - We try multiple ways to read Set-Cookie for compatibility with different fetch impls.

import crypto from "crypto";

function dbg(...args) {
  if (String(process.env.FORUM_DEBUG || "").trim()) console.log("[FORUM]", ...args);
}

function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not available. Use Node 18+ (or add a fetch polyfill).");
  }
}

function md5Hex(s) {
  return crypto.createHash("md5").update(String(s), "utf8").digest("hex");
}

function parseSecurityToken(html) {
  const m = /securitytoken[^>]*value="([\w\-]+)"/i.exec(String(html || ""));
  return m?.[1] || null;
}

function stripTagsToText(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

function isUserNotFound(html) {
  const t = stripTagsToText(html);
  return t.includes("The following users were not found:");
}

function getSetCookiesFromResponse(res) {
  // undici (Node 20+) supports headers.getSetCookie()
  try {
    if (typeof res?.headers?.getSetCookie === "function") {
      return res.headers.getSetCookie() || [];
    }
  } catch {}

  // node-fetch style headers.raw()
  try {
    if (typeof res?.headers?.raw === "function") {
      const raw = res.headers.raw();
      const sc = raw?.["set-cookie"];
      if (Array.isArray(sc)) return sc;
    }
  } catch {}

  // fallback: single combined set-cookie (not always reliable)
  try {
    const single = res?.headers?.get?.("set-cookie");
    if (single) return [single];
  } catch {}

  return [];
}

function parseCookiePair(setCookieLine) {
  // "name=value; Path=/; HttpOnly" -> ["name","value"]
  const first = String(setCookieLine || "").split(";")[0];
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return [name, value];
}

export class ForumClient {
  constructor({
    baseUrl = process.env.FORUM_BASE_URL || "https://forums.tppc.info",
    username = process.env.FORUM_BOT_USERNAME,
    password = process.env.FORUM_BOT_PASSWORD,
    bcc = process.env.FORUM_BOT_BCC || "",
    timeoutMs = 30_000,
  } = {}) {
    ensureFetch();

    if (!username || !password) {
      throw new Error("ForumClient missing credentials (FORUM_BOT_USERNAME / FORUM_BOT_PASSWORD).");
    }

    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.bcc = bcc;
    this.timeoutMs = timeoutMs;

    this.cookies = new Map(); // name -> value
    this.loggedIn = false;
    this._lastLoginAtMs = 0;
  }

  _cookieHeader() {
    if (!this.cookies.size) return "";
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  _updateCookies(res) {
    const setCookies = getSetCookiesFromResponse(res);
    for (const sc of setCookies) {
      const pair = parseCookiePair(sc);
      if (!pair) continue;
      const [name, value] = pair;
      this.cookies.set(name, value);
    }
    if (setCookies.length) dbg("cookies updated:", setCookies.map((s) => s.split(";")[0]));
  }

  async _fetch(pathOrUrl, { method = "GET", headers = {}, body = null } = {}) {
    const url = String(pathOrUrl).startsWith("http")
      ? String(pathOrUrl)
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const cookie = this._cookieHeader();
      const res = await fetch(url, {
        method,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; SpectreonBot/1.0; +https://forums.tppc.info/)",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body,
        redirect: "manual", // we want 302s sometimes
        signal: controller.signal,
      });

      this._updateCookies(res);
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  async login({ force = false } = {}) {
    // Avoid re-logins too often unless forced.
    const now = Date.now();
    if (!force && this.loggedIn && now - this._lastLoginAtMs < 10 * 60_000) return true;

    // 1) GET login page to pick up cookies + token
    const loginPage = await this._fetch("/login.php", { method: "GET" });
    const loginHtml = await loginPage.text();
    const securitytoken = parseSecurityToken(loginHtml) || "guest";

    // 2) POST login
    //
    // vBulletin commonly uses:
    // - vb_login_username
    // - vb_login_md5password
    // - vb_login_md5password_utf
    // - do=login
    //
    // Some installs also accept vb_login_password (plaintext). We include both.
    const form = new URLSearchParams();
    form.set("do", "login");
    form.set("vb_login_username", this.username);
    form.set("vb_login_password", this.password);
    form.set("vb_login_md5password", md5Hex(this.password));
    form.set("vb_login_md5password_utf", md5Hex(this.password));
    form.set("securitytoken", securitytoken);

    const res = await this._fetch("/login.php?do=login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    // vBulletin often returns 302 on success
    const ok = res.status === 302 || res.status === 200;
    if (!ok) {
      this.loggedIn = false;
      throw new Error(`Forum login failed (HTTP ${res.status}).`);
    }

    // Heuristic: if response body contains "You have entered an invalid username or password"
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    if (bodyText && /invalid username|invalid password|log in again/i.test(bodyText)) {
      this.loggedIn = false;
      throw new Error("Forum login rejected (invalid username/password).");
    }

    this.loggedIn = true;
    this._lastLoginAtMs = Date.now();
    dbg("login ok (status)", res.status);
    return true;
  }

  async sendVerificationPm({ forumUsername, discordTag, token }) {
    if (!forumUsername) throw new Error("sendVerificationPm missing forumUsername");
    if (!token) throw new Error("sendVerificationPm missing token");

    try {
      await this.login();
    } catch (err) {
      return { ok: false, error: err?.message || "Forum login failed." };
    }

    let securitytoken = null;
    try {
      // GET new PM page
      const newPm = await this._fetch("/private.php?do=newpm", { method: "GET" });
      const html = await newPm.text();
      securitytoken = parseSecurityToken(html);
    } catch (err) {
      return { ok: false, error: err?.message || "Forum PM fetch failed." };
    }
    if (!securitytoken) return { ok: false, error: "Could not extract securitytoken for PM form." };

    // POST insert PM
    const payload = new URLSearchParams();
    payload.set("recipients", String(forumUsername));
    if (this.bcc) payload.set("bccrecipients", String(this.bcc));
    payload.set("title", "[Automated] Discord Verification Code");
    payload.set(
      "message",
      "Your Discord verification code is:\r\n\r\n" +
        `${token}\r\n\r\n` +
        "Please respond with this code on Discord to authenticate this account.\r\n\r\n" +
        (discordTag ? `Request submitted by Discord username: ${discordTag}` : "")
    );
    payload.set("wysiwyg", "0");
    payload.set("s", "");
    payload.set("securitytoken", securitytoken);
    payload.set("do", "insertpm");
    payload.set("pmid", "");
    payload.set("forward", "");
    payload.set("sbutton", "Submit+Message");
    payload.set("savecopy", "0");
    payload.set("parseurl", "1");

    let res;
    try {
      res = await this._fetch("/private.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
      });
    } catch (err) {
      return { ok: false, error: err?.message || "Forum PM send failed." };
    }

    if (res.status === 302) return { ok: true };

    const text = await res.text().catch(() => "");
    if (res.status === 200 && isUserNotFound(text)) {
      return { ok: false, error: "The username could not be found." };
    }

    return { ok: false, error: `PM send failed (HTTP ${res.status}).` };
  }
}
