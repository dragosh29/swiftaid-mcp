// Local stand-in for the Swiftaid sandbox (https://sandbox.swiftaid.co.uk/integrations/v1) and the
// Streeva auth service's token endpoint (https://auth.streeva.com/oauth2/token), serving the fixtures.
// The scope each operation needs is read from the spec's `security` blocks, not written by hand.
import http from "node:http";
import * as fx from "./fixtures.mjs";

// Obviously fake, low-entropy credentials. Never the example values printed in Swiftaid's docs:
// secret scanners flag those in a public repository. The Basic header is computed here, at runtime.
export const CLIENT_ID = "swiftaid-test-client-not-real";
export const CLIENT_SECRET = "swiftaid-test-secret-not-real";
export const basicFor = (id, secret) => "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
export const CLIENT_BASIC = basicFor(CLIENT_ID, CLIENT_SECRET);
export const SANDBOX = "https://sandbox.swiftaid.co.uk/integrations/v1";
export const PRODUCTION = "https://api.swiftaid.co.uk/integrations/v1";
export const PREFIX = "/integrations/v1";
export const TOKEN_PATH = "/oauth2/token";
// The scopes the mock's "client" has been granted: the read and create scopes this server uses.
export const CLIENT_SCOPES = ["read:charity", "read:claim", "read:donor", "read:declaration", "create:declaration", "create:donation"];
// The spec's BadRequestDetailed example, served verbatim.
export const BAD_REQUEST_DETAILED = { status: 400, type: "https://www.rfc-editor.org/rfc/rfc9110.html#name-400-bad-request", title: "Bad Request", detail: "Invalid json in request." };

const HMRC_ID = /^(?:X|[A-Z]{2})\d{1,5}$/;

