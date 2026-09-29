#!/usr/bin/env node
// Swiftaid MCP server: lets Claude, ChatGPT and other MCP clients work with the Swiftaid Gift Aid API.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_CALL_BUDGET_S, ENVIRONMENTS, SwiftaidClient, SwiftaidError, withBudget, type Environment } from "./client.js";
import * as fmt from "./format.js";

const clientId = process.env.SWIFTAID_CLIENT_ID?.trim();
const clientSecret = process.env.SWIFTAID_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error("SWIFTAID_CLIENT_ID and SWIFTAID_CLIENT_SECRET must both be set. Swiftaid issues sandbox client credentials on request (dev@swiftaid.co.uk) after you accept its API terms.");
  process.exit(1);
}
const envName = (process.env.SWIFTAID_ENV?.trim() || "sandbox").toLowerCase();
if (!(envName in ENVIRONMENTS)) {
  console.error(`SWIFTAID_ENV must be "sandbox" or "production" (got "${envName}").`);
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.SWIFTAID_ALLOW_WRITES ?? "");

// Scopes from the spec's securitySchemes.oAuth, one per operation used here. Read scopes only unless
// writes are enabled.
const READ_SCOPES = ["read:charity", "read:claim", "read:donor", "read:declaration"];
const WRITE_SCOPES = ["create:declaration", "create:donation"];
const scopeOverride = process.env.SWIFTAID_SCOPE?.trim() || undefined;
if (scopeOverride !== undefined && !/^[a-z]+:[a-z]+( [a-z]+:[a-z]+)*$/.test(scopeOverride)) {
  console.error(`SWIFTAID_SCOPE must be a space-separated list of scopes such as "read:charity read:claim" (got "${scopeOverride}").`);
  process.exit(1);
}
const scopes = scopeOverride ? scopeOverride.split(" ") : allowWrites ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;
// Time budget per tool call for retry waits (client.ts, withBudget). Lowered by the tests.
const budgetRaw = process.env.SWIFTAID_TOOL_BUDGET_S?.trim();
const budgetS = budgetRaw ? Number(budgetRaw) : DEFAULT_CALL_BUDGET_S;
if (!Number.isFinite(budgetS) || budgetS <= 0 || budgetS > 3600) {
  console.error(`SWIFTAID_TOOL_BUDGET_S must be a number of seconds between 0 and 3600 (got "${budgetRaw}").`);
  process.exit(1);
}

const api = new SwiftaidClient({
  clientId,
  clientSecret,
  environment: envName as Environment,
  scopes,
  baseUrl: process.env.SWIFTAID_BASE_URL?.trim() || undefined,
  tokenUrl: process.env.SWIFTAID_TOKEN_URL?.trim() || undefined,
});

