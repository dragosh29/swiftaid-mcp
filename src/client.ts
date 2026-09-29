// Minimal Swiftaid API client used by the MCP tools.
// Docs: https://developers.swiftaid.co.uk (Getting Started > Authentication, Reference, Go to production)
// Spec: https://static.swiftaid.co.uk/apis/openapi/external/v1/api.yaml (OpenAPI 3.0.3, "Swiftaid API" 1.3.1)
import { AsyncLocalStorage } from "node:async_hooks";
import { redactContacts } from "./format.js";

export class SwiftaidError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) {
    super(message);
    this.name = "SwiftaidError";
  }
}

// Spec `servers`. The Getting Started guide's token request uses the API address as the `audience`.
export const ENVIRONMENTS = {
  sandbox: "https://sandbox.swiftaid.co.uk/integrations/v1",
  production: "https://api.swiftaid.co.uk/integrations/v1",
} as const;
export type Environment = keyof typeof ENVIRONMENTS;
// Spec components.securitySchemes.oAuth.flows.clientCredentials.tokenUrl.
export const TOKEN_URL = "https://auth.streeva.com/oauth2/token";

// Swiftaid documents no rate limit and no 429 anywhere. A 429 is still retried, for any method, on the
// assumption that a rate-limited request was not processed (both POST endpoints used here also report
// a repeated id as "duplicate" rather than filing it twice). A 502/503/504 from a gateway does not
// prove the upstream did not process the request, so those are only retried for GET and for the token
// request (fetching a token has no side effect): a POST /donations or POST /declarations is never
// repeated after a gateway error.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After, per request: a longer Retry-After makes the request
// give up at once with the wait time in the message. With at most two waits, one request spends at most
// about 20 s waiting. A tool call can make several requests (a token request, get_donor's lookup and
// authorisation, list_charity_claims' report fan-out), so the cap alone does not keep a call under the
// MCP SDK's default 60 s request timeout (DEFAULT_REQUEST_TIMEOUT_MSEC); the per-call budget below does.
export const MAX_RETRY_AFTER_S = 10;
// Every tool call runs with a time budget (index.ts, withBudget). A retry whose wait would end after the
// budget is not attempted: the request fails at once saying so. 45 s leaves room for the last request
// under the 60 s default timeout.
export const DEFAULT_CALL_BUDGET_S = 45;
const callDeadline = new AsyncLocalStorage<number>();
/** Run fn with a deadline of budgetMs from now; retry waits in any request it makes respect it. */
export function withBudget<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  return callDeadline.run(Date.now() + budgetMs, fn);
}
// Refresh the cached token this long before expires_in runs out (the guide's example is 86400 s), or
// after half its lifetime when it lives less than two minutes.
const TOKEN_REFRESH_MARGIN_S = 60;

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The OAuth scope the spec lists for the operation, named in a 403 message. */
  scope?: string;
}

export interface ClientOptions {
  clientId: string;
  clientSecret: string;
  environment: Environment;
  scopes: string[];
  /** Overrides the API address (tests); the token audience stays the documented address for `environment`. */
  baseUrl?: string;
  /** Overrides the token endpoint (tests). */
  tokenUrl?: string;
}

export class SwiftaidClient {
  readonly baseUrl: string;
  readonly audience: string;
  readonly tokenUrl: string;
  readonly scopes: string[];
  readonly environment: Environment;
  private readonly clientBasic: string;
  private readonly clientSecret: string;
  // Swiftaid does not document a rate limit. Space requests 250 ms apart (about four per second) so a
  // tool call that fans out (claim totals) stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;
  private token?: { value: string; expiresAt: number };
  private tokenRequest?: Promise<string>;

  constructor(opts: ClientOptions) {
    this.environment = opts.environment;
    this.audience = ENVIRONMENTS[opts.environment];
    this.baseUrl = (opts.baseUrl || this.audience).replace(/\/+$/, "");
    this.tokenUrl = opts.tokenUrl || TOKEN_URL;
    this.scopes = opts.scopes;
    this.clientSecret = opts.clientSecret;
    // Getting Started > Request Token: "The Streeva auth service expects client authentication using
    // the HTTP Basic auth header ... Authorization: Basic b64encode(client_id:client_secret)".
    this.clientBasic = "Basic " + Buffer.from(`${opts.clientId}:${opts.clientSecret}`, "utf8").toString("base64");
  }

