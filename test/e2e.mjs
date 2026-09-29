// End-to-end test: fixtures are validated against Swiftaid's published OpenAPI schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API and of
// the token endpoint.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, CLIENT_ID, CLIENT_SECRET, CLIENT_BASIC, basicFor, SANDBOX, PRODUCTION, PREFIX, TOKEN_PATH, BAD_REQUEST_DETAILED } from "./mock-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://static.swiftaid.co.uk/apis/openapi/external/v1/api.yaml";
if (!existsSync(`${root}spec.yaml`)) {
  try {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(`${root}spec.yaml`, await res.text());
  } catch (err) {
    console.error(`Could not download the Swiftaid spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.yaml ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = parse(readFileSync(`${root}spec.yaml`, "utf8"));
assert.equal(spec.info.version, "1.3.1", "these tests were written against Swiftaid API 1.3.1");

// The spec's DonorIdentifier, TransactionIdentifier and Account use oneOf + discriminator, but the
// branches carry no const/enum on `type`, so a plain oneOf would match several branches (e.g. uid,
// match and declaration all accept { type, value }). Resolve them the way the discriminator says:
// `type` must be one of the mapping keys, and the object must satisfy the mapped schema.
const components = structuredClone(spec.components);
for (const schema of Object.values(components.schemas)) {
  if (schema.discriminator && schema.oneOf) {
    const { propertyName, mapping } = schema.discriminator;
    delete schema.oneOf;
    delete schema.discriminator;
    schema.type = "object";
    schema.required = [propertyName];
    schema.properties = { [propertyName]: { enum: Object.keys(mapping) } };
    schema.allOf = Object.entries(mapping).map(([k, ref]) => ({ if: { properties: { [propertyName]: { const: k } }, required: [propertyName] }, then: { $ref: ref } }));
  }
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("xml", true); // ClaimReport.filingReceipt is `format: xml`, which Ajv does not know
ajv.addSchema({ $id: "sw", components });
const compile = (schema) => (typeof schema === "string" ? ajv.getSchema(`sw#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `sw#/components/schemas/${schema}` }) : ajv.compile(schema));
const validateWith = (schema, obj, label) => {
  const v = compile(schema);
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (schemaName, obj, id = "") => validateWith(schemaName, obj, `${schemaName} ${id}`);
const responseSchema = (path, method, status = "200") => {
  const s = spec.paths[path][method].responses[status].content["application/json"].schema;
  return s.$ref ? s.$ref.split("/").pop() : { ...s, items: s.items?.$ref ? { $ref: `sw${s.items.$ref}` } : s.items };
};

console.log("fixtures vs OpenAPI spec");
await check("charities, claim lists, claim reports, declarations, donor ids and authorisations match the spec's schemas (with a negative control)", async () => {
  Object.values(fx.charities).forEach((c) => validate("CharityResponse", c));
  Object.values(fx.claims).forEach((list) => validate("ClaimIndex", list));
  Object.values(fx.claims).flat().forEach((c) => validate("ClaimSummary", c, c.id));
  Object.values(fx.claimReports).forEach((r) => validate("ClaimReport", r, r.id));
  Object.values(fx.declarations).forEach((d) => validate("GiftAidDeclaration", d, d.donationId));
  Object.values(fx.donorLookups).forEach((d) => validate("UserState", d, d.id));
  Object.values(fx.authorisations).forEach((a) => validate("Authorisation", a));
  // The schemas are loose (nothing is required on the response schemas), so check the validator does bite.
  assert.equal(compile("GiftAidDeclaration")({ status: "pending" }), false, "an undocumented status must be rejected");
  assert.equal(compile("ClaimReport")({ countDonations: "2" }), false, "a string count must be rejected");
  assert.equal(compile("GiftAidDeclaration")({ ...fx.declarations.stl_123456, donatedOn: "2018-07-17T10:02:34" }), false, "the Reference page's zone-less donatedOn fails format: date-time (see fixtures.mjs)");
  // The discriminator resolution rejects a donor identifier whose value breaks its branch.
  assert.equal(compile("DonorIdentifier")({ type: "phone", value: "not a phone" }), false);
  assert.equal(compile("DonorIdentifier")({ type: "uid" }), false);
  assert.equal(compile("DonorIdentifier")({ type: "card", value: "x" }), false);
  assert.equal(compile("DonorIdentifier")({ type: "uid", value: "dnr_0123456" }), true);
});

// 2. The mock's responses (token, records, lists, errors) match what the documentation describes.
const { server: mock, port, requests, arm, arm429, disarm, revokeTokens, setTokenTtl, everIssued, operations } = await startMock(spec);
const origin = `http://127.0.0.1:${port}`;
const base = `${origin}${PREFIX}`;
const tokenUrl = `${origin}${TOKEN_PATH}`;
await check("mock responses match the documented token, record, list, write and error shapes", async () => {
  const form = (fields) => new URLSearchParams(fields).toString();
  const tok = await fetch(tokenUrl, { method: "POST", headers: { Authorization: CLIENT_BASIC, "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "client_credentials", audience: SANDBOX, scope: "read:charity read:claim read:donor read:declaration create:declaration create:donation" }) });
  assert.equal(tok.status, 200);
  const t = await tok.json();
  assert.deepEqual(Object.keys(t).sort(), ["access_token", "expires_in", "token_type"], "the three keys the Getting Started guide documents");
  assert.equal(t.token_type, "Bearer");
  const bad = await fetch(tokenUrl, { method: "POST", headers: { Authorization: basicFor(CLIENT_ID, "wrong-secret-not-real"), "Content-Type": "application/x-www-form-urlencoded" }, body: form({ grant_type: "client_credentials", audience: SANDBOX, scope: "read:charity" }) });
  assert.equal(bad.status, 401);
  const H = { Authorization: `Bearer ${t.access_token}` };
  const get = async (path) => {
    const r = await fetch(base + path, { headers: H });
    const text = await r.text();
    return { status: r.status, text, json: text && /json/.test(r.headers.get("content-type") ?? "") ? JSON.parse(text) : undefined };
  };
  validate("CharityResponse", (await get(`/charities/${fx.WARRANTED}`)).json);
  const limited = await get(`/charities/${fx.WARRANTED}/claims`); // the mock answers the first claims call with a 429
  assert.equal(limited.status, 429);
  validateWith(responseSchema("/charities/{hmrcCustomerId}/claims", "get"), (await get(`/charities/${fx.WARRANTED}/claims`)).json, "ClaimIndex response");
  validateWith(responseSchema("/charities/{hmrcCustomerId}/claims/{claimId}", "get"), (await get(`/charities/${fx.WARRANTED}/claims/clm_123abc`)).json, "ClaimReport response");
  validateWith(responseSchema("/donations/{donationId}/declaration", "get"), (await get("/donations/stl_123456/declaration")).json, "GiftAidDeclaration response");
  validateWith(responseSchema("/donors/", "get"), (await get("/donors/?type=email&value=sam.example%40example.com")).json, "UserState response");
  validateWith(responseSchema("/donors/{donorId}/authorisation", "get"), (await get("/donors/dnr_0123456/authorisation")).json, "Authorisation response");
  // The documented NotFound / Unauthorized responses of the GET operations have no content.
  const missing = await get("/donations/stl_nope/declaration");
  assert.deepEqual([missing.status, missing.text], [404, ""]);
  const noToken = await fetch(`${base}/charities/${fx.WARRANTED}`);
  assert.deepEqual([noToken.status, await noToken.text()], [401, ""]);
  const health = await fetch(`${base}/healthcheck`);
  assert.equal(health.status, 200, "GET /healthcheck needs no token (no security block in the spec)");
  // Writes: 200 bodies validate against BatchDeclarationResponse / DonationsResponse.
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : undefined };
  };
  const decl = await post("/declarations", [{ id: "dec_123456", hmrcCustomerId: fx.WARRANTED, donor: { firstname: "Tony", lastname: "Stark", addressLine1: "14 High Street", postcode: "GU1 3RT", country: "UK" }, source: { sourceRef: "2021/cust_01234.wav" } }]);
  validateWith(responseSchema("/declarations", "post"), decl.json, "BatchDeclarationResponse");
  assert.deepEqual(decl.json, [{ declarationId: "dec_123456", accepted: false, info: "duplicate" }], "a known id is answered like the spec example's duplicate");
  const don = await post("/donations", [{ donationId: "stl_123456", donor: { type: "uid", value: "dnr_0123456" }, transaction: { type: "hmrcId", id: fx.WARRANTED }, grossAmount: 500, currency: "GBP", transactionDate: "2018-11-20T10:23:01Z" }]);
  validateWith(responseSchema("/donations", "post"), don.json, "DonationsResponse");
  // The 400 BadRequestDetailed example is served verbatim. It contradicts the spec's own ProblemDetails
  // schema in one place only: `status` is typed as a string, every example gives a number.
  const badJson = await post("/declarations", "{not json");
  assert.equal(badJson.status, 400);
  assert.deepEqual(badJson.json, spec.components.responses.BadRequestDetailed.content["application/json"].example);
  const v = compile("ProblemDetails");
  assert.equal(v(badJson.json), false);
  assert.deepEqual(v.errors.map((e) => `${e.instancePath} ${e.keyword}`), ["/status type"], "the only mismatch is status: number vs the schema's string");
  validate("ProblemDetails", { ...badJson.json, status: String(badJson.json.status) });
  assert.deepEqual(BAD_REQUEST_DETAILED, badJson.json);
});
requests.length = 0; // only count what the MCP server does from here on
arm429();

// 3. Drive the server through MCP. `writes` is the literal SWIFTAID_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ secret = CLIENT_SECRET, writes = "true", env: extra = {} } = {}) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, SWIFTAID_CLIENT_ID: CLIENT_ID, SWIFTAID_CLIENT_SECRET: secret, SWIFTAID_BASE_URL: base, SWIFTAID_TOKEN_URL: tokenUrl };
  for (const k of ["SWIFTAID_ALLOW_WRITES", "SWIFTAID_ENV", "SWIFTAID_SCOPE"]) delete env[k];
  if (writes !== null) env.SWIFTAID_ALLOW_WRITES = writes;
  Object.assign(env, extra);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const tokenCalls = (list) => list.filter((r) => r.path === TOKEN_PATH);
const READ_TOOLS = ["get_charity", "get_claim", "get_declaration", "get_donor", "healthcheck", "list_charity_claims"];
const WRITE_TOOLS = ["create_declaration", "create_donation"];

const client = await connect();
console.log("mcp tools");

await check("tools/list exposes 6 read tools with readOnlyHint and, with writes on, 2 non-destructive write tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  for (const t of tools) {
    const write = WRITE_TOOLS.includes(t.name);
    assert.equal(t.annotations?.readOnlyHint, !write, `${t.name} readOnlyHint`);
    if (write) assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
  }
});

await check("healthcheck calls GET /healthcheck without a token, then fetches one token with the documented Basic header and form body", async () => {
  const n = requests.length;
  const { data } = await call(client, "healthcheck");
  assert.equal(data.api.reachable, true);
  assert.equal(data.api.status, 200);
  assert.equal(data.credentials.accepted, true);
  assert.equal(data.credentials.audience, SANDBOX);
  assert.equal(since(n).length, 2, "one health request, one token request");
  const [health, tok] = since(n);
  assert.deepEqual([health.method, health.path, health.auth], ["GET", "/healthcheck", undefined]);
  assert.deepEqual([tok.method, tok.path], ["POST", TOKEN_PATH]);
  assert.equal(tok.auth, basicFor(CLIENT_ID, CLIENT_SECRET));
  assert.match(tok.contentType, /^application\/x-www-form-urlencoded/);
  assert.deepEqual(tok.body, { grant_type: "client_credentials", audience: SANDBOX, scope: "read:charity read:claim read:donor read:declaration create:declaration create:donation" });
  assert.ok(!JSON.stringify(data).includes("sa-test-token"), "the token is never returned");
});

await check("get_charity reports warranted true and false; the token is reused across calls", async () => {
  const n = requests.length;
  const yes = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.deepEqual(yes.data.charity, { hmrc_customer_id: "SA12345", warranted: true });
  const no = await call(client, "get_charity", { hmrc_customer_id: fx.NOT_WARRANTED });
  assert.equal(no.data.charity.warranted, false);
  assert.equal(tokenCalls(since(n)).length, 0, "the token fetched by healthcheck is cached, not fetched again");
  assert.match(requests.at(-1).auth, /^Bearer sa-test-token-\d+$/);
});

await check("list_charity_claims makes one request with no query (no pagination documented), after a 429 retry that waits for Retry-After, newest first", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED });
  const tries = since(n).filter((r) => r.path === `/charities/${fx.WARRANTED}/claims`);
  assert.equal(tries.length, 2, "one 429, one retry");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  for (const r of tries) assert.deepEqual(r.query, {}, "the spec documents no query parameters");
  assert.deepEqual(data.claims.map((c) => c.claim_id), ["clm_2026sep", "clm_2026aug", "clm_456xyz", "clm_123abc"]);
  assert.equal(data.claims_on_record, 4);
  assert.equal(data.totals, undefined, "totals only when asked");
  const none = await call(client, "list_charity_claims", { hmrc_customer_id: fx.NOT_WARRANTED });
  assert.deepEqual([none.data.count, none.data.claims], [0, []]);
});

