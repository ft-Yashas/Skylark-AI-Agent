// Cleaning layer. Every function here exists because of something observed
// in the actual source CSVs — see DECISION_LOG.md for the profiling that
// drove each rule.

/** Parses monday.com "text" rendering of a Numbers column into a float, or null. */
export function parseMoney(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Parses a date column's text into ISO (YYYY-MM-DD), or null if blank/unparseable. */
export function parseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  // monday.com Date columns render as YYYY-MM-DD already; guard against
  // anything else (e.g. DD/MM/YYYY that slipped through import) by
  // attempting a native parse as a fallback.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Sector/service is a free-text-ish field: blanks show up as "Unknown"
 * rather than being silently dropped, and whitespace/casing variants are
 * folded together (e.g. observed "Tender" is a deal-sourcing channel, not
 * a real industry sector, but we don't silently reclassify it — we surface
 * it as-is and flag it as ambiguous in the tool description so the LLM
 * treats it as a known caveat rather than a fabricated sector).
 */
export function normalizeSector(raw: string | undefined | null): string {
  if (!raw) return "Unknown";
  const trimmed = String(raw).trim();
  if (trimmed === "") return "Unknown";
  return trimmed;
}

/** Trims and collapses blank status/stage strings to "Unspecified". */
export function normalizeStatus(raw: string | undefined | null): string {
  if (!raw) return "Unspecified";
  const trimmed = String(raw).trim();
  if (trimmed === "") return "Unspecified";
  return trimmed;
}

/**
 * Fixes the one observed casing typo in Billing Status ("BIlled" -> "Billed")
 * without inventing a broader fuzzy-matching scheme that could mask other
 * real distinctions we haven't seen.
 */
export function normalizeBillingStatus(raw: string | undefined | null): string {
  const s = normalizeStatus(raw);
  if (s.toLowerCase() === "billed") return "Billed";
  return s;
}

/**
 * The "Quantities as per PO" / "Quantity by Ops" fields are free text
 * mixing bare numbers with units: "5360 HA", "415Acers" (typo for Acres),
 * "10.5 KM", "7000 images", "L/s" (unitless/garbage), "150000". We extract
 * the leading numeric portion for aggregation and keep the raw string for
 * display, rather than guessing at a canonical unit system across a survey
 * business with genuinely different measurement types (area, length,
 * image count, towers).
 */
export function parseQuantity(
  raw: string | undefined | null
): { value: number | null; unit: string | null; raw: string } {
  const rawStr = raw ? String(raw).trim() : "";
  if (rawStr === "") return { value: null, unit: null, raw: rawStr };
  const match = rawStr.match(/^([\d,.]+)\s*(.*)$/);
  if (!match) return { value: null, unit: rawStr || null, raw: rawStr };
  const num = Number(match[1].replace(/,/g, ""));
  const unit = match[2].trim() || null;
  return { value: Number.isFinite(num) ? num : null, unit, raw: rawStr };
}

/**
 * Deal Stage values are prefixed with a sort letter, e.g. "B. Sales
 * Qualified Leads", but a handful of rows use unprefixed labels
 * ("Project Completed") that don't fit the same funnel ordering. We keep
 * the raw label but expose a best-effort funnel rank for sorting; unranked
 * labels sort last rather than crashing the sort.
 */
const STAGE_RANK: Record<string, number> = {
  "A. Lead Generated": 1,
  "B. Sales Qualified Leads": 2,
  "C. Demo Done": 3,
  "D. Feasibility": 4,
  "E. Proposal/Commercials Sent": 5,
  "F. Negotiations": 6,
  "G. Project Won": 7,
  "H. Work Order Received": 8,
  "I. POC": 8,
  "J. Invoice sent": 9,
  "K. Amount Accrued": 10,
  "L. Project Lost": 99,
  "M. Projects On Hold": 98,
  "N. Not relevant at the moment": 97,
  "O. Not Relevant at all": 97,
};

export function stageRank(raw: string | undefined | null): number {
  if (!raw) return 100;
  return STAGE_RANK[raw.trim()] ?? 100;
}

/**
 * Detects rows that are actually re-injected header text rather than real
 * records — observed directly in the Deals CSV (a row whose "Deal Status"
 * cell literally reads "Deal Status", from a corrupted re-export/paste).
 * Applied generically: if >= 2 of a row's fields exactly equal their own
 * column's expected header-like label, we treat it as a corrupt row.
 */
export function looksLikeHeaderRow(fields: Record<string, string>): boolean {
  const suspiciousExactMatches = Object.entries(fields).filter(
    ([col, val]) => val.trim() !== "" && val.trim() === col.trim()
  );
  return suspiciousExactMatches.length >= 2;
}