const server = new McpServer(
  { name: "swiftaid", version: "0.1.0" },
  {
    instructions: [
      "Tools for the Swiftaid Gift Aid API, used by a donation platform integrated with Swiftaid.",
      "Charities are identified by their HMRC customer id: X or two capital letters, then 1 to 5 digits (the spec's pattern), e.g. SA12345; the sandbox's test charity is SA12345.",
      "Claim ids look like clm_123abc; donor ids like dnr_0123456; donation ids are the platform's own references (e.g. stl_123456).",
      "Typical flow for 'how much Gift Aid has this charity claimed?': list_charity_claims with include_totals, then get_claim for one claim.",
      "Typical flow for 'can this donor's donations get Gift Aid?': get_donor by donor id, email or phone number; active_authorisation says whether Swiftaid holds this tax year's intermediary authorisation.",
      "Amounts are integers in pence for GBP (500 = £5.00), as Swiftaid documents for donations.",
      "Donor addresses and postcodes are only returned when explicitly requested with include_contact_details. Card and payment data are never returned.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

// Spec: hmrcCustomerId pattern '^(?:X|[A-Z]{2})\d{1,5}$' (e.g. SA12345).
const HMRC_ID = /^(?:X|[A-Z]{2})\d{1,5}$/;
const hmrcId = z.string().regex(HMRC_ID, "HMRC customer ids are X or two capital letters followed by 1 to 5 digits, e.g. SA12345");
// Claim and donor ids are typed as plain strings; the examples are clm_123abc and dnr_0123456. Only
// values that could not be a path segment are refused: letters, digits, "_" and "-", up to 64.
const shortId = (what: string, example: string, max = 64) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`), `${what} ids are up to ${max} letters, digits, _ and -, e.g. ${example}`);
// Donation.donationId: string, maxLength 50 (examples stl_123456, 1234567890abcdef).
const donationId = shortId("Donation", "stl_123456", 50);
// Spec PhoneNumber / DonorIdentifierPhone pattern: UK mobile numbers only.
const UK_MOBILE = /^(\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}$/;
// Spec AuthorisationInfo.postcode pattern.
const POSTCODE = /^[a-zA-Z]{1,2}\d[a-zA-Z\d]?\s*\d[a-zA-Z]{2}$/;
// Spec fields are format: date-time. A bare date becomes midnight UTC; a date-time must carry Z or an offset.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const dateTime = z.string().transform((v, ctx) => {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return `${s}T00:00:00Z`;
  if (DATE_TIME.test(s) && !Number.isNaN(Date.parse(s))) return s;
  ctx.addIssue({ code: "custom", message: `"${v}" is not a date-time; give YYYY-MM-DDTHH:MM:SSZ (or with an offset such as +01:00), or a date YYYY-MM-DD` });
  return z.NEVER;
});
// A calendar date that exists: 2026-13-01 and 2026-02-30 are refused rather than read as NaN or rolled over.
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Give a date as YYYY-MM-DD")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "Not a real calendar date; give YYYY-MM-DD");

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const errText = (err: unknown) => (err instanceof SwiftaidError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}`);
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: errText(err) }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await withBudget(budgetS * 1000, () => fn(args)));
  } catch (err) {
    return fail(err);
  }
};
const is404 = (err: unknown) => err instanceof SwiftaidError && err.status === 404;
const SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The spec documents a 200 with an array of per-item results for both POSTs. Anything else leaves the
// outcome unknown, which must not be reported as "0 accepted".
const unknownOutcome = (path: string, what: string, idName: string) =>
  new SwiftaidError(
    `Swiftaid answered POST ${path} with 200 but not the documented array of per-item results, so the outcome is unknown: the ${what} may or may not have been recorded. Send them again with the same ${idName}s; Swiftaid reports any it already holds as "duplicate".`,
  );

server.registerTool(
  "healthcheck",
  {
    title: "Check the Swiftaid connection",
    description:
      "Check that the Swiftaid API answers (GET /healthcheck, which needs no token) and, unless check_credentials is false, that the auth service issues a token for the configured client credentials, environment and scopes.",
    inputSchema: {
      check_credentials: z.boolean().default(true).describe("Also request an access token to prove the client credentials work"),
    },
    annotations: READ,
  },
  safe(async ({ check_credentials }) => {
    const out: Record<string, unknown> = { environment: api.environment, base_url: api.baseUrl };
    try {
      const h = await api.healthcheck();
      out.api = { reachable: true, status: h.status, body: h.body };
    } catch (err) {
      out.api = { reachable: false, error: err instanceof SwiftaidError ? err.message : String(err) };
    }
    if (check_credentials) {
      try {
        await api.checkCredentials();
        out.credentials = { accepted: true, audience: api.audience, scopes_requested: api.scopes };
      } catch (err) {
        out.credentials = { accepted: false, error: err instanceof SwiftaidError ? err.message : String(err) };
      }
    }
    return out;
  }),
);

server.registerTool(
  "get_charity",
  {
    title: "Charity on-boarding status",
    description:
      "Whether a charity, identified by its HMRC customer id, has warranted donations from your platform as eligible for Gift Aid in the Swiftaid charity dashboard (the on-boarding step Swiftaid needs before it can claim for it). The API has no endpoint that lists charities.",
    inputSchema: { hmrc_customer_id: hmrcId.describe("HMRC customer id of the charity, e.g. SA12345") },
    annotations: READ,
  },
  safe(async ({ hmrc_customer_id }) => {
    const r = await api.get(`/charities/${hmrc_customer_id}`, undefined, "read:charity");
    return {
      charity: fmt.charity(hmrc_customer_id, r),
      meaning: "warranted is true if the charity has warranted donations from your platform as eligible for Gift Aid, otherwise false (CharityResponse.warranted).",
    };
  }),
);