await check("list_charity_claims filters dates locally and, with include_totals, adds up each claim's report", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_from: "2026-01-01", include_totals: true });
  assert.deepEqual(data.claims.map((c) => c.claim_id), ["clm_2026sep", "clm_2026aug"]);
  assert.deepEqual(since(n).map((r) => r.path), [`/charities/${fx.WARRANTED}/claims`, `/charities/${fx.WARRANTED}/claims/clm_2026sep`, `/charities/${fx.WARRANTED}/claims/clm_2026aug`]);
  assert.deepEqual(since(n).map((r) => r.query), [{}, {}, {}], "created_from is not sent to the API");
  const { claims_counted, filed_with_hmrc, donation_count, total_donations, total_gift_aid, overclaim_amount } = data.totals;
  assert.deepEqual({ claims_counted, filed_with_hmrc, donation_count, total_donations, total_gift_aid, overclaim_amount }, { claims_counted: 2, filed_with_hmrc: 1, donation_count: 3, total_donations: 3000, total_gift_aid: 750, overclaim_amount: 0 });
  const all = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, include_totals: true, max_results: 3 });
  assert.equal(all.data.count, 3);
  assert.match(all.data.note, /newest 3 of 4/);
  assert.deepEqual([all.data.totals.total_gift_aid, all.data.totals.overclaim_amount], [250 + 500 + 375, 0]);
  const old = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_to: "2021-09-30", include_totals: true });
  assert.deepEqual(old.data.claims.map((c) => c.claim_id), ["clm_123abc"]);
  assert.deepEqual([old.data.totals.total_donations, old.data.totals.total_gift_aid, old.data.totals.overclaim_amount], [980, 245, 100]);
});

