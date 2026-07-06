import { randomUUID } from "node:crypto";
import { CliError } from "./types";
import { loadConfig, patchInstance } from "./config";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SessionLoginOpts {
  baseUrl: string;
  email: string;
  password: string;
  browserId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Logs in against the internal /rest/login endpoint and returns the
 * "n8n-auth=..." cookie pair. n8n rate-limits this endpoint (HTTP 429), so
 * callers must persist and reuse the cookie instead of logging in per request.
 */
export async function performSessionLogin(
  opts: SessionLoginOpts,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await fetchImpl(
      `${opts.baseUrl.replace(/\/+$/, "")}/rest/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "browser-id": opts.browserId,
        },
        body: JSON.stringify({
          emailOrLdapLoginId: opts.email,
          password: opts.password,
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    clearTimeout(timer);
    throw new CliError(
      "network-error",
      `n8n session login failed: ${(err as Error).message}`,
    );
  }
  clearTimeout(timer);
  if (!response.ok) {
    const code =
      response.status === 401
        ? "unauthorized"
        : response.status === 429
          ? "rate-limited"
          : "n8n-error";
    throw new CliError(
      code,
      `n8n session login failed (HTTP ${response.status}). Check the n8n email and password.`,
    );
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const authCookie = setCookies
    .map((entry) => entry.split(";")[0])
    .find((entry) => entry.startsWith("n8n-auth="));
  if (!authCookie) {
    throw new CliError(
      "n8n-error",
      "n8n session login succeeded but returned no n8n-auth cookie.",
    );
  }
  return authCookie;
}

/**
 * Resolves the session cookie for an instance: the persisted cookie when one
 * exists, otherwise a fresh login with the saved email/password. Refreshed
 * cookies are written back to the config so later runs reuse the session.
 */
export class SessionManager {
  private cookie: string | null | undefined;
  private loginInFlight: Promise<string> | null = null;

  constructor(
    private readonly host: string,
    private readonly baseUrl: string,
    private readonly fetchImpl?: FetchLike,
  ) {}

  private stored() {
    return loadConfig().instances[this.host];
  }

  hasCredentials(): boolean {
    const stored = this.stored();
    return Boolean(stored?.email && stored.password);
  }

  /** The persisted browser-id bound to the session, if a login has happened. */
  getBrowserId(): string | undefined {
    return this.stored()?.browserId;
  }

  /** Saved cookie, or a fresh one when email/password are saved; null otherwise. */
  async getCookie(): Promise<string | null> {
    if (this.cookie !== undefined) return this.cookie;
    const stored = this.stored();
    if (stored?.sessionCookie) {
      this.cookie = stored.sessionCookie;
      return this.cookie;
    }
    if (!stored?.email || !stored.password) {
      this.cookie = null;
      return null;
    }
    return this.login();
  }

  /** Drops the persisted cookie and logs in again. Call after a 401. */
  async refreshCookie(): Promise<string | null> {
    if (!this.hasCredentials()) return null;
    this.cookie = undefined;
    patchInstance(this.host, { sessionCookie: undefined });
    return this.login();
  }

  private login(): Promise<string> {
    // Concurrent callers share one in-flight login: /rest/login is rate-limited.
    if (!this.loginInFlight) {
      this.loginInFlight = this.performLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async performLogin(): Promise<string> {
    const stored = this.stored();
    if (!stored?.email || !stored.password) {
      throw new CliError(
        "no-credentials",
        `No saved n8n email/password for ${this.host}. Run \`n8n-helper login --url ${this.baseUrl} --email <email>\`.`,
      );
    }
    let browserId = stored.browserId;
    if (!browserId) {
      browserId = randomUUID();
      patchInstance(this.host, { browserId });
    }
    const cookie = await performSessionLogin({
      baseUrl: this.baseUrl,
      email: stored.email,
      password: stored.password,
      browserId,
      fetchImpl: this.fetchImpl,
    });
    this.cookie = cookie;
    patchInstance(this.host, { sessionCookie: cookie });
    return cookie;
  }
}