const byCreatedDesc = (a: { created?: string }, b: { created?: string }) => (Date.parse(b.created ?? "") || 0) - (Date.parse(a.created ?? "") || 0);
const MAX_TOTALS = 12;

server.registerTool(
  "list_charity_claims",
  {
    title: "List a charity's Gift Aid claims",
    description:
      `The Gift Aid claims Swiftaid has made for one charity, newest first. The API returns the whole list in one response (it documents no pagination or filters); created_from and created_to are applied here, locally. With include_totals, each listed claim's report is fetched (at most ${MAX_TOTALS}) and the donations, Gift Aid and overclaim amounts are added up; a report that cannot be read is named in totals_errors and left out of the totals.`,
    inputSchema: {
      hmrc_customer_id: hmrcId.describe("HMRC customer id of the charity, e.g. SA12345"),
      created_from: isoDay.optional().describe("Only claims created on or after this date (YYYY-MM-DD, UTC), filtered locally"),
      created_to: isoDay.optional().describe("Only claims created on or before this date (YYYY-MM-DD, UTC), filtered locally"),
      include_totals: z.boolean().default(false).describe(`Fetch each listed claim's report (at most ${MAX_TOTALS}) and add up the amounts`),
      max_results: z.number().int().min(1).max(500).default(50).describe("Maximum number of claims to list"),
    },
    annotations: READ,
  },
  safe(async ({ hmrc_customer_id, created_from, created_to, include_totals, max_results }) => {
    if (created_from && created_to && created_from > created_to) throw new SwiftaidError(`created_from (${created_from}) is after created_to (${created_to}); no claim can match.`);
    const raw = await api.get(`/charities/${hmrc_customer_id}/claims`, undefined, "read:claim");
    if (!Array.isArray(raw)) throw new SwiftaidError(`Swiftaid answered GET /charities/${hmrc_customer_id}/claims with something other than the documented array of claims.`);
    const from = created_from ? Date.parse(`${created_from}T00:00:00Z`) : -Infinity;
    const to = created_to ? Date.parse(`${created_to}T23:59:59.999Z`) : Infinity;
    const all = raw.map(fmt.claimSummary).sort(byCreatedDesc);
    // A claim whose date cannot be parsed is kept when no date filter is given, and dropped otherwise.
    const inRange = all.filter((c) => {
      if (!created_from && !created_to) return true;
      const t = Date.parse(c.created ?? "");
      return !Number.isNaN(t) && t >= from && t <= to;
    });
    const claims = inRange.slice(0, max_results);
    const out: Record<string, unknown> = {
      hmrc_customer_id,
      claims_on_record: all.length,
      count: claims.length,
      note: inRange.length > claims.length ? `Showing the newest ${claims.length} of ${inRange.length} matching claims; raise max_results to see more.` : undefined,
      claims,
    };
    if (include_totals) {
      const picked = claims.slice(0, MAX_TOTALS);
      // Reports by position in `picked`, so a report is merged into the claim it was requested for.
      const reports: (ReturnType<typeof fmt.claimReport> | undefined)[] = [];
      const errors: { claim_id?: string; error: string }[] = [];
      for (let i = 0; i < picked.length; i++) {
        const id = picked[i].claim_id;
        // The id comes from the API response and goes into a request path: only a plain id is used
        // (".." or "" would otherwise address another, undocumented path).
        if (!id || !SHORT_ID.test(id)) {
          errors.push({ claim_id: id, error: "Swiftaid listed this claim with an id this server cannot use in a request path; its report was not requested." });
          continue;
        }
        try {
          reports[i] = fmt.claimReport(await api.get(`/charities/${hmrc_customer_id}/claims/${id}`, undefined, "read:claim"), false);
        } catch (err) {
          errors.push({ claim_id: id, error: errText(err) });
          // A missing report is about that claim; anything else (auth, rate limit, outage, time budget)
          // would hit the remaining reports too, so they are not requested.
          if (!is404(err)) {
            const rest = picked.slice(i + 1).map((c) => c.claim_id);
            if (rest.length) errors.push({ error: `Stopped after this error; the reports of ${rest.join(", ")} were not requested.` });
            break;
          }
        }
      }
      const read = reports.filter((r): r is ReturnType<typeof fmt.claimReport> => r !== undefined);
      const sum = (k: "donation_count" | "total_donations" | "total_gift_aid" | "overclaim_amount") => read.reduce((s, r) => s + (r[k] ?? 0), 0);
      out.claims = claims.map((c, i) => ({ ...c, ...(reports[i] ?? {}) }));
      const notes = [fmt.AMOUNT_NOTE];
      if (claims.length > picked.length) notes.push(`Only the newest ${picked.length} of the ${claims.length} listed claims were added up; narrow the dates to cover the rest.`);
      if (read.length < picked.length) notes.push(`${picked.length - read.length} of the ${picked.length} claims picked for totals could not be read and are not included (see totals_errors).`);
      out.totals = {
        claims_counted: read.length,
        filed_with_hmrc: read.filter((r) => r.filed_with_hmrc).length,
        donation_count: sum("donation_count"),
        total_donations: sum("total_donations"),
        total_gift_aid: sum("total_gift_aid"),
        overclaim_amount: sum("overclaim_amount"),
        note: notes.join(" "),
      };
      if (errors.length) out.totals_errors = errors;
    }
    return out;
  }),
);

