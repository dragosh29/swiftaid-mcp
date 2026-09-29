// Turn Swiftaid API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Swiftaid's OpenAPI spec (CharityResponse, ClaimSummary,
// ClaimReport, GiftAidDeclaration, AuthorisationInfo, Authorisation, DonorId, DeclarationResponse,
// DonationResponse). Every formatter copies the documented fields it names and nothing else, so a
// field the API might add later (card data, say) is never passed on.

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic (the same pattern as the Signable and Carebit servers).
// Three shapes, digits optionally separated by a space, dot or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so ids such as clm_123abc and
// stl_123456, timestamps and hyphenated references such as INV-123 are left alone.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;
// UK postcodes in any letter case (GU1 3RT, gu1 3rt, SW1A 1AA, M1 1AE, EC1A1BB, GU1  3RT): one or two
// letters, a digit, an optional letter or digit, any white space (as the spec's AuthorisationInfo.postcode
// pattern allows), a digit and two letters of the inward-code alphabet (no C, I, K, M, O or V), not
// touching other letters or digits. The same shape as the Citizen Space server. HMRC customer ids
// (SA12345) and ids such as clm_123abc do not match; a short word pair such as "a1 2nd" can, which
// errs on the side of hiding too much.
const POSTCODE = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[ABD-HJLNP-UW-Zabd-hjlnp-uw-z]{2}(?![A-Za-z0-9])/g;
// A payment card number typed into free text: 13 to 19 digits, optionally grouped by spaces or
// hyphens, that pass the Luhn check. Replaced whether or not contact details were requested: this
// server never returns card data. The API's documented read responses carry no card fields at all.
const CARD = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;
const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) n = n > 4 ? n * 2 - 9 : n * 2;
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
};
const redactCards = (text: string) => text.replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number redacted]" : m));
const redactString = (text: string) => redactCards(text).replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]").replace(POSTCODE, "[postcode redacted]");

/**
 * Replace email addresses, phone-number-like sequences and UK postcodes inside free text (names, the
 * nominee charity reference, the info strings of write results, Swiftaid's error messages) unless
 * contact details were requested. Luhn-valid card numbers are replaced either way.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? redactCards(text) : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

export const AMOUNT_NOTE =
  "Amounts are integers as returned by Swiftaid. Its donation documentation says amounts are in currency units, i.e. pence for GBP (500 = £5.00); the claim and declaration schemas do not restate the unit.";

// GET /charities/{hmrcCustomerId}: CharityResponse { warranted }.
export function charity(hmrcCustomerId: string, r: Rec) {
  return { hmrc_customer_id: hmrcCustomerId, warranted: bool(r?.warranted) };
}

// GET /charities/{hmrcCustomerId}/claims: ClaimIndex, an array of ClaimSummary { id, createdDate }.
export function claimSummary(c: Rec) {
  return { claim_id: str(c?.id), created: str(c?.createdDate) };
}

// GET /charities/{hmrcCustomerId}/claims/{claimId}: ClaimReport. The HMRC filing receipt is an XML
// fragment and only returned on request; the donation ids are the platform's own references.
export function claimReport(r: Rec, includeReceipt: boolean) {
  const donations = Array.isArray(r?.donations) ? r.donations.map(str).filter((x: string | undefined): x is string => x !== undefined) : [];
  const receipt = str(r?.filingReceipt);
  return {
    claim_id: str(r?.id),
    invoice_id: str(r?.invoiceId),
    created: str(r?.createdDate),
    invoiced: str(r?.invoicedDate),
    filed: str(r?.filedDate),
    // ClaimReport.filedDate: "The date and time this claim was submitted to HMRC and accepted".
    filed_with_hmrc: r?.filedDate ? true : false,
    donation_count: int(r?.countDonations),
    total_donations: int(r?.totalDonations),
    total_gift_aid: int(r?.totalGiftAid),
    overclaim_amount: int(r?.overclaimAmount),
    donation_ids: donations,
    has_filing_receipt: receipt !== undefined,
    ...(includeReceipt ? { filing_receipt: receipt } : {}),
  };
}

// AuthorisationInfo, as it appears in GiftAidDeclaration.donor. Names are returned (minus any email,
// phone number or postcode typed into them); the address lines, city, county and postcode only on
// request. The country is returned: the API only handles UK addresses.
export function donor(d: Rec | undefined, includeContact: boolean) {
  if (!d || typeof d !== "object") return undefined;
  return {
    first_name: redactContacts(d.firstname, includeContact),
    last_name: redactContacts(d.lastname, includeContact),
    country: str(d.country),
    ...(includeContact
      ? {
          address_line_1: str(d.addressLine1),
          address_line_2: str(d.addressLine2),
          city: str(d.city),
          county: str(d.county),
          postcode: str(d.postcode),
        }
      : {}),
  };
}

// GET /donations/{donationId}/declaration: GiftAidDeclaration.
export function declaration(d: Rec, includeContact: boolean) {
  return {
    donation_id: str(d?.donationId),
    status: str(d?.status),
    amount: int(d?.amount),
    currency: str(d?.currency),
    donated_on: str(d?.donatedOn),
    nominee_charity_ref: redactContacts(d?.nomineeCharityRef, includeContact),
    matched_retrospectively: bool(d?.matchedRetrospectively),
    donor: donor(d?.donor, includeContact),
  };
}

// POST /declarations answers BatchDeclarationResponse, POST /donations answers DonationsResponse:
// one { id, accepted, info, problemDetails? } per item. info and the problem details are free text,
// which could echo a submitted name or postcode, so they go through the redaction.
export function writeResult(r: Rec, idKey: "declarationId" | "donationId") {
  const pd = r?.problemDetails && typeof r.problemDetails === "object" ? r.problemDetails : undefined;
  const errors = Array.isArray(pd?.errors) ? pd.errors.map((e: unknown) => redactContacts(e, false)).filter(Boolean) : undefined;
  return {
    [idKey === "declarationId" ? "declaration_id" : "donation_id"]: str(r?.[idKey]),
    accepted: bool(r?.accepted),
    info: redactContacts(r?.info, false),
    problem: pd ? [redactContacts(pd.title, false), redactContacts(pd.detail, false)].filter(Boolean).join(": ") || undefined : undefined,
    errors: errors && errors.length ? errors : undefined,
  };
}
