export function parseMoney(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function normalizeSector(raw: string | undefined | null): string {
  if (!raw) return "Unknown";
  const trimmed = String(raw).trim();
  if (trimmed === "") return "Unknown";
  return trimmed;
}

export function normalizeStatus(raw: string | undefined | null): string {
  if (!raw) return "Unspecified";
  const trimmed = String(raw).trim();
  if (trimmed === "") return "Unspecified";
  return trimmed;
}

export function normalizeBillingStatus(raw: string | undefined | null): string {
  const s = normalizeStatus(raw);
  if (s.toLowerCase() === "billed") return "Billed";
  return s;
}

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

export function looksLikeHeaderRow(fields: Record<string, string>): boolean {
  const suspiciousExactMatches = Object.entries(fields).filter(
    ([col, val]) => val.trim() !== "" && val.trim() === col.trim()
  );
  return suspiciousExactMatches.length >= 2;
}