server.registerTool(
  "get_claim",
  {
    title: "Get a Gift Aid claim",
    description:
      "One Gift Aid claim for a charity: when it was created, invoiced and filed with HMRC, the number and total value of donations, the Gift Aid due, any overclaim deducted, and the donation ids included. The HMRC filing receipt (XML) only on request.",
    inputSchema: {
      hmrc_customer_id: hmrcId.describe("HMRC customer id of the charity, e.g. SA12345"),
      claim_id: shortId("Claim", "clm_123abc").describe("Claim id from list_charity_claims"),
      include_filing_receipt: z.boolean().default(false).describe("Include the XML receipt HMRC returned when the claim was filed"),
    },
    annotations: READ,
  },
  safe(async ({ hmrc_customer_id, claim_id, include_filing_receipt }) => {
    const r = await api.get(`/charities/${hmrc_customer_id}/claims/${claim_id}`, undefined, "read:claim");
    return { claim: fmt.claimReport(r, include_filing_receipt), note: fmt.AMOUNT_NOTE };
  }),
);

server.registerTool(
  "get_donor",
  {
    title: "Donor authorisation status",
    description:
      "Whether a donor has an active Gift Aid intermediary authorisation with Swiftaid for the current tax year. Give exactly one of donor_id, email or phone_number; an email or UK mobile number is first looked up to the donor's Swiftaid id. The API returns no donor names or contact details here: only the id and the authorisation flag.",
    inputSchema: {
      donor_id: shortId("Donor", "dnr_0123456").optional().describe("Swiftaid donor id, e.g. dnr_0123456"),
      email: z.string().email().max(254).optional().describe("The donor's email address, to look up their donor id"),
      phone_number: z.string().regex(UK_MOBILE, "Phone numbers must be UK mobile numbers such as +447700900123 or 07700 900123, the pattern the spec uses for donor phone numbers").optional().describe("The donor's UK mobile number, to look up their donor id"),
    },
    annotations: READ,
  },
  safe(async ({ donor_id, email, phone_number }) => {
    const given = [donor_id, email, phone_number].filter((x) => x !== undefined).length;
    if (given !== 1) throw new SwiftaidError("Give exactly one of donor_id, email or phone_number.");
    let id = donor_id;
    let foundBy = "donor_id";
    if (!id) {
      // GET /donors/?type=email|phoneNumber&value=... answers DonorId { id }.
      const type = email ? "email" : "phoneNumber";
      foundBy = type === "email" ? "email" : "phone_number";
      try {
        const r = await api.get("/donors/", { type, value: email ?? phone_number }, "read:donor");
        id = typeof r?.id === "string" && r.id ? r.id : undefined;
      } catch (err) {
        if (is404(err)) throw new SwiftaidError(`No Swiftaid donor account matches that ${type === "email" ? "email address" : "phone number"} (404).`, 404);
        throw err;
      }
      if (!id) throw new SwiftaidError("Swiftaid answered the donor lookup without a donor id.");
      if (!SHORT_ID.test(id)) throw new SwiftaidError("Swiftaid answered the donor lookup with a donor id this server cannot use in a request path.");
    }
    const a = await api.get(`/donors/${id}/authorisation`, undefined, "read:donor");
    return {
      donor_id: id,
      found_by: foundBy,
      active_authorisation: typeof a?.activeAuthorisation === "boolean" ? a.activeAuthorisation : undefined,
      meaning:
        "active_authorisation true means Swiftaid holds the donor's intermediary authorisation for the current tax year, so Gift Aid declarations can be created for their eligible donations; false means the donor must confirm their name and address and agree to the authorisation first.",
    };
  }),
);

