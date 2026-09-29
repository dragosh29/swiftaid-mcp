# Swiftaid MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with the Swiftaid Gift Aid API from the side of a donation platform integrated with Swiftaid: the API's health, a charity's on-boarding status, the Gift Aid claims Swiftaid has made for a charity, a donor's Swiftaid authorisation, the Gift Aid declaration behind a donation, and (when enabled) registering enduring declarations and filing donations. It is built from Swiftaid's public developer documentation: the OpenAPI 3.0.3 spec "Swiftaid API" 1.3.1 at `static.swiftaid.co.uk/apis/openapi/external/v1/api.yaml` and the Getting Started, Reference and Go to production pages at [developers.swiftaid.co.uk](https://developers.swiftaid.co.uk).

Once it's connected, someone at the platform can ask things like:

- "Is the Swiftaid sandbox up, and do our credentials still work?"
- "Has the charity SA12345 warranted our donations yet?"
- "How much Gift Aid has Swiftaid claimed for SA12345 since January, and is the September claim filed with HMRC?"
- "Does the donor with jo.example@example.com have an active Swiftaid authorisation this tax year?"
- "Was Gift Aid declared on donation stl_123456, or has it been reversed?"
- With writes enabled: "File these three settled donations to SA12345." / "Register this enduring declaration we took over the phone."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `healthcheck` | Whether the API answers (no token needed) and, by default, whether the auth service issues a token for the configured credentials, environment and scopes. | `GET /healthcheck`, `POST https://auth.streeva.com/oauth2/token` |
| `get_charity` | Whether a charity, by HMRC customer id, has warranted donations from your platform as eligible for Gift Aid. | `GET /charities/{hmrcCustomerId}` |
| `list_charity_claims` | A charity's Gift Aid claims, newest first. Optional date range, applied locally. With `include_totals`, fetches each listed claim's report (at most 12) and adds up donations, Gift Aid and overclaims; a report that cannot be read is named in `totals_errors` and the list is still returned. | `GET /charities/{hmrcCustomerId}/claims`, `/claims/{claimId}` |
| `get_claim` | One claim: created, invoiced and filed dates, whether it is filed with HMRC, donation count and total, Gift Aid due, overclaim, the donation ids. The HMRC filing receipt (XML) only on request. | `GET /charities/{hmrcCustomerId}/claims/{claimId}` |
| `get_donor` | Whether a donor has an active Gift Aid intermediary authorisation, by Swiftaid donor id, or by email or UK mobile number looked up to the id first. The API returns no names or contact details here. | `GET /donors/?type=&value=`, `GET /donors/{donorId}/authorisation` |
| `get_declaration` | The Gift Aid declaration for one donation: status (declared or reversed), amount, date, the nominee's charity reference, retrospective matching, the donor's name. The donor's address and postcode only on request. | `GET /donations/{donationId}/declaration` |
| `create_declaration` | Registers 1 to 25 enduring Gift Aid declarations. Refuses locally names with digits, a malformed postcode or HMRC id, and repeated ids. Writes only. | `POST /declarations` |
| `create_donation` | Files 1 to 25 donations for Gift Aid processing, identifying the donor by donor id, email, UK mobile, match id or declaration id and the charity by HMRC id, direct reference or nominee. Says which donations have no settlement date yet. Writes only. | `POST /donations` |