  /**
   * Replace the client secret, the cached access token and the encoded Basic credentials in text that is
   * passed on, should Swiftaid ever echo them. Exact values only, whatever their length: a very short
   * secret would also blank out the same letters inside ordinary words, which is the lesser harm.
   */
  private scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    let out = text;
    // Longest first, so a secret contained in another value does not break up the longer one.
    const secrets = [this.clientSecret, this.token?.value, this.clientBasic.slice(6)].filter((x): x is string => !!x).sort((a, b) => b.length - a.length);
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  }

  private clean(text: string | undefined): string | undefined {
    return redactContacts(this.scrub(text), false);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /**
   * One HTTP exchange with throttling and the 429 / gateway retry policy; no auth handling. `label` names
   * the request in messages ("GET /charities/SA12345", API-relative like every other message).
   */
  private async send(method: string, url: URL, init: { headers: Record<string, string>; body?: string; gatewayRetry: boolean; label: string }): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    const shown = init.label;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new SwiftaidError(`Could not reach ${url.origin}: ${(err as Error).message}. Check the network${url.href.startsWith(this.tokenUrl) ? " and SWIFTAID_TOKEN_URL" : " and SWIFTAID_ENV / SWIFTAID_BASE_URL"}.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (init.gatewayRetry && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new SwiftaidError(`Swiftaid asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${shown} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        const deadline = callDeadline.getStore();
        if (deadline !== undefined && Date.now() + delay > deadline) {
          throw new SwiftaidError(`Swiftaid answered ${shown} with HTTP ${res.status}, and waiting ${Math.ceil(delay / 1000)} more seconds to retry would take this tool call past its time budget (an MCP client gives up after 60 seconds by default). Try again in a minute.`, res.status);
        }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, headers: res.headers, text, json: text ? safeJson(text) : undefined };
    }
  }

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => {
        this.tokenRequest = undefined;
      });
    }
    return this.tokenRequest;
  }

  /**
   * Getting Started > Request Token: POST the token URL with HTTP Basic client authentication and a
   * form-encoded body grant_type=client_credentials, audience=<API address>, scope=<space-separated
   * scopes>. The answer { access_token, token_type: "Bearer", expires_in } is cached in memory and
   * refreshed a minute before expiry, and fetched afresh once when an API call answers 401. The token
   * and the client secret are never logged, and are scrubbed from any error message that echoes them.
   */
  private async requestToken(): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", audience: this.audience, scope: this.scopes.join(" ") });
    const { status, json, text } = await this.send("POST", new URL(this.tokenUrl), {
      headers: { Authorization: this.clientBasic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      gatewayRetry: true,
      label: "the token request",
    });
    const record = json && typeof json === "object" && !Array.isArray(json) ? json : undefined;
    if (status === 200 && record && typeof record.access_token === "string" && record.access_token) {
      const expiresIn = Number(record.expires_in);
      const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
      const margin = Math.min(TOKEN_REFRESH_MARGIN_S, ttl / 2);
      this.token = { value: record.access_token, expiresAt: Date.now() + (ttl - margin) * 1000 };
      return record.access_token;
    }
    // Swiftaid does not document the token endpoint's errors; OAuth 2.0 (RFC 6749 section 5.2) says
    // { error, error_description }. Only a JSON error is passed on, never a raw body.
    const code = typeof record?.error === "string" ? record.error : undefined;
    const detail = this.clean([code, typeof record?.error_description === "string" ? record.error_description : undefined].filter(Boolean).join(": ") || undefined);
    const suffix = detail ? ` ${detail}` : "";
    this.token = undefined;
    const where = "Swiftaid issues client credentials on request (dev@swiftaid.co.uk for sandbox; the engineering team for production)";
    if (status === 400 && code === "invalid_scope") {
      throw new SwiftaidError(`The Swiftaid auth service refused the requested scopes (400 invalid_scope): ${this.scopes.join(" ")}. Your client may not be granted all of them; set SWIFTAID_SCOPE to the scopes it has.${suffix}`, status, code);
    }
    if (status === 400 || status === 401) {
      throw new SwiftaidError(`The Swiftaid auth service rejected the client credentials (${status}). Check SWIFTAID_CLIENT_ID and SWIFTAID_CLIENT_SECRET, and that they are for the ${this.environment} environment (SWIFTAID_ENV). ${where}.${suffix}`, status, code);
    }
    if (status === 403) {
      throw new SwiftaidError(`The Swiftaid auth service refused to issue a token (403) for audience ${this.audience}. Check that your client is enabled for the ${this.environment} environment (SWIFTAID_ENV).${suffix}`, status, code);
    }
    if (status === 200) {
      // Say what shape came back without echoing any value.
      const shape = record ? `JSON with keys ${Object.keys(record).join(", ") || "(none)"}` : `a non-JSON body starting with ${JSON.stringify((this.clean(text) ?? "").slice(0, 60))}`;
      throw new SwiftaidError(`The Swiftaid auth service answered 200 but with no access_token (${shape}). Check SWIFTAID_TOKEN_URL.`, status);
    }
    if (status === 429) throw new SwiftaidError(`The Swiftaid auth service rate-limited the token request (429). Wait a minute and try again.${suffix}`, status, code);
    if (RETRY_GET_ONLY.has(status)) throw new SwiftaidError(`The Swiftaid auth service returned ${status} ${MAX_ATTEMPTS} times in a row. It may be unavailable; try again in a few minutes.`, status);
    throw new SwiftaidError(`The Swiftaid auth service returned ${status} for the token request.${suffix}`, status, code);
  }

  /** Check the token endpoint accepts the credentials; returns nothing secret. */
  async checkCredentials(): Promise<void> {
    await this.getToken(true);
  }

  /** GET /healthcheck. The spec lists no security requirement for it, so no token is sent. */
  async healthcheck(): Promise<{ status: number; body?: string }> {
    const { status, text, json } = await this.send("GET", new URL(this.baseUrl + "/healthcheck"), { headers: { Accept: "application/json" }, gatewayRetry: true, label: "GET /healthcheck" });
    if (status >= 200 && status < 300) {
      // The spec documents a 200 with no body schema; whatever comes back is summarised, not trusted.
      const body = json !== undefined ? JSON.stringify(json) : text;
      return { status, body: body ? this.clean(body)?.slice(0, 200) : undefined };
    }
    if (RETRY_GET_ONLY.has(status)) throw new SwiftaidError(`Swiftaid returned ${status} for GET /healthcheck ${MAX_ATTEMPTS} times in a row. The service may be unavailable (see https://status.swiftaid.co.uk); try again in a few minutes.`, status);
    throw new SwiftaidError(`Swiftaid returned ${status} for GET /healthcheck at ${this.baseUrl}. Check SWIFTAID_ENV / SWIFTAID_BASE_URL.`, status);
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    for (let auth = 0; ; auth++) {
      const token = await this.getToken(auth > 0);
      const { status, text, json } = await this.send(method, url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        gatewayRetry: method === "GET",
        label: `${method} ${path}`,
      });
      // A cached token may have been revoked or expired early: fetch a fresh one and retry once.
      if (status === 401 && auth === 0) continue;

      if (status >= 200 && status < 300) {
        // Every documented 2xx body used here is JSON (an object or an array). A 200 with HTML (a
        // proxy, a captive portal, a login page) must not be mistaken for an empty result.
        if (json === undefined || json === null || typeof json !== "object") {
          throw new SwiftaidError(
            `Swiftaid returned ${status} for ${method} ${path} but the body was not JSON (starts with: ${JSON.stringify((this.clean(text) ?? "").slice(0, 60))}). Check SWIFTAID_ENV / SWIFTAID_BASE_URL and whether a proxy or login page is in the way.`,
            status,
          );
        }
        return json as T;
      }

      // Spec ProblemDetails { type, title, status, detail, errors[] } (RFC 9457) on the detailed 400,
      // 403, 404 and 409 responses; the other documented errors have no body. Free text is redacted.
      const detail = this.clean(describeProblem(json) ?? (json === undefined && text && !/^\s*</.test(text) ? text : undefined))?.slice(0, 300);
      const suffix = detail ? ` ${detail}` : "";
      if (status === 401) {
        throw new SwiftaidError(
          `Swiftaid rejected the access token (401) for ${method} ${path}, even after fetching a fresh one. Check that SWIFTAID_ENV (${this.environment}, audience ${this.audience}) matches the environment your client credentials were issued for.${suffix}`,
          401,
        );
      }
      if (status === 403) {
        const scope = opts.scope ? ` This operation needs the \`${opts.scope}\` scope: ask Swiftaid to grant it to your client, and include it in SWIFTAID_SCOPE if you set that.` : "";
        throw new SwiftaidError(`Swiftaid refused ${method} ${path} (403).${scope}${suffix}`, 403);
      }
      if (status === 404) throw new SwiftaidError(`Not found: ${path}. Check the ID; Swiftaid has no such record for your client.${suffix}`, 404);
      if (status === 409) throw new SwiftaidError(`Swiftaid reported a conflict for ${method} ${path} (409).${suffix}`, 409);
      if (status === 400) throw new SwiftaidError(`Swiftaid refused ${method} ${path} (400).${suffix}`, 400);
      if (status === 429) throw new SwiftaidError("Swiftaid rate limit reached (the limit is not documented). Wait a minute and try again.", 429);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new SwiftaidError(
          `Swiftaid returned ${status} for ${method} ${path}. The request was not retried because it may already have been processed: send it again with the same ids, and Swiftaid will report any it already holds as "duplicate".${suffix}`,
          status,
        );
      }
      if (RETRY_GET_ONLY.has(status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a
        // JSON problem description is passed on.
        const jsonDetail = this.clean(describeProblem(json));
        throw new SwiftaidError(`Swiftaid returned ${status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable (see https://status.swiftaid.co.uk); try again in a few minutes.${jsonDetail ? " " + jsonDetail : ""}`, status);
      }
      throw new SwiftaidError(`Swiftaid returned ${status} for ${method} ${path}.${suffix}`, status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>, scope?: string) {
    return this.request<T>("GET", path, { query, scope });
  }

  post<T = any>(path: string, body: unknown, scope?: string) {
    return this.request<T>("POST", path, { body, scope });
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ProblemDetails: title and detail, then every entry in errors.
function describeProblem(json: any): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const head = [json.title, json.detail].filter((x) => typeof x === "string" && x.trim()).join(": ");
  const errors = Array.isArray(json.errors) ? json.errors.filter((e: unknown) => typeof e === "string" && e.trim()) : [];
  const tail = errors.length ? `Errors: ${errors.join(" | ")}` : "";
  const parts = head && tail ? `${head}${/[.!?]$/.test(head) ? "" : "."} ${tail}` : head || tail;
  return parts || undefined;
}
