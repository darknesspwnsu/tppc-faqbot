// rpg/rpg_client.js
//
// Lightweight client for TPPC RPG pages.
// Logs in and reuses cookies for scraping leaderboards.

import { logger } from "../shared/logger.js";

function ensureFetch() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not available. Use Node 18+ or add a fetch polyfill.");
  }
}

function parseCookiePair(setCookieLine) {
  const first = String(setCookieLine || "").split(";")[0];
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return [name, value];
}

function getSetCookiesFromResponse(res) {
  try {
    if (typeof res?.headers?.getSetCookie === "function") {
      return res.headers.getSetCookie() || [];
    }
  } catch {}

  try {
    if (typeof res?.headers?.raw === "function") {
      const raw = res.headers.raw();
      const sc = raw?.["set-cookie"];
      if (Array.isArray(sc)) return sc;
    }
  } catch {}

  try {
    const single = res?.headers?.get?.("set-cookie");
    if (single) return [single];
  } catch {}

  return [];
}

export class RpgClient {
  constructor({
    baseUrl = "https://www.tppcrpg.net",
    username = process.env.RPG_USERNAME,
    password = process.env.RPG_PASSWORD,
    timeoutMs = 30_000,
  } = {}) {
    ensureFetch();

    if (!username || !password) {
      throw new Error("RpgClient missing credentials (RPG_USERNAME / RPG_PASSWORD).");
    }

    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.username = username;
    this.password = password;
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
            "Mozilla/5.0 (compatible; SpectreonBot/1.0; +https://www.tppcrpg.net/)",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      this._updateCookies(res);
      return res;
    } catch (err) {
      logger.error("rpg.fetch.error", {
        url,
        method,
        error: logger.serializeError(err),
      });
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async login({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.loggedIn && now - this._lastLoginAtMs < 10 * 60_000) return true;

    const form = new URLSearchParams();
    form.set("LoginID", this.username);
    form.set("NewPass", this.password);

    const res = await this._fetch("/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const ok = res.status === 200 || res.status === 302;
    if (!ok) {
      this.loggedIn = false;
      logger.error("rpg.login.error", {
        status: res.status,
      });
      throw new Error(`RPG login failed (HTTP ${res.status}).`);
    }

    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    if (bodyText && !bodyText.includes("Logout")) {
      this.loggedIn = false;
      logger.error("rpg.login.error", {
        status: res.status,
        reason: "invalid-credentials",
      });
      throw new Error("RPG login rejected (invalid username/password).");
    }

    this.loggedIn = true;
    this._lastLoginAtMs = Date.now();
    return true;
  }

  async fetchPage(pathOrUrl) {
    await this.login();
    const res = await this._fetch(pathOrUrl, { method: "GET" });
    if (res.ok) return await res.text();

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.("location");
      if (location && /login\.php/i.test(location)) {
        await this.login({ force: true });
        const retry = await this._fetch(pathOrUrl, { method: "GET" });
        if (!retry.ok) {
          logger.error("rpg.fetch.error", {
            status: retry.status,
            reason: "retry-failed",
            url: String(pathOrUrl),
          });
          throw new Error(`RPG fetch failed (HTTP ${retry.status}).`);
        }
        return await retry.text();
      }

      if (location) {
        const next = await this._fetch(location, { method: "GET" });
        if (!next.ok) {
          logger.error("rpg.fetch.error", {
            status: next.status,
            reason: "redirect-failed",
            url: String(pathOrUrl),
          });
          throw new Error(`RPG fetch failed (HTTP ${next.status}).`);
        }
        return await next.text();
      }
    }

    logger.error("rpg.fetch.error", {
      status: res.status,
      reason: "http-error",
      url: String(pathOrUrl),
    });
    throw new Error(`RPG fetch failed (HTTP ${res.status}).`);
  }

  async fetchForm(pathOrUrl, form) {
    await this.login();
    const body = typeof form === "string" ? form : form?.toString?.() ?? "";
    const res = await this._fetch(pathOrUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.ok) return await res.text();

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.get?.("location");
      if (location && /login\.php/i.test(location)) {
        await this.login({ force: true });
        const retry = await this._fetch(pathOrUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!retry.ok) {
          logger.error("rpg.fetch.error", {
            status: retry.status,
            reason: "retry-failed",
            url: String(pathOrUrl),
          });
          throw new Error(`RPG fetch failed (HTTP ${retry.status}).`);
        }
        return await retry.text();
      }

      if (location) {
        const next = await this._fetch(location, { method: "GET" });
        if (!next.ok) {
          logger.error("rpg.fetch.error", {
            status: next.status,
            reason: "redirect-failed",
            url: String(pathOrUrl),
          });
          throw new Error(`RPG fetch failed (HTTP ${next.status}).`);
        }
        return await next.text();
      }
    }

    logger.error("rpg.fetch.error", {
      status: res.status,
      reason: "http-error",
      url: String(pathOrUrl),
    });
    throw new Error(`RPG fetch failed (HTTP ${res.status}).`);
  }
}

export const __testables = { parseCookiePair, getSetCookiesFromResponse };