export function startMock(spec) {
  const requests = [];
  const tokens = new Map(); // token -> { scopes, audience }
  const everIssued = new Set();
  let issued = 0;
  // expires_in of issued tokens: 86400 as in the Getting Started example. Lowered by one check to prove
  // the client refreshes a token before it expires.
  let tokenTtl = 86400;
  // Operations from the spec: method, path regex and the scope in its security block.
  const operations = Object.entries(spec.paths).flatMap(([p, ops]) =>
    Object.entries(ops)
      .filter(([m]) => ["get", "post", "patch", "delete", "put"].includes(m))
      .map(([m, op]) => ({ method: m.toUpperCase(), template: p, re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$"), scope: op.security?.[0]?.oAuth?.[0] })),
  );
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes
  // one "time" and gets that status instead of the normal answer (body undefined = an HTML gateway
  // page). The suite starts with a single 429 on the SA12345 claims list so the retry path is
  // exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: `/charities/${fx.WARRANTED}/claims`, status: 429, times: 1, headers: { "Retry-After": "1" }, body: undefined, json: false });
  let failures = [failure429()];
  const declarationIds = new Set(fx.existingDeclarationIds);
  const donationIds = new Set(fx.existingDonationIds);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const contentType = req.headers["content-type"] ?? "";
    let body;
    if (raw) body = /^application\/x-www-form-urlencoded/.test(contentType) ? Object.fromEntries(new URLSearchParams(raw)) : /^application\/json/.test(contentType) ? safeJson(raw) : raw;
    requests.push({ method: req.method, path, fullPath: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, contentType, body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { ...(json === undefined ? {} : { "Content-Type": "application/json" }), ...headers });
      return res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(failure.text ?? `<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, failure.headers ?? {});
    }

    // ---- Token endpoint (Getting Started > Request Token): HTTP Basic client authentication, form body
    // grant_type=client_credentials, audience, scope. The error bodies are OAuth 2.0's (RFC 6749 5.2);
    // Swiftaid does not document them.
    if (path === TOKEN_PATH) {
      if (req.method !== "POST") return send(405, undefined);
      if (!/^application\/x-www-form-urlencoded/.test(contentType)) return send(400, { error: "invalid_request", error_description: "Expected a form-encoded body." });
      if (req.headers.authorization !== CLIENT_BASIC) return send(401, { error: "invalid_client", error_description: "Client authentication failed." });
      if (body?.grant_type !== "client_credentials") return send(400, { error: "unsupported_grant_type" });
      if (![SANDBOX, PRODUCTION].includes(body?.audience)) return send(403, { error: "access_denied", error_description: "Unknown audience." });
      const requested = String(body?.scope ?? "").split(" ").filter(Boolean);
      const unknown = requested.filter((s) => !CLIENT_SCOPES.includes(s));
      if (unknown.length) return send(400, { error: "invalid_scope", error_description: `Scope not granted to this client: ${unknown.join(" ")}` });
      const token = `sa-test-token-${++issued}`;
      tokens.set(token, { scopes: requested, audience: body.audience });
      everIssued.add(token);
      // The documented response keys, nothing else.
      return send(200, { access_token: token, token_type: "Bearer", expires_in: tokenTtl });
    }

    const op = operations.find((o) => o.method === req.method && o.re.test(path));
    if (!op) return send(404, undefined);

    // GET /healthcheck carries no security requirement in the spec. The spec documents a 200 without a body.
    if (op.template === "/healthcheck") return send(200, undefined);

    // The documented Unauthorized / Forbidden / NotFound / BadRequest responses for the GET operations
    // have no content, so the mock answers them with an empty body.
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const tok = bearer ? tokens.get(bearer) : undefined;
    // This mock is the sandbox: a token issued for the production audience is not accepted.
    if (!tok || tok.audience !== SANDBOX) return send(401, undefined);
    if (op.scope && !tok.scopes.includes(op.scope)) return send(403, undefined);

    const p = path.split("/").filter(Boolean);
    if (req.method === "GET") {
      if (op.template === "/charities/{hmrcCustomerId}") {
        if (!HMRC_ID.test(p[1])) return send(400, undefined);
        // The spec documents no 404 for this operation; the mock's 404 for an unknown charity is an assumption.
        return fx.charities[p[1]] ? send(200, fx.charities[p[1]]) : send(404, undefined);
      }
      if (op.template === "/charities/{hmrcCustomerId}/claims") {
        if (!HMRC_ID.test(p[1])) return send(400, undefined);
        return fx.claims[p[1]] ? send(200, fx.claims[p[1]]) : send(404, undefined);
      }
      if (op.template === "/charities/{hmrcCustomerId}/claims/{claimId}") {
        const list = fx.claims[p[1]];
        const report = list?.some((c) => c.id === p[3]) ? fx.claimReports[p[3]] : undefined;
        return report ? send(200, report) : send(404, undefined);
      }
      if (op.template === "/donations/{donationId}/declaration") {
        const d = fx.declarations[decodeURIComponent(p[1])];
        return d ? send(200, d) : send(404, undefined);
      }
      if (op.template === "/donors/") {
        const type = url.searchParams.get("type");
        const value = url.searchParams.get("value");
        if (!["email", "phoneNumber"].includes(type) || !value) return send(400, undefined);
        const hit = fx.donorLookups[`${type}:${value}`];
        return hit ? send(200, hit) : send(404, undefined);
      }
      if (op.template === "/donors/{donorId}/authorisation") {
        const a = fx.authorisations[p[1]];
        return a ? send(200, a) : send(404, undefined);
      }
    }
    if (req.method === "POST" && op.template === "/declarations") {
      // Spec: 200 BatchDeclarationResponse; 400 BadRequestDetailed. A repeated id is answered as in the
      // spec's example: accepted false, info "duplicate".
      if (!Array.isArray(body)) return send(400, BAD_REQUEST_DETAILED);
      return send(
        200,
        body.map((d) => {
          if (declarationIds.has(d.id)) return { declarationId: d.id, accepted: false, info: "duplicate" };
          declarationIds.add(d.id);
          return { declarationId: d.id, accepted: true, info: "" };
        }),
      );
    }
    if (req.method === "POST" && op.template === "/donations") {
      // Spec: 200 DonationsResponse; 400 BadRequest (no body documented).
      if (!Array.isArray(body)) return send(400, undefined);
      return send(
        200,
        body.map((d) => {
          if (donationIds.has(d.donationId)) return { donationId: d.donationId, accepted: false, info: "duplicate" };
          donationIds.add(d.donationId);
          return { donationId: d.donationId, accepted: true, info: "" };
        }),
      );
    }
    return send(404, undefined);
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON page). */
  const arm = ({ method, path, status, times = 1, headers, body, text }) => {
    failures.push({ method, path, status, times, headers, body, text });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Forget every issued token, as if they had been revoked; the next API call answers 401. */
  const revokeTokens = () => tokens.clear();
  const setTokenTtl = (s) => {
    tokenTtl = s;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, revokeTokens, setTokenTtl, everIssued, operations })),
  );
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