await check("include_totals adds up at most 12 reports and says so; unusable ids are never put in a path; a missing report is named and the list kept", async () => {
  // 15 listed claims (the fixture ids reused, with distinct dates): exactly 12 report requests and the note.
  const many = Array.from({ length: 15 }, (_, i) => ({ id: fx.claims[fx.WARRANTED][i % 4].id, createdDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}/claims`, status: 200, body: many });
  let n = requests.length;
  const big = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, include_totals: true });
  assert.ok(!big.res.isError, big.text);
  assert.equal(since(n).filter((r) => /\/claims\/[^/]+$/.test(r.path)).length, 12, "exactly 12 report requests");
  assert.deepEqual([big.data.count, big.data.totals.claims_counted], [15, 12]);
  assert.match(big.data.totals.note, /Only the newest 12 of the 15 listed claims were added up; narrow the dates/);
  assert.equal(big.data.totals_errors, undefined);
  disarm();
  // ".." and "" from the API are not used in a path; a report that answers 404 is named; the rest are added up.
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}/claims`, status: 200, body: [{ id: "..", createdDate: "2026-09-03T00:00:00Z" }, { id: "", createdDate: "2026-09-02T00:00:00Z" }, { id: "clm_gone", createdDate: "2026-09-01T12:00:00Z" }, ...fx.claims[fx.WARRANTED]] });
  n = requests.length;
  const odd = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, include_totals: true });
  assert.ok(!odd.res.isError, odd.text);
  assert.deepEqual(since(n).map((r) => r.path), [`/charities/${fx.WARRANTED}/claims`, ...["clm_gone", "clm_2026sep", "clm_2026aug", "clm_456xyz", "clm_123abc"].map((id) => `/charities/${fx.WARRANTED}/claims/${id}`)]);
  assert.equal(odd.data.count, 7, "the whole list is returned");
  assert.deepEqual(odd.data.totals_errors.map((e) => e.claim_id), ["..", undefined, "clm_gone"]);
  assert.match(odd.data.totals_errors[0].error, /cannot use in a request path/);
  assert.match(odd.data.totals_errors[2].error, /Not found: \/charities\/SA12345\/claims\/clm_gone\./);
  assert.deepEqual([odd.data.totals.claims_counted, odd.data.totals.total_gift_aid], [4, 250 + 500 + 375 + 245]);
  assert.match(odd.data.totals.note, /3 of the 7 claims picked for totals could not be read/);
  assert.equal(odd.data.claims.find((c) => c.claim_id === "clm_2026aug").total_gift_aid, 500, "each report is merged into its own claim");
  disarm();
});

await check("get_claim returns the report; the HMRC filing receipt only on request", async () => {
  const { data } = await call(client, "get_claim", { hmrc_customer_id: fx.WARRANTED, claim_id: "clm_123abc" });
  const c = data.claim;
  assert.deepEqual([c.claim_id, c.invoice_id, c.filed_with_hmrc, c.donation_count, c.total_donations, c.total_gift_aid, c.overclaim_amount], ["clm_123abc", "INV-123", true, 2, 980, 245, 100]);
  assert.deepEqual(c.donation_ids, ["stl_123456", "stl_123457"]);
  assert.equal(c.has_filing_receipt, true);
  assert.equal(c.filing_receipt, undefined);
  const withReceipt = await call(client, "get_claim", { hmrc_customer_id: fx.WARRANTED, claim_id: "clm_123abc", include_filing_receipt: true });
  assert.equal(withReceipt.data.claim.filing_receipt, fx.RECEIPT);
  const unfiled = await call(client, "get_claim", { hmrc_customer_id: fx.WARRANTED, claim_id: "clm_2026sep" });
  assert.deepEqual([unfiled.data.claim.filed_with_hmrc, unfiled.data.claim.filed, unfiled.data.claim.has_filing_receipt], [false, undefined, false]);
});

