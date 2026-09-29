// Fake Swiftaid data shaped exactly like the schemas in the published OpenAPI spec (validated in
// e2e.mjs). Values follow the spec's and the Reference page's examples where they give one; names,
// emails and phone numbers are fictional (example.com / example.org, Ofcom's 07700 900xxx drama range).

// The sandbox's pre-enrolled test charity (Reference > Importing enduring Gift Aid declarations).
export const WARRANTED = "SA12345";
// A charity that has not warranted donations from the platform, and has no claims.
export const NOT_WARRANTED = "AB123";

// CharityResponse, keyed by HMRC customer id.
export const charities = {
  [WARRANTED]: { warranted: true },
  [NOT_WARRANTED]: { warranted: false },
};

// ClaimIndex (an array of ClaimSummary), keyed by HMRC customer id, oldest first as stored. The first
// two entries are the spec's ClaimIndex example verbatim.
export const claims = {
  [WARRANTED]: [
    { id: "clm_123abc", createdDate: "2021-09-01T23:59:59Z" },
    { id: "clm_456xyz", createdDate: "2021-10-01T23:59:59Z" },
    { id: "clm_2026aug", createdDate: "2026-08-03T09:00:00Z" },
    { id: "clm_2026sep", createdDate: "2026-09-01T09:00:00Z" },
  ],
  [NOT_WARRANTED]: [],
};

export const RECEIPT = '<SuccessResponse xmlns="http://www.govtalk.gov.uk/CM/envelope"><Message>Thank you for your submission (fake receipt for tests)</Message></SuccessResponse>';

// ClaimReport, keyed by claim id. clm_123abc uses the spec's field examples (INV-123, 2 donations,
// 980 donated, 245 Gift Aid, 100 overclaim, stl_123456 and stl_123457). clm_2026sep is not filed yet.
export const claimReports = {
  clm_123abc: {
    id: "clm_123abc", invoiceId: "INV-123", createdDate: "2021-09-01T23:59:59Z", invoicedDate: "2021-09-02T01:00:00.000Z", filedDate: "2021-09-02T01:00:00.000Z",
    countDonations: 2, totalDonations: 980, totalGiftAid: 245, overclaimAmount: 100, filingReceipt: RECEIPT, donations: ["stl_123456", "stl_123457"],
  },
  clm_456xyz: {
    id: "clm_456xyz", invoiceId: "INV-124", createdDate: "2021-10-01T23:59:59Z", invoicedDate: "2021-10-02T01:00:00.000Z", filedDate: "2021-10-02T01:00:00.000Z",
    countDonations: 3, totalDonations: 1500, totalGiftAid: 375, overclaimAmount: 0, filingReceipt: RECEIPT, donations: ["stl_200001", "stl_200002", "stl_200003"],
  },
  clm_2026aug: {
    id: "clm_2026aug", invoiceId: "INV-310", createdDate: "2026-08-03T09:00:00Z", invoicedDate: "2026-08-04T09:00:00Z", filedDate: "2026-08-04T10:00:00Z",
    countDonations: 1, totalDonations: 2000, totalGiftAid: 500, overclaimAmount: 0, filingReceipt: RECEIPT, donations: ["stl_300001"],
  },
  clm_2026sep: {
    id: "clm_2026sep", createdDate: "2026-09-01T09:00:00Z", countDonations: 2, totalDonations: 1000, totalGiftAid: 250, overclaimAmount: 0, donations: ["stl_400001", "stl_400002"],
  },
};

// GiftAidDeclaration, keyed by donation id. stl_123456 is the Reference page's example, with a "Z"
// added to donatedOn: the example's "2018-07-17T10:02:34" has no time zone, which the spec's own
// format: date-time does not allow. stl_123457 is reversed and has contact details typed into the
// nominee's charity reference, to exercise the free-text redaction.
export const declarations = {
  stl_123456: {
    donationId: "stl_123456",
    donor: { firstname: "Bob", lastname: "Smith", addressLine1: "Unit 1", addressLine2: "1 High Street", city: "Guildford", county: "Surrey", postcode: "GU1 1AA", country: "UK" },
    nomineeCharityRef: "Local Church",
    status: "declared",
    amount: 470,
    currency: "GBP",
    donatedOn: "2018-07-17T10:02:34Z",
    matchedRetrospectively: false,
  },
  stl_123457: {
    donationId: "stl_123457",
    donor: { firstname: "Priya", lastname: "Example", addressLine1: "14 High Street", addressLine2: "Town Centre", city: "Guildford", county: "Surrey", postcode: "GU1 3RT", country: "UK" },
    nomineeCharityRef: "Local Church SA12345, ref clm_123abc (queries 07700 900123 or giving@example.org, GU1 3RT)",
    status: "reversed",
    amount: 510,
    currency: "GBP",
    donatedOn: "2026-08-20T18:30:00Z",
    matchedRetrospectively: true,
  },
};

// GET /donors/?type=&value= lookups (DonorId) and GET /donors/{donorId}/authorisation (Authorisation).
export const donorLookups = {
  "email:sam.example@example.com": { id: "dnr_0123456" },
  "phoneNumber:+447700900456": { id: "dnr_0123456" },
  "email:jo.example@example.com": { id: "dnr_0999999" },
};
export const authorisations = {
  dnr_0123456: { activeAuthorisation: true },
  dnr_0999999: { activeAuthorisation: false },
};

// Ids Swiftaid already holds, so a repeat submission is answered "duplicate" as the spec's examples show.
export const existingDeclarationIds = ["dec_123456"];
export const existingDonationIds = ["stl_123456"];