The spec has no endpoint that lists charities, donations or donors, so there are no such tools. Not covered on purpose: `POST /donors` and `POST /donors/{donorId}/authorisation` (creating donor accounts and authorisations: these carry the donor's name, address and, for card accounts, PAR, BIN, last four digits and expiry), `POST /donors/{donorId}/accounts` (linking card, email and phone accounts), `POST /donors/match` and the experimental `POST /donors/matches` (matching on email, phone, card data and address), `PATCH /declarations/{declarationId}`, `DELETE /declarations/{declarationId}` (which reverses any Gift Aid claimed), `PATCH /donations` (settlement dates) and `DELETE /donations/{donationId}` (cancelling Gift Aid on a donation). `create_donation` does not accept the card-based identifiers (`par` donors, `terminal` transactions) or the name-and-address donor, which the Reference page reserves for data-processor use. The test suite asserts that no endpoint other than the ones in the table is called.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need client credentials from Swiftaid. Sandbox credentials are issued on request by Swiftaid's developer support (dev@swiftaid.co.uk) after you accept the [API terms](https://www.swiftaid.co.uk/legal/terms-api/); production credentials are issued by Swiftaid's engineering team once a partnership agreement is signed ([Go to production](https://developers.swiftaid.co.uk/go-live/) page). The server exchanges them for an access token as the Getting Started page documents: `POST https://auth.streeva.com/oauth2/token` with `Authorization: Basic base64(client_id:client_secret)` and a form body `grant_type=client_credentials`, `audience=<the API address for your environment>` and `scope=<space-separated scopes>`. By default it asks for `read:charity read:claim read:donor read:declaration`, plus `create:declaration create:donation` only when writes are enabled.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swiftaid": {
      "command": "node",
      "args": ["/absolute/path/to/swiftaid-mcp/dist/index.js"],
      "env": { "SWIFTAID_CLIENT_ID": "your-client-id", "SWIFTAID_CLIENT_SECRET": "your-client-secret" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add swiftaid -e SWIFTAID_CLIENT_ID=your-client-id -e SWIFTAID_CLIENT_SECRET=your-client-secret -- node /absolute/path/to/swiftaid-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `SWIFTAID_CLIENT_ID` | yes | Your client ID, sent in the token request's HTTP Basic header. |
| `SWIFTAID_CLIENT_SECRET` | yes | Your client secret, sent in the same header. Never logged or included in an error message. |
| `SWIFTAID_ENV` | no | `sandbox` (default) or `production`. Picks the API address (`https://sandbox.swiftaid.co.uk/integrations/v1` or `https://api.swiftaid.co.uk/integrations/v1`), which is also the token's `audience`. |
| `SWIFTAID_SCOPE` | no | Space-separated scopes to request instead of the defaults, for a client that has not been granted all of them, e.g. `read:charity read:claim`. |
| `SWIFTAID_ALLOW_WRITES` | no | `true` to register `create_declaration` and `create_donation` and request their scopes. Off by default. |
| `SWIFTAID_BASE_URL` | no | Overrides the API address (the token audience still follows `SWIFTAID_ENV`). Used by the tests. |
| `SWIFTAID_TOKEN_URL` | no | Overrides the token endpoint. Used by the tests. |
| `SWIFTAID_TOOL_BUDGET_S` | no | Seconds a tool call may spend before it stops retrying (default 45, see Safety defaults). Lowered by the tests. |

## Safety defaults

- Read-only unless `SWIFTAID_ALLOW_WRITES=true`, and only `read:` scopes are requested on the token unless it is. Read tools carry the MCP `readOnlyHint` annotation. The two write tools create records and are not marked destructive; nothing that deletes, reverses or cancels is implemented.
- Donor names are returned. A donor's address lines, city, county and postcode are only returned when the assistant explicitly asks (`include_contact_details` on `get_declaration`). In free text (the nominee's charity reference, donor names, the `info` and problem details of write results, and Swiftaid's error messages) email addresses are replaced with `[email redacted]`, phone-number-like sequences with `[phone redacted]` and UK postcodes with `[postcode redacted]` by default. These are heuristic patterns: the email and phone ones are the same as this author's Signable and Carebit servers (UK and international phone shapes); postcodes are matched in any letter case and with any spacing (`GU1 3RT`, `gu1 3rt`, `GU1  3RT`), as the spec's own postcode pattern allows, which can also catch a short word pair such as `a1 2nd`. Ids such as `clm_123abc` and `stl_123456` and HMRC ids such as `SA12345` are left alone. `get_donor` never echoes the email or phone number it looked up.
- Card and payment data are never returned. None of the documented read responses carries any, every formatter copies only the documented fields it names, and a card number typed into free text (13 to 19 digits that pass the Luhn check) is replaced with `[card number redacted]` even when contact details were requested. No file is ever downloaded; the HMRC filing receipt is an XML string in the claim response and is only returned on request.
- The access token is held in memory only, refreshed a minute before its `expires_in` runs out (the documented example is 86,400 seconds; a token shorter than two minutes is refreshed after half its life), and fetched afresh once when a call answers 401. The token and the client secret are never logged or put in a tool result; should Swiftaid ever echo either (or the encoded Basic credentials) in a message, the exact value is replaced with `[redacted]`, whatever its length.
- IDs are checked before any call is made: HMRC customer ids against the spec's pattern `^(?:X|[A-Z]{2})\d{1,5}$`; claim and donor ids must be up to 64 letters, digits, `_` and `-`, and donation ids up to 50 (the spec's `maxLength` for `donationId`), because the spec types them as plain strings. The same rule applies to ids that come back from the API before they are put in a path (a claim id from the claims list, a donor id from the lookup), so a value such as `..` never reaches another endpoint. Phone numbers must match the UK-mobile pattern the spec uses for donor phone numbers (the lookup's `value` parameter itself has no pattern). Date filters must be real calendar dates, and `created_from` no later than `created_to`. Write bodies are checked against the spec's rules before posting: no digits in names, `lastname` at least 2 characters, the postcode pattern, `sourceRef` up to 250 characters, declaration ids up to 100, a net amount no larger than the gross, dates as `YYYY-MM-DD` or date-times with `Z` or an offset.
- Rate limits: Swiftaid documents none, and its spec documents no 429 response and no `Retry-After`. Requests are spaced 250 ms apart as a polite guess. A 429 is still retried at most twice for any method, including both `POST`s and the token request, on the assumption that a rate-limited request was not processed, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s without it, and 4 s before a third attempt, which the tests do not exercise). A `Retry-After` longer than 10 seconds makes that request give up at once with the wait in the message, so one request waits at most about 20 seconds. A tool call can make several requests (a token request, `get_donor`'s lookup and authorisation check, `list_charity_claims`' report fetches), so each tool call also has a 45-second budget (`SWIFTAID_TOOL_BUDGET_S`): a retry whose wait would end after it is not attempted, and the request fails saying so. 45 seconds is chosen to leave room for the last request under the MCP client's default 60-second timeout; the tests check the mechanism with a 4-second budget, not the 60-second outcome. `list_charity_claims` with `include_totals` then still returns the claims list and the totals read so far, and names the claims it did not add up.
- 502, 503 and 504 are retried the same way for `GET` and for the token request only. A `POST /declarations` or `POST /donations` is never retried after a gateway error, because it may already have been processed; the error says to send it again with the same ids, which Swiftaid reports as `duplicate` if it already holds them (as the spec's response examples show). A `GET` that fails three times says the service may be unavailable, without the gateway's HTML.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `SWIFTAID_ENV` / `SWIFTAID_BASE_URL`, never as an empty result. A write answered 200 with something other than the documented array of per-item results is an error saying the outcome is unknown and to resend with the same ids, never "0 accepted".
- Rejected client credentials produce a message naming the variables to check and the environment; a token refused by the API even after a refresh says to check that `SWIFTAID_ENV` matches the credentials; a 403 names the scope the operation needs (from the spec's `security` block); a 404 says the record does not exist for your client, with a specific explanation for donor lookups and declarations; a 400 or 409 passes on Swiftaid's problem details (`title`, `detail`, `errors`), redacted.

## Tests

```bash
npm test
```

The test suite (35 checks, 116 requests, about 40 seconds):

1. Validates every fixture record against the component schemas in Swiftaid's published spec (`CharityResponse`, `ClaimIndex`, `ClaimSummary`, `ClaimReport`, `GiftAidDeclaration`, `UserState`, `Authorisation`) with Ajv 2020 and ajv-formats, including negative controls. The spec's `oneOf` + `discriminator` schemas (`DonorIdentifier`, `TransactionIdentifier`, `Account`) are resolved the way the discriminator mapping says, because their branches carry no `const` on `type` and a plain `oneOf` would match several of them; a check proves the resolution rejects a bad phone value, a missing value and an unknown type. The spec is downloaded to `spec.yaml` on the first run if it is missing.
2. Starts a local mock of the sandbox API under `/integrations/v1` and of the token endpoint, and checks its answers against the documentation: the token response has exactly the three documented keys; the record and list responses validate against each operation's documented response schema; the documented 401 and 404 of the `GET` operations have no body (the spec defines none); `GET /healthcheck` needs no token; the write responses validate against `BatchDeclarationResponse` and `DonationsResponse`, with a repeated id answered `duplicate` as in the spec's examples; and the 400 `BadRequestDetailed` example is served verbatim. That example contradicts the spec's own `ProblemDetails` schema in exactly one place, which the check asserts: `status` is typed as a string and given as a number.
3. Starts the built server and drives it over stdio with the official MCP client, 33 checks: tool list and annotations; the token request (HTTP Basic computed at runtime, form body with exactly `grant_type`, `audience` and `scope`, read scopes only unless writes are on, the scope list from `SWIFTAID_SCOPE` when set), the token reused across calls, replaced once after a 401 and refreshed before a short `expires_in` runs out; the token and the client secret scrubbed from error messages that echo them; `GET /healthcheck` without a token; every read tool; the claims list fetched in one request with no query parameters (the spec documents no pagination and no filters) and sorted, filtered and totalled locally, with impossible dates and an inverted range refused; `include_totals` capped at 12 report requests with a note when more claims are listed, ids such as `..` and `""` from the API never used in a path, a report answering 404 named in `totals_errors` while the list and the other totals are kept; `type` and `value` passed to `GET /donors/` exactly as documented for email and phone lookups; donor names returned and address and postcode withheld by default and returned on request; emails, phone numbers (UK and `+44` forms) and postcodes (upper, lower and mixed case, and with two spaces) redacted from the nominee reference, donor names, write results and error messages by default, with HMRC and claim ids left alone, and names returned as stored on request; card fields injected into a response (undocumented, for this check only) and a Luhn-valid card number never returned, even with contact details requested; both write bodies validated against the spec's request schemas (`EnduringDeclarations`, `Donations` and each donor and transaction branch); the write gate with the variable unset and set to `false`; local refusal of invalid write content and invalid ids with no request made; clear 404 messages; a 403 naming the missing scope; `invalid_scope` from the token endpoint; wrong credentials reported without echoing the secret; `SWIFTAID_ENV=production` requesting the production audience and the resulting 401 explained; the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms and 2 s without the header, giving up at once above the cap (the message naming the API path) and after three attempts on a persistent 429; a 429 on `POST /donations` retried once and the donation filed once; a 429 then a 503 on the token request retried; a tool call giving up at its time budget (lowered to 4 s for the check) with `include_totals` keeping the list and naming the claims not added up; a 502 retried for `GET` and never for either `POST`; a write answered 200 without the documented array reported as an unknown outcome; three 503s reported with advice and without HTML; a non-JSON 200 reported as an error; a 400 and the documented 409 with problem details passed on redacted; and that every request either went to the token endpoint with Basic auth and no credentials in the body or query, or went to `GET /healthcheck` without auth, or carried a Bearer token the mock had issued, to a documented method and path, with the set of endpoints used asserted exactly.

## Status

This is a working prototype. It has **not yet been run against the live API or the sandbox**, because it was built without Swiftaid credentials (sandbox credentials are issued on request, not self-serve). Everything below is taken from the published spec and documentation and should be confirmed on a sandbox account:

- The token endpoint: that the form body with `audience` and `scope` and the Basic header are accepted exactly as the Getting Started page shows; whether the response carries anything beyond `access_token`, `token_type` and `expires_in`; and the status and body for wrong credentials and for a scope the client has not been granted. The mock answers OAuth 2.0's `401 invalid_client` and `400 invalid_scope`; Swiftaid documents neither.
- Which scopes a sandbox client is granted, and whether requesting a scope it lacks fails the token request (as the mock does) or silently narrows the token.
- Whether a token issued for one environment's audience is refused by the other environment with a 401 (as the mock does).
- The bodies of the error responses. The spec defines no content for the `GET` operations' 400, 401, 403 and 404 or for `POST /donations`' 400; the mock sends empty bodies, and the server's messages do not depend on a body.
- `GET /charities/{hmrcCustomerId}` for a charity Swiftaid does not know: the spec documents 200, 400, 401, 403 and 500 but no 404. The mock answers 404; the real API may answer 200 with `warranted: false` or a 400.
- `GET /charities/{hmrcCustomerId}/claims` for a charity with many claims: the spec documents no pagination, so the server assumes the whole list arrives in one response. The sort order is not documented; the server sorts by `createdDate`, newest first.
- The unit of the claim amounts (`totalDonations`, `totalGiftAid`, `overclaimAmount`) and of the declaration `amount`: the donation schema and the Reference page say amounts are in pence (500 = £5.00); the claim and declaration schemas do not restate it, and the tools return the integers as given with that note.
- `GET /donors/?type=phoneNumber`: whether the lookup matches a number written differently from the stored one (`07700 900456` against `+447700900456`); the server sends the value as given. The spec's path has a trailing slash (`/donors/`), which is what the server calls; the Getting Started example calls `/donors` without it.
- `GET /donations/{donationId}/declaration`: that reading declarations has to be enabled for the platform (the Reference page says so), what the API answers when it is not (the server's message assumes a 404), and the `donatedOn` format: the Reference page's example (`2018-07-17T10:02:34`) has no time zone, which the spec's own `format: date-time` does not allow. The server passes the value through as returned.
- `POST /declarations`: the body follows the spec's `EnduringDeclaration` schema (`source: { sourceRef, requestDate }`); the Reference page's example uses a different, flat shape (`sourceRef` and `createdDate` at the top level). Which one the API accepts must be checked. Also whether `startDate` and `requestDate` accept a bare midnight UTC time as the server sends for a `YYYY-MM-DD` input, and how an item rejected for a missing warrant is reported.
- `POST /donations`: that the per-item results come back as documented (`accepted`, `info`, `duplicate` for a known id), whether a repeated POST after a lost response is really answered `duplicate` rather than filed twice (the server's advice after a gateway error relies on it), and the nominee `createDeclaration` / `fileDeclaration` behaviour.
- A 429 on either `POST` is retried on the assumption that a rate-limited request was not processed; Swiftaid documents no 429 at all.
- The HMRC customer id format. The server checks the spec's pattern `^(?:X|[A-Z]{2})\d{1,5}$` (X or two capital letters, then 1 to 5 digits), but the Reference page says the customer number is "1 or 2 letters followed by up to 5 numbers". If the Reference page is right, the spec's pattern (and so this server) refuses real ids with a single letter other than X.
- What `GET /healthcheck` returns: the spec documents a 200 with no body and no security requirement; the server sends no token and reports the status and the first 200 characters of any body.
- How many requests per second the API tolerates; nothing is documented, so the 250 ms spacing is a guess.

## Going to production

This version runs locally over stdio, with the platform's own client credentials. For Swiftaid's partners to connect from claude.ai or ChatGPT without handling credentials, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Swiftaid, and then a listing in the Claude and ChatGPT connector directories. A production version, tested on the sandbox, would also cover setting settlement dates (`PATCH /donations`), updating and ending enduring declarations, and, with Swiftaid's guidance, the donor authorisation and matching endpoints, whose bodies carry personal and card data.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