await check("get_donor by id, by email and by phone passes type and value exactly as documented", async () => {
  const byId = await call(client, "get_donor", { donor_id: "dnr_0123456" });
  assert.deepEqual([byId.data.donor_id, byId.data.found_by, byId.data.active_authorisation], ["dnr_0123456", "donor_id", true]);
  assert.equal(requests.at(-1).path, "/donors/dnr_0123456/authorisation");
  let n = requests.length;
  const byEmail = await call(client, "get_donor", { email: "jo.example@example.com" });
  assert.deepEqual([byEmail.data.donor_id, byEmail.data.found_by, byEmail.data.active_authorisation], ["dnr_0999999", "email", false]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query]), [["/donors/", { type: "email", value: "jo.example@example.com" }], ["/donors/dnr_0999999/authorisation", {}]]);
  n = requests.length;
  const byPhone = await call(client, "get_donor", { phone_number: "+447700900456" });
  assert.equal(byPhone.data.donor_id, "dnr_0123456");
  assert.deepEqual(since(n)[0].query, { type: "phoneNumber", value: "+447700900456" });
  assert.ok(!byEmail.text.includes("jo.example@") && !byPhone.text.includes("900456"), "the looked-up email or phone is not echoed back");
  const unknown = await call(client, "get_donor", { email: "nobody@example.com" });
  assert.ok(unknown.res.isError);
  assert.match(unknown.text, /No Swiftaid donor account matches that email address \(404\)/);
  assert.ok(!unknown.text.includes("nobody@"));
});

await check("get_declaration returns donor names but withholds address and postcode by default, and redacts contact details in free text", async () => {
  const { data } = await call(client, "get_declaration", { donation_id: "stl_123456" });
  const d = data.declaration;
  assert.deepEqual([d.donation_id, d.status, d.amount, d.currency, d.donated_on, d.nominee_charity_ref, d.matched_retrospectively], ["stl_123456", "declared", 470, "GBP", "2018-07-17T10:02:34Z", "Local Church", false]);
  assert.deepEqual(d.donor, { first_name: "Bob", last_name: "Smith", country: "UK" });
  const text = JSON.stringify(data);
  for (const leak of ["Unit 1", "High Street", "Guildford", "Surrey", "GU1 1AA"]) assert.ok(!text.includes(leak), `${leak} leaked by default`);
  const other = await call(client, "get_declaration", { donation_id: "stl_123457" });
  assert.equal(other.data.declaration.nominee_charity_ref, "Local Church SA12345, ref clm_123abc (queries [phone redacted] or [email redacted], [postcode redacted])", "ids and HMRC ids are left alone");
  assert.equal(other.data.declaration.status, "reversed");
  const full = await call(client, "get_declaration", { donation_id: "stl_123457", include_contact_details: true });
  assert.deepEqual(full.data.declaration.donor, { first_name: "Priya", last_name: "Example", country: "UK", address_line_1: "14 High Street", address_line_2: "Town Centre", city: "Guildford", county: "Surrey", postcode: "GU1 3RT" });
  assert.equal(full.data.declaration.nominee_charity_ref, fx.declarations.stl_123457.nomineeCharityRef);
});

await check("contact details typed into donor names and the nominee reference (postcodes in any case) are redacted by default and returned on request", async () => {
  // Postcodes in any case and with any spacing, as the spec's postcode pattern allows.
  const ref = "Local Church, gu1 3rt; Gu1 3rt; GU1  3RT; sw1a 1aa; ref clm_123abc, SA12345";
  arm({ method: "GET", path: "/donations/stl_123456/declaration", status: 200, times: 2, body: { ...fx.declarations.stl_123456, nomineeCharityRef: ref, donor: { ...fx.declarations.stl_123456.donor, lastname: "Smith (+44 7700 900123, bob@example.com) gu1 3rt" } } });
  const { data } = await call(client, "get_declaration", { donation_id: "stl_123456" });
  assert.equal(data.declaration.donor.last_name, "Smith ([phone redacted], [email redacted]) [postcode redacted]");
  assert.equal(data.declaration.nominee_charity_ref, "Local Church, [postcode redacted]; [postcode redacted]; [postcode redacted]; [postcode redacted]; ref clm_123abc, SA12345");
  const raw = await call(client, "get_declaration", { donation_id: "stl_123456", include_contact_details: true });
  assert.equal(raw.data.declaration.donor.last_name, "Smith (+44 7700 900123, bob@example.com) gu1 3rt");
  assert.equal(raw.data.declaration.nominee_charity_ref, ref);
  disarm();
});