server.registerTool(
  "get_declaration",
  {
    title: "Gift Aid declaration for a donation",
    description:
      "The Gift Aid declaration Swiftaid created for one donation: status (declared or reversed), amount, donation date, the nominee's charity reference, whether it was matched retrospectively, and the donor's name. The donor's address and postcode only with include_contact_details. Reading declarations has to be enabled for your platform by Swiftaid.",
    inputSchema: {
      donation_id: donationId.describe("Your platform's donation id, as filed with Swiftaid"),
      include_contact_details: z.boolean().default(false).describe("Include the donor's address lines, city, county and postcode"),
    },
    annotations: READ,
  },
  safe(async ({ donation_id, include_contact_details }) => {
    let d;
    try {
      d = await api.get(`/donations/${donation_id}/declaration`, undefined, "read:declaration");
    } catch (err) {
      if (is404(err)) {
        throw new SwiftaidError(
          `Not found: no Gift Aid declaration for donation ${donation_id} (404). Check the donation id. Swiftaid documents that it does not create a declaration until the donation has a settlement date and is matched to an authorised donor.`,
          404,
        );
      }
      throw err;
    }
    return { declaration: fmt.declaration(d, include_contact_details), note: fmt.AMOUNT_NOTE };
  }),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
  const NAME_RULE = "must not contain digits (Swiftaid rejects names with numeric characters)";

  server.registerTool(
    "create_declaration",
    {
      title: "Register enduring Gift Aid declarations",
      description:
        "Record enduring Gift Aid declarations your platform collected from donors to a charity (POST /declarations), so donations can later refer to them. The charity must have warranted your platform (see get_charity). Swiftaid reports each declaration as accepted or not; an id it already holds comes back as 'duplicate'. Only available when SWIFTAID_ALLOW_WRITES=true.",
      inputSchema: {
        declarations: z
          .array(
            z.object({
              declaration_id: z.string().min(1).max(100).describe("Your unique id for this declaration"),
              hmrc_customer_id: hmrcId.describe("HMRC customer id of the charity the declaration is given to"),
              start_date: dateTime.optional().describe("Start of the period the declaration covers; Swiftaid assumes the start of the tax year four years earlier when omitted"),
              end_date: dateTime.optional().describe("Only when the donor has asked to end the declaration: the date they asked"),
              donor: z.object({
                first_name: z.string().min(1).max(100).describe("Donor's first name"),
                last_name: z.string().min(2).max(100).describe("Donor's last name (at least 2 characters)"),
                address_line_1: z.string().min(1).max(200),
                address_line_2: z.string().max(200).optional(),
                city: z.string().max(100).optional(),
                county: z.string().max(100).optional(),
                postcode: z.string().regex(POSTCODE, "A UK postcode such as GU1 3RT"),
                country: z.string().min(1).max(50).default("UK"),
              }),
              source_ref: z.string().min(1).max(250).describe("Reference to the record of how the declaration was given (a recording, transcript or screenshot), as HMRC requires"),
              request_date: dateTime.optional().describe("When the donor made the declaration"),
            }),
          )
          .min(1)
          .max(25),
      },
      annotations: WRITE,
    },
    safe(async ({ declarations }) => {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const d of declarations) {
        if (/\d/.test(d.donor.first_name) || /\d/.test(d.donor.last_name)) problems.push(`Declaration ${d.declaration_id}: the donor's names ${NAME_RULE}.`);
        if (seen.has(d.declaration_id)) problems.push(`Declaration id ${d.declaration_id} appears twice.`);
        seen.add(d.declaration_id);
      }
      if (problems.length) throw new SwiftaidError(`Not sent. ${problems.join(" ")}`);
      // Body: spec EnduringDeclarations, an array of EnduringDeclaration.
      const body = declarations.map((d) => ({
        id: d.declaration_id,
        hmrcCustomerId: d.hmrc_customer_id,
        ...(d.start_date ? { startDate: d.start_date } : {}),
        ...(d.end_date ? { endDate: d.end_date } : {}),
        donor: {
          firstname: d.donor.first_name,
          lastname: d.donor.last_name,
          addressLine1: d.donor.address_line_1,
          ...(d.donor.address_line_2 ? { addressLine2: d.donor.address_line_2 } : {}),
          ...(d.donor.city ? { city: d.donor.city } : {}),
          ...(d.donor.county ? { county: d.donor.county } : {}),
          postcode: d.donor.postcode,
          country: d.donor.country,
        },
        source: { sourceRef: d.source_ref, ...(d.request_date ? { requestDate: d.request_date } : {}) },
      }));
      const res = await api.post("/declarations", body, "create:declaration");
      if (!Array.isArray(res)) throw unknownOutcome("/declarations", "declarations", "declaration id");
      const results = res.map((r: any) => fmt.writeResult(r, "declarationId"));
      return {
        submitted: body.length,
        accepted: results.filter((r) => r.accepted === true).length,
        results,
      };
    }),
  );

  server.registerTool(
    "create_donation",
    {
      title: "File donations for Gift Aid",
      description:
        "File donations with Swiftaid for Gift Aid processing (POST /donations). Each donation names the donor (Swiftaid donor id, email, UK mobile number, match id or enduring declaration id) and the charity (HMRC customer id, your direct reference, or nominee-handled), in pence. Swiftaid does not create a Gift Aid declaration for a donation until it has a settlement date. Card-based identifiers (PAR, terminal data) and name-and-address donors are not supported here. Swiftaid reports each donation as accepted or not; an id it already holds comes back as 'duplicate'. Only available when SWIFTAID_ALLOW_WRITES=true.",
      inputSchema: {
        donations: z
          .array(
            z.object({
              donation_id: donationId.describe("Your unique id for this donation (up to 50 characters), used for de-duplication"),
              donor_type: z.enum(["uid", "email", "phone", "match", "declaration"]).describe("How the donor is identified"),
              donor_value: z.string().min(1).max(254).describe("The donor id (dnr_...), email address, UK mobile number, match id or declaration id"),
              charity_type: z.enum(["hmrcId", "direct", "nominee"]).describe("How the charity is identified: its HMRC customer id, your direct reference agreed through the Swiftaid dashboard, or nominee-handled"),
              charity_ref: z.string().min(1).max(100).optional().describe("The HMRC customer id (hmrcId) or your reference (direct)"),
              charity_name: z.string().min(1).max(200).optional().describe("Friendly name of the target charity (nominee only)"),
              create_declaration: z.boolean().optional().describe("Nominee only: ask Swiftaid to create a Gift Aid declaration for this donation"),
              file_declaration: z.boolean().optional().describe("Nominee only: ask Swiftaid to create the declaration and file it with HMRC for you"),
              gross_amount_pence: z.number().int().min(1).describe("Gross amount in pence (500 = £5.00)"),
              net_amount_pence: z.number().int().min(1).optional().describe("Amount that reached the charity after fees, in pence; omit when the whole amount reached it"),
              transaction_date: dateTime.describe("When the donation was made"),
              settlement_date: dateTime.optional().describe("When the funds were confirmed as transferred to the charity"),
            }),
          )
          .min(1)
          .max(25),
      },
      annotations: WRITE,
    },
    safe(async ({ donations }) => {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const d of donations) {
        const who = `Donation ${d.donation_id}`;
        if (seen.has(d.donation_id)) problems.push(`Donation id ${d.donation_id} appears twice.`);
        seen.add(d.donation_id);
        if (d.donor_type === "email" && !z.string().email().safeParse(d.donor_value).success) problems.push(`${who}: donor_value is not an email address.`);
        if (d.donor_type === "phone" && !UK_MOBILE.test(d.donor_value)) problems.push(`${who}: donor_value is not a UK mobile number in the form the spec accepts (+447700900123 or 07700 900123).`);
        if (["uid", "match", "declaration"].includes(d.donor_type) && !/^[A-Za-z0-9_-]{1,100}$/.test(d.donor_value)) problems.push(`${who}: a ${d.donor_type} donor_value is an id of letters, digits, _ and -.`);
        if (d.charity_type === "hmrcId" && !HMRC_ID.test(d.charity_ref ?? "")) problems.push(`${who}: charity_ref must be the charity's HMRC customer id, e.g. SA12345.`);
        if (d.charity_type === "direct" && !d.charity_ref) problems.push(`${who}: charity_ref is required for a direct charity reference.`);
        if (d.charity_type === "nominee" && !d.charity_name) problems.push(`${who}: charity_name is required for a nominee-handled donation.`);
        if (d.charity_type !== "nominee" && (d.charity_name || d.create_declaration !== undefined || d.file_declaration !== undefined)) problems.push(`${who}: charity_name, create_declaration and file_declaration only apply to nominee-handled donations.`);
        if (d.charity_type === "nominee" && d.charity_ref) problems.push(`${who}: charity_ref does not apply to a nominee-handled donation; use charity_name.`);
        if (d.net_amount_pence !== undefined && d.net_amount_pence > d.gross_amount_pence) problems.push(`${who}: net_amount_pence cannot exceed gross_amount_pence.`);
      }
      if (problems.length) throw new SwiftaidError(`Not sent. ${problems.join(" ")}`);
      // Body: spec Donations, an array of Donation with a DonorIdentifier and a TransactionIdentifier.
      const body = donations.map((d) => ({
        donationId: d.donation_id,
        donor: { type: d.donor_type, value: d.donor_value },
        transaction:
          d.charity_type === "nominee"
            ? {
                type: "nominee",
                charityName: d.charity_name,
                ...(d.create_declaration !== undefined ? { createDeclaration: d.create_declaration } : {}),
                ...(d.file_declaration !== undefined ? { fileDeclaration: d.file_declaration } : {}),
              }
            : { type: d.charity_type, id: d.charity_ref },
        grossAmount: d.gross_amount_pence,
        ...(d.net_amount_pence !== undefined ? { netAmount: d.net_amount_pence } : {}),
        currency: "GBP",
        transactionDate: d.transaction_date,
        ...(d.settlement_date ? { settlementDate: d.settlement_date } : {}),
      }));
      const res = await api.post("/donations", body, "create:donation");
      if (!Array.isArray(res)) throw unknownOutcome("/donations", "donations", "donation id");
      const results = res.map((r: any) => fmt.writeResult(r, "donationId"));
      const unsettled = donations.filter((d) => !d.settlement_date).map((d) => d.donation_id);
      return {
        submitted: body.length,
        accepted: results.filter((r) => r.accepted === true).length,
        results,
        note: unsettled.length
          ? `No settlement date was given for ${unsettled.join(", ")}: Swiftaid will not create a Gift Aid declaration for these until a settlement date is recorded (PATCH /donations, not covered by this server).`
          : undefined,
      };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Swiftaid MCP server running against ${api.environment} (writes ${allowWrites ? "enabled" : "disabled"}).`);