await check("card and payment data are never returned, even if a response carried them and contact details were requested", async () => {
  // Undocumented fields, injected for this check only: the documented GiftAidDeclaration has no card data.
  arm({ method: "GET", path: "/donations/stl_123456/declaration", status: 200, body: { ...fx.declarations.stl_123456, nomineeCharityRef: "Local Church card 4111 1111 1111 1111", card: { par: "1".repeat(29), bin: "444400", last4: "4446" }, donor: { ...fx.declarations.stl_123456.donor, bin: "444400", last4: "4446" } } });
  const { data } = await call(client, "get_declaration", { donation_id: "stl_123456", include_contact_details: true });
  const text = JSON.stringify(data);
  for (const leak of ["444400", "4446", "1".repeat(29), "4111"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.equal(data.declaration.nominee_charity_ref, "Local Church card [card number redacted]");
  disarm();
});

const declarationArgs = {
  declarations: [
    { declaration_id: "dec_900001", hmrc_customer_id: fx.WARRANTED, start_date: "2022-04-06", donor: { first_name: "Sam", last_name: "Example", address_line_1: "14 High Street", address_line_2: "Town Centre", city: "Guildford", county: "Surrey", postcode: "GU1 3RT" }, source_ref: "2026/cust_0001.wav", request_date: "2026-09-28T09:10:03Z" },
    { declaration_id: "dec_123456", hmrc_customer_id: fx.WARRANTED, donor: { first_name: "Jo", last_name: "Example", address_line_1: "1 High Street", postcode: "GU1 1AA" }, source_ref: "2026/cust_0002.png" },
  ],
};

await check("create_declaration posts a body that validates against the spec's EnduringDeclarations and reports each result", async () => {
  const { data } = await call(client, "create_declaration", declarationArgs);
  const post = requests.at(-1);
  assert.deepEqual([post.method, post.path], ["POST", "/declarations"]);
  validateWith(spec.paths["/declarations"].post.requestBody.content["application/json"].schema.$ref.split("/").pop(), post.body, "POST /declarations body");
  assert.deepEqual(post.body[0], {
    id: "dec_900001", hmrcCustomerId: "SA12345", startDate: "2022-04-06T00:00:00Z",
    donor: { firstname: "Sam", lastname: "Example", addressLine1: "14 High Street", addressLine2: "Town Centre", city: "Guildford", county: "Surrey", postcode: "GU1 3RT", country: "UK" },
    source: { sourceRef: "2026/cust_0001.wav", requestDate: "2026-09-28T09:10:03Z" },
  });
  assert.deepEqual(post.body[1].source, { sourceRef: "2026/cust_0002.png" });
  assert.deepEqual([data.submitted, data.accepted], [2, 1]);
  assert.deepEqual(data.results, [{ declaration_id: "dec_900001", accepted: true }, { declaration_id: "dec_123456", accepted: false, info: "duplicate" }]);
});

const donationArgs = {
  donations: [
    { donation_id: "stl_900001", donor_type: "uid", donor_value: "dnr_0123456", charity_type: "hmrcId", charity_ref: fx.WARRANTED, gross_amount_pence: 500, net_amount_pence: 490, transaction_date: "2026-09-28T10:23:01Z", settlement_date: "2026-09-29T22:00:00Z" },
    { donation_id: "stl_900002", donor_type: "email", donor_value: "sam.example@example.com", charity_type: "nominee", charity_name: "Local Church", create_declaration: true, file_declaration: true, gross_amount_pence: 1000, transaction_date: "2026-09-28" },
    { donation_id: "stl_900003", donor_type: "phone", donor_value: "07700 900456", charity_type: "direct", charity_ref: "your_unique_reference", gross_amount_pence: 250, transaction_date: "2026-09-28T11:00:00+01:00" },
    { donation_id: "stl_123456", donor_type: "declaration", donor_value: "dec_900001", charity_type: "hmrcId", charity_ref: fx.WARRANTED, gross_amount_pence: 470, transaction_date: "2018-07-17T10:02:34Z", settlement_date: "2018-07-18T10:00:00Z" },
  ],
};

await check("create_donation posts a body that validates against the spec's Donations (discriminators resolved) and flags unsettled donations", async () => {
  const { data } = await call(client, "create_donation", donationArgs);
  const post = requests.at(-1);
  assert.deepEqual([post.method, post.path], ["POST", "/donations"]);
  validateWith("Donations", post.body, "POST /donations body");
  for (const d of post.body) {
    validateWith(spec.components.schemas.DonorIdentifier.discriminator.mapping[d.donor.type].split("/").pop(), d.donor, `donor ${d.donationId}`);
    validateWith(spec.components.schemas.TransactionIdentifier.discriminator.mapping[d.transaction.type].split("/").pop(), d.transaction, `transaction ${d.donationId}`);
  }
  assert.deepEqual(post.body[0], { donationId: "stl_900001", donor: { type: "uid", value: "dnr_0123456" }, transaction: { type: "hmrcId", id: "SA12345" }, grossAmount: 500, netAmount: 490, currency: "GBP", transactionDate: "2026-09-28T10:23:01Z", settlementDate: "2026-09-29T22:00:00Z" });
  assert.deepEqual(post.body[1].transaction, { type: "nominee", charityName: "Local Church", createDeclaration: true, fileDeclaration: true });
  assert.equal(post.body[1].transactionDate, "2026-09-28T00:00:00Z");
  assert.deepEqual(post.body[2].transaction, { type: "direct", id: "your_unique_reference" });
  assert.deepEqual([data.submitted, data.accepted], [4, 3]);
  assert.deepEqual(data.results.at(-1), { donation_id: "stl_123456", accepted: false, info: "duplicate" });
  assert.match(data.note, /No settlement date was given for stl_900002, stl_900003/);
});

await check("writes with invalid content are refused locally, before any request", async () => {
  const n = requests.length;
  const bad = [
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], donor: { ...declarationArgs.declarations[0].donor, first_name: "Sam2" } }] }, /must not contain digits/],
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], donor: { ...declarationArgs.declarations[0].donor, postcode: "12345" } }] }, /postcode/i],
    ["create_declaration", { declarations: [declarationArgs.declarations[0], declarationArgs.declarations[0]] }, /appears twice/],
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], request_date: "28/09/2026" }] }, /not a date-time/],
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], donor: { ...declarationArgs.declarations[0].donor, last_name: "X" } }] }, /last_name/],
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], source_ref: "x".repeat(251) }] }, /source_ref/],
    ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], declaration_id: "d".repeat(101) }] }, /declaration_id/],
    ["create_donation", { donations: [{ ...donationArgs.donations[0], net_amount_pence: 600 }] }, /cannot exceed gross/],
    ["create_donation", { donations: [{ ...donationArgs.donations[2], donor_value: "020 7946 0958" }] }, /not a UK mobile number/],
    ["create_donation", { donations: [{ ...donationArgs.donations[0], charity_ref: "12345" }] }, /HMRC customer id/],
    ["create_donation", { donations: [{ ...donationArgs.donations[1], charity_name: undefined }] }, /charity_name is required/],
    ["create_donation", { donations: [{ ...donationArgs.donations[0], donor_type: "par", donor_value: "1".repeat(29) }] }, /donor_type|Invalid/],
  ];
  for (const [tool, args, re] of bad) {
    const r = await call(client, tool, args);
    assert.ok(r.res.isError, `${tool} should refuse ${JSON.stringify(args).slice(0, 120)}`);
    assert.match(r.text, re);
  }
  assert.equal(requests.length, n, "no request for refused writes");
});

await check("bad ids are rejected before any API call; unknown ids give a clear 404", async () => {
  const n = requests.length;
  for (const [tool, args, re] of [
    ["get_charity", { hmrc_customer_id: "sa12345" }],
    ["get_charity", { hmrc_customer_id: "SA123456" }],
    ["list_charity_claims", { hmrc_customer_id: "../x" }],
    ["get_claim", { hmrc_customer_id: fx.WARRANTED, claim_id: "clm/../x" }],
    ["get_declaration", { donation_id: "a".repeat(51) }],
    ["get_donor", { donor_id: "dnr 1" }],
    ["get_donor", { phone_number: "020 7946 0958" }, /UK mobile numbers.*the pattern the spec uses for donor phone numbers/],
    ["get_donor", {}],
    ["get_donor", { donor_id: "dnr_0123456", email: "sam.example@example.com" }],
    ["list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_from: "1 Sept" }],
    ["list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_from: "2026-13-01" }, /real calendar date/],
    ["list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_to: "2026-02-30" }, /real calendar date/],
    ["list_charity_claims", { hmrc_customer_id: fx.WARRANTED, created_from: "2026-12-01", created_to: "2021-01-01" }, /created_from \(2026-12-01\) is after created_to \(2021-01-01\)/],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
    if (re) assert.match(bad.content[0].text, re);
  }
  assert.equal(requests.length, n, "no request for invalid ids");
  const missing = await call(client, "get_claim", { hmrc_customer_id: fx.WARRANTED, claim_id: "clm_nope" });
  assert.ok(missing.res.isError);
  assert.match(missing.text, /Not found: \/charities\/SA12345\/claims\/clm_nope\. Check the ID/);
  const noDeclaration = await call(client, "get_declaration", { donation_id: "stl_nope" });
  assert.match(noDeclaration.text, /no Gift Aid declaration for donation stl_nope \(404\).*settlement date/);
  const noDonor = await call(client, "get_donor", { donor_id: "dnr_nope" });
  assert.match(noDonor.text, /Not found: \/donors\/dnr_nope\/authorisation/);
});

await check("a revoked token is replaced once and the call retried", async () => {
  revokeTokens();
  const n = requests.length;
  const { res } = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(!res.isError, res.content[0].text);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`GET /charities/${fx.WARRANTED}`, `POST ${TOKEN_PATH}`, `GET /charities/${fx.WARRANTED}`]);
  assert.notEqual(since(n)[0].auth, since(n)[2].auth);
});

await check("a Retry-After above the cap gives up at once; a persistent 429 gives up after three attempts", async () => {
  arm429({ retryAfter: "600" });
  let n = requests.length;
  const long = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(long.res.isError);
  assert.equal(since(n).length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/charities\/SA12345\/claims \(HTTP 429\)\. Try again after that\./);
  arm429({ persistent: true, retryAfter: "0" });
  n = requests.length;
  const persistent = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(persistent.res.isError);
  assert.equal(since(n).length, 3, "exactly three attempts");
  assert.match(persistent.text, /Swiftaid rate limit reached \(the limit is not documented\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  const n = requests.length;
  const { res } = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === `/charities/${fx.WARRANTED}/claims`);
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a fractional Retry-After is read as seconds, and a 429 without Retry-After waits 2 s", async () => {
  for (const [retryAfter, lo, hi] of [["1.5", 1400, 1950], [undefined, 1950, 2600]]) {
    disarm();
    arm({ method: "GET", path: `/charities/${fx.WARRANTED}/claims`, status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    const n = requests.length;
    const { res } = await call(client, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED });
    assert.ok(!res.isError);
    const tries = since(n).filter((r) => r.path.endsWith("/claims"));
    const gap = tries[1].t - tries[0].t;
    assert.ok(gap >= lo && gap < hi, `Retry-After ${retryAfter ?? "absent"}: waited ${gap} ms`);
  }
  disarm();
});

await check("a 502 on a GET is retried; a GET failing three times with 503 gives advice without the gateway HTML; a 200 that is not JSON is an error", async () => {
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}`, status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  const retried = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(!retried.res.isError, retried.text);
  assert.equal(since(n).length, 2);
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}`, status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(down.res.isError);
  assert.equal(since(n).length, 3);
  assert.match(down.text, /returned 503 for GET \/charities\/SA12345 3 times in a row\. The service may be unavailable/);
  assert.ok(!down.text.includes("<html>"));
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}`, status: 200, text: "<html>Please sign in</html>" });
  const html = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(html.res.isError, "a non-JSON 200 must not be reported as success");
  assert.match(html.text, /returned 200 for GET \/charities\/SA12345 but the body was not JSON.*Check SWIFTAID_ENV/);
  disarm();
});

await check("a 502 on POST /donations or POST /declarations is never retried, and the error says how to resend safely", async () => {
  for (const [tool, args, path] of [["create_donation", { donations: [donationArgs.donations[0]] }, "/donations"], ["create_declaration", { declarations: [declarationArgs.declarations[0]] }, "/declarations"]]) {
    arm({ method: "POST", path, status: 502, headers: { "Retry-After": "0" } });
    const n = requests.length;
    const { res, text } = await call(client, tool, args);
    assert.ok(res.isError);
    assert.equal(since(n).filter((r) => r.method === "POST" && r.path === path).length, 1, `exactly one POST ${path}`);
    assert.match(text, new RegExp(`returned 502 for POST ${path}\\. The request was not retried because it may already have been processed.*duplicate`));
    disarm();
  }
});

await check("a POST whose body Swiftaid rejects passes on the documented problem details, redacted", async () => {
  arm({ method: "POST", path: "/declarations", status: 400, body: { status: 400, type: "https://www.rfc-editor.org/rfc/rfc9110.html#name-400-bad-request", title: "Bad Request", detail: "Request content had validation failures.", errors: ["'postcode' must not be empty.", "Contact sam.example@example.com for help"] } });
  const { res, text } = await call(client, "create_declaration", { declarations: [declarationArgs.declarations[0]] });
  assert.ok(res.isError);
  assert.match(text, /refused POST \/declarations \(400\)\. Bad Request: Request content had validation failures\. Errors: 'postcode' must not be empty\. \| Contact \[email redacted\] for help/);
  disarm();
  // A lowercase postcode echoed in an error is redacted like any other.
  arm({ method: "POST", path: "/declarations", status: 400, body: { status: 400, title: "Bad Request", errors: ["'postcode' gu1 3rt is not found in PAF."] } });
  const pc = await call(client, "create_declaration", { declarations: [declarationArgs.declarations[0]] });
  assert.match(pc.text, /Errors: 'postcode' \[postcode redacted\] is not found in PAF\./);
  assert.ok(!/gu1 3rt/i.test(pc.text));
  disarm();
  // The documented 409 for POST /declarations.
  arm({ method: "POST", path: "/declarations", status: 409, body: { status: 409, type: "about:blank", title: "Conflict", detail: "Declaration dec_900001 conflicts" } });
  const conflict = await call(client, "create_declaration", { declarations: [declarationArgs.declarations[0]] });
  assert.ok(conflict.res.isError);
  assert.match(conflict.text, /^Swiftaid reported a conflict for POST \/declarations \(409\)\. Conflict: Declaration dec_900001 conflicts$/);
  disarm();
  // Per-item results: info and problem details are redacted too (content injected for this check).
  arm({ method: "POST", path: "/donations", status: 200, body: [{ donationId: "stl_900009", accepted: false, info: "No authorisation for sam.example@example.com", problemDetails: { type: "https://www.rfc-editor.org/rfc/rfc9110.html#name-400-bad-request", title: "Bad Request", status: "400", detail: "Request content had validation failures.", errors: ["'value' 07700 900456 is not known."] } }] });
  const r = await call(client, "create_donation", { donations: [{ ...donationArgs.donations[0], donation_id: "stl_900009" }] });
  assert.deepEqual(r.data.results, [{ donation_id: "stl_900009", accepted: false, info: "No authorisation for [email redacted]", problem: "Bad Request: Request content had validation failures.", errors: ["'value' [phone redacted] is not known."] }]);
  disarm();
});

await check("a write answered 200 without the documented array is an error saying the outcome is unknown, never '0 accepted'", async () => {
  for (const [tool, args, path, idName] of [["create_donation", { donations: [{ ...donationArgs.donations[0], donation_id: "stl_900020" }] }, "/donations", "donation id"], ["create_declaration", { declarations: [{ ...declarationArgs.declarations[0], declaration_id: "dec_900020" }] }, "/declarations", "declaration id"]]) {
    arm({ method: "POST", path, status: 200, body: { donationId: "stl_900020", accepted: true, info: "" } });
    const n = requests.length;
    const { res, text } = await call(client, tool, args);
    assert.ok(res.isError, `${tool}: ${text}`);
    assert.equal(since(n).length, 1);
    assert.match(text, new RegExp(`answered POST ${path} with 200 but not the documented array.*outcome is unknown.*same ${idName}s.*duplicate`));
    disarm();
  }
});

await check("a 429 on POST /donations is retried once after Retry-After and the donation is filed once", async () => {
  arm({ method: "POST", path: "/donations", status: 429, headers: { "Retry-After": "1" } });
  const n = requests.length;
  const { data, text } = await call(client, "create_donation", { donations: [{ ...donationArgs.donations[0], donation_id: "stl_900030" }] });
  assert.ok(data, text);
  const posts = since(n).filter((r) => r.method === "POST" && r.path === "/donations");
  assert.equal(posts.length, 2, "one 429, one retry");
  assert.ok(posts[1].t - posts[0].t >= 1000, "waited for Retry-After");
  assert.deepEqual([data.submitted, data.accepted], [1, 1]);
  disarm();
});

await check("the access token and the client secret are scrubbed from any message that echoes them", async () => {
  const token = /^Bearer (.+)$/.exec(requests.filter((x) => x.path !== TOKEN_PATH && x.auth?.startsWith("Bearer")).at(-1).auth)[1];
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}`, status: 400, body: { type: "about:blank", title: "Bad Request", status: "400", detail: `Token ${token} is malformed` } });
  const echoed = await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(echoed.res.isError);
  assert.ok(!echoed.text.includes(token), "token leaked");
  assert.match(echoed.text, /Token \[redacted\] is malformed/);
  arm({ method: "POST", path: TOKEN_PATH, status: 401, body: { error: "invalid_client", error_description: `Bad secret ${CLIENT_SECRET} for ${CLIENT_BASIC}` } });
  const health = await call(client, "healthcheck");
  const msg = health.data.credentials.error;
  assert.ok(!msg.includes(CLIENT_SECRET) && !msg.includes(CLIENT_BASIC.slice(6)), "secret leaked");
  assert.match(msg, /invalid_client: Bad secret \[redacted\] for Basic \[redacted\]/);
  disarm();
});

await check("a token is refreshed shortly before its expires_in runs out", async () => {
  setTokenTtl(4); // cached for 2 s (half its life, as it is shorter than two minutes)
  revokeTokens();
  await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED }); // 401, then a 4-second token
  const n = requests.length;
  await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.equal(tokenCalls(since(n)).length, 0, "still fresh");
  await new Promise((r) => setTimeout(r, 2300));
  const m = requests.length;
  await call(client, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.deepEqual(since(m).map((r) => r.path), [TOKEN_PATH, `/charities/${fx.WARRANTED}`], "a new token is fetched before the call, not after a 401");
  setTokenTtl(86400);
  revokeTokens();
});

await client.close();

await check("the token request is retried after a 429 and a 503 (it has no side effect) on a fresh client", async () => {
  const fresh = await connect();
  arm({ method: "POST", path: TOKEN_PATH, status: 429, headers: { "Retry-After": "0" } });
  arm({ method: "POST", path: TOKEN_PATH, status: 503, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const { res, text } = await call(fresh, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(!res.isError, text);
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), [`POST ${TOKEN_PATH}`, `POST ${TOKEN_PATH}`, `POST ${TOKEN_PATH}`, `GET /charities/${fx.WARRANTED}`]);
  disarm();
  await fresh.close();
});

await check("a tool call stops retrying at its time budget; include_totals then returns the list, the totals read so far and what was skipped", async () => {
  const quick = await connect({ env: { SWIFTAID_TOOL_BUDGET_S: "4" } });
  arm({ method: "GET", path: `/charities/${fx.WARRANTED}/claims/clm_2026aug`, status: 429, times: Infinity, headers: { "Retry-After": "2" } });
  const n = requests.length;
  const t0 = Date.now();
  const { res, data, text } = await call(quick, "list_charity_claims", { hmrc_customer_id: fx.WARRANTED, include_totals: true });
  const took = Date.now() - t0;
  assert.ok(!res.isError, text);
  assert.ok(took < 4000, `gave up within the budget (took ${took} ms)`);
  const aug = since(n).filter((r) => r.path.endsWith("/clm_2026aug"));
  assert.equal(aug.length, 2, "one wait fits the budget, the second does not");
  assert.equal(since(n).filter((r) => /clm_456xyz|clm_123abc/.test(r.path)).length, 0, "the remaining reports are not requested");
  assert.equal(data.count, 4);
  assert.equal(data.totals.claims_counted, 1);
  assert.equal(data.totals_errors[0].claim_id, "clm_2026aug");
  assert.match(data.totals_errors[0].error, /answered GET \/charities\/SA12345\/claims\/clm_2026aug with HTTP 429, and waiting 2 more seconds to retry would take this tool call past its time budget/);
  assert.match(data.totals_errors[1].error, /Stopped after this error; the reports of clm_456xyz, clm_123abc were not requested\./);
  disarm();
  await quick.close();
});

await check("writes are off when SWIFTAID_ALLOW_WRITES is unset or 'false', and only read scopes are requested", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect({ writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS, `SWIFTAID_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    const n = requests.length;
    await call(ro, "get_charity", { hmrc_customer_id: fx.WARRANTED });
    assert.equal(tokenCalls(since(n))[0].body.scope, "read:charity read:claim read:donor read:declaration");
    await ro.close();
  }
});

await check("a missing scope gives a 403 naming it; a scope the client lacks is refused at the token endpoint", async () => {
  const narrow = await connect({ env: { SWIFTAID_SCOPE: "read:charity" } });
  const okCall = await call(narrow, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(!okCall.res.isError);
  assert.equal(tokenCalls(requests).at(-1).body.scope, "read:charity");
  const denied = await call(narrow, "get_declaration", { donation_id: "stl_123456" });
  assert.ok(denied.res.isError);
  assert.match(denied.text, /refused GET \/donations\/stl_123456\/declaration \(403\)\. This operation needs the `read:declaration` scope/);
  await narrow.close();
  const wide = await connect({ env: { SWIFTAID_SCOPE: "read:charity manage:donor" } });
  const refused = await call(wide, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.match(refused.text, /refused the requested scopes \(400 invalid_scope\): read:charity manage:donor.*SWIFTAID_SCOPE/);
  await wide.close();
});

await check("wrong client credentials give an actionable error that never echoes the secret; healthcheck reports them", async () => {
  const wrongSecret = "swiftaid-wrong-secret-not-real";
  const bad = await connect({ secret: wrongSecret });
  const n = requests.length;
  const { res, text } = await call(bad, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(res.isError);
  assert.match(text, /rejected the client credentials \(401\)\. Check SWIFTAID_CLIENT_ID and SWIFTAID_CLIENT_SECRET, and that they are for the sandbox environment \(SWIFTAID_ENV\).*invalid_client/);
  assert.ok(!text.includes(wrongSecret) && !text.includes(basicFor(CLIENT_ID, wrongSecret).slice(6)));
  assert.equal(since(n).filter((r) => r.path !== TOKEN_PATH).length, 0, "no API call without a token");
  const health = await call(bad, "healthcheck");
  assert.equal(health.data.api.reachable, true);
  assert.equal(health.data.credentials.accepted, false);
  assert.match(health.data.credentials.error, /rejected the client credentials/);
  await bad.close();
});

await check("SWIFTAID_ENV=production requests a token for the production audience; the sandbox refusing it says to check SWIFTAID_ENV", async () => {
  const prod = await connect({ env: { SWIFTAID_ENV: "production" } });
  const n = requests.length;
  const { res, text } = await call(prod, "get_charity", { hmrc_customer_id: fx.WARRANTED });
  assert.ok(res.isError);
  const toks = tokenCalls(since(n));
  assert.equal(toks.length, 2, "one token, then a fresh one after the 401");
  for (const t of toks) assert.equal(t.body.audience, PRODUCTION);
  assert.match(text, /rejected the access token \(401\).*even after fetching a fresh one\. Check that SWIFTAID_ENV \(production, audience https:\/\/api\.swiftaid\.co\.uk\/integrations\/v1\) matches/);
  await prod.close();
});

await check("every request used the documented auth and a documented method+path, and the experimental and delete endpoints were never called", async () => {
  assert.ok(requests.length > 60, `expected a full run, got ${requests.length} requests`);
  const used = new Set();
  for (const r of requests) {
    assert.equal(r.fullPath.startsWith(PREFIX) || r.path === TOKEN_PATH, true, `${r.fullPath} is under ${PREFIX}`);
    if (r.path === TOKEN_PATH) {
      assert.equal(r.method, "POST");
      assert.match(r.auth, /^Basic /);
      const [id, secret] = Buffer.from(r.auth.slice(6), "base64").toString("utf8").split(":");
      assert.equal(id, CLIENT_ID);
      assert.ok(secret.endsWith("-not-real"));
      assert.deepEqual(Object.keys(r.body).sort(), ["audience", "grant_type", "scope"], "credentials travel in the Basic header only");
      assert.deepEqual(r.query, {});
      used.add(`POST ${TOKEN_PATH}`);
      continue;
    }
    const op = operations.find((o) => o.method === r.method && o.re.test(r.path));
    assert.ok(op, `undocumented call ${r.method} ${r.path}`);
    used.add(`${op.method} ${op.template}`);
    if (op.template === "/healthcheck") assert.equal(r.auth, undefined, "no token on /healthcheck");
    else {
      const token = /^Bearer (.+)$/.exec(r.auth ?? "")?.[1];
      assert.ok(token && everIssued.has(token), `${r.method} ${r.path} carried a token the mock issued`);
    }
    assert.ok(!JSON.stringify(r.query).includes("secret"));
  }
  assert.deepEqual([...used].sort(), [
    "GET /charities/{hmrcCustomerId}", "GET /charities/{hmrcCustomerId}/claims", "GET /charities/{hmrcCustomerId}/claims/{claimId}", "GET /donations/{donationId}/declaration",
    "GET /donors/", "GET /donors/{donorId}/authorisation", "GET /healthcheck", "POST /declarations", "POST /donations", `POST ${TOKEN_PATH}`,
  ]);
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, in ${Math.round((Date.now() - started) / 1000)} s.`);
