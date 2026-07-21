import { getBoardItems, MondayItem } from "./monday";
import {
  parseMoney,
  parseDate,
  normalizeSector,
  normalizeStatus,
  normalizeBillingStatus,
  parseQuantity,
  stageRank,
  looksLikeHeaderRow,
} from "./clean";

// ---------- Cleaned record shapes ----------

export type CleanWorkOrder = {
  itemId: string;
  dealNameMasked: string;
  customerCode: string;
  serial: string;
  natureOfWork: string;
  executionStatus: string;
  sector: string;
  typeOfWork: string;
  dateOfPO: string | null;
  probableStartDate: string | null;
  probableEndDate: string | null;
  dataDeliveryDate: string | null;
  lastInvoiceDate: string | null;
  amountExclGST: number | null;
  amountInclGST: number | null;
  billedValueInclGST: number | null;
  collectedAmountInclGST: number | null;
  amountReceivable: number | null;
  quantityOrdered: ReturnType<typeof parseQuantity>;
  quantityBilled: ReturnType<typeof parseQuantity>;
  invoiceStatus: string;
  billingStatus: string;
  woStatus: string;
  bdOwnerCode: string;
};

export type CleanDeal = {
  itemId: string;
  dealName: string;
  ownerCode: string;
  clientCode: string;
  dealStatus: string;
  sector: string;
  dealStage: string;
  dealStageRank: number;
  product: string;
  dealValue: number | null;
  closureProbability: string;
  createdDate: string | null;
  tentativeCloseDate: string | null;
  actualCloseDate: string | null;
};

export type DataQualityNote = string;

/**
 * Looks up a field by title, tolerating the exact-title variance observed
 * across different monday.com imports of the same CSV (e.g. some imports
 * mapped "Masked Deal value" onto a pre-existing generic "Deal Value"
 * column instead of creating a new one titled after the CSV header;
 * "Client Code" vs "Client code" differ only in casing). Tries each
 * candidate title in order and returns the first one present on the item.
 */
function pick(fields: Record<string, string>, ...candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (fields[c] !== undefined) return fields[c];
  }
  return undefined;
}

// ---------- Fetch + clean ----------

let workOrdersCache: { data: CleanWorkOrder[]; notes: DataQualityNote[] } | null = null;
let dealsCache: { data: CleanDeal[]; notes: DataQualityNote[] } | null = null;

function requireBoardId(envVar: string): string {
  const id = process.env[envVar];
  if (!id) throw new Error(`${envVar} is not set in the environment.`);
  return id;
}

export async function getCleanWorkOrders(): Promise<{
  data: CleanWorkOrder[];
  notes: DataQualityNote[];
}> {
  if (workOrdersCache) return workOrdersCache;

  const boardId = requireBoardId("MONDAY_WORK_ORDERS_BOARD_ID");
  const items = await getBoardItems(boardId);

  let droppedHeaderRows = 0;
  let missingSector = 0;
  let missingAmount = 0;
  let missingDates = 0;

  const data: CleanWorkOrder[] = [];
  for (const item of items) {
    const f = item.fields;
    if (looksLikeHeaderRow(f)) {
      droppedHeaderRows++;
      continue;
    }

    const sector = normalizeSector(f["Sector"]);
    if (sector === "Unknown") missingSector++;

    const amountInclGST = parseMoney(f["Amount in Rupees (Incl of GST) (Masked)"]);
    if (amountInclGST === null) missingAmount++;

    const dateOfPO = parseDate(f["Date of PO/LOI"]);
    if (dateOfPO === null) missingDates++;

    data.push({
      itemId: item.id,
      dealNameMasked: f["Deal name masked"] ?? item.name,
      customerCode: f["Customer Name Code"] ?? "",
      serial: f["Serial #"] ?? "",
      natureOfWork: f["Nature of Work"] ?? "",
      executionStatus: normalizeStatus(f["Execution Status"]),
      sector,
      typeOfWork: f["Type of Work"] ?? "",
      dateOfPO,
      probableStartDate: parseDate(f["Probable Start Date"]),
      probableEndDate: parseDate(f["Probable End Date"]),
      dataDeliveryDate: parseDate(f["Data Delivery Date"]),
      lastInvoiceDate: parseDate(f["Last invoice date"]),
      amountExclGST: parseMoney(f["Amount in Rupees (Excl of GST) (Masked)"]),
      amountInclGST,
      billedValueInclGST: parseMoney(f["Billed Value in Rupees (Incl of GST.) (Masked)"]),
      collectedAmountInclGST: parseMoney(f["Collected Amount in Rupees (Incl of GST.) (Masked)"]),
      amountReceivable: parseMoney(f["Amount Receivable (Masked)"]),
      quantityOrdered: parseQuantity(f["Quantities as per PO"]),
      quantityBilled: parseQuantity(f["Quantity billed (till date)"]),
      invoiceStatus: normalizeStatus(f["Invoice Status"]),
      billingStatus: normalizeBillingStatus(f["Billing Status"]),
      woStatus: normalizeStatus(f["WO Status (billed)"]),
      bdOwnerCode: f["BD/KAM Personnel code"] ?? "",
    });
  }

  const notes: DataQualityNote[] = [];
  if (droppedHeaderRows > 0)
    notes.push(`${droppedHeaderRows} row(s) were corrupted re-injected header rows and were excluded.`);
  if (missingSector > 0)
    notes.push(`${missingSector} work order(s) have no Sector recorded (shown as "Unknown").`);
  if (missingAmount > 0)
    notes.push(`${missingAmount} work order(s) have no deal amount recorded.`);
  if (missingDates > 0)
    notes.push(`${missingDates} work order(s) have no PO/LOI date recorded.`);
  notes.push(
    `"Collection status" and "Collection Date" are empty for effectively all rows in this dataset — collections tracking appears unmaintained on this board.`
  );
  notes.push(
    `"Quantity"-type fields mix units (acres, HA, KM, image counts, towers) and cannot be summed meaningfully across rows without knowing the service type — treat quantity totals as per-unit-type only.`
  );

  workOrdersCache = { data, notes };
  return workOrdersCache;
}

export async function getCleanDeals(): Promise<{
  data: CleanDeal[];
  notes: DataQualityNote[];
}> {
  if (dealsCache) return dealsCache;

  const boardId = requireBoardId("MONDAY_DEALS_BOARD_ID");
  const items = await getBoardItems(boardId);

  let droppedHeaderRows = 0;
  let missingSector = 0;
  let missingValue = 0;

  const data: CleanDeal[] = [];
  for (const item of items) {
    const f = item.fields;
    if (looksLikeHeaderRow(f)) {
      droppedHeaderRows++;
      continue;
    }

    const sector = normalizeSector(f["Sector/service"]);
    if (sector === "Unknown") missingSector++;

    const dealValue = parseMoney(pick(f, "Masked Deal value", "Deal Value"));
    if (dealValue === null) missingValue++;

    const dealStage = normalizeStatus(pick(f, "Deal Stage", "Stage"));

    data.push({
      itemId: item.id,
      dealName: f["Deal Name"] ?? item.name,
      ownerCode: f["Owner code"] ?? "",
      clientCode: pick(f, "Client Code", "Client code") ?? "",
      dealStatus: normalizeStatus(f["Deal Status"]),
      sector,
      dealStage,
      dealStageRank: stageRank(dealStage),
      product: f["Product deal"]?.trim() || "Unspecified",
      dealValue,
      closureProbability: normalizeStatus(f["Closure Probability"]),
      createdDate: parseDate(f["Created Date"]),
      tentativeCloseDate: parseDate(f["Tentative Close Date"]),
      actualCloseDate: parseDate(pick(f, "Close Date (A)", "Close Date")),
    });
  }

  const notes: DataQualityNote[] = [];
  if (droppedHeaderRows > 0)
    notes.push(`${droppedHeaderRows} row(s) were corrupted re-injected header rows and were excluded.`);
  if (missingSector > 0)
    notes.push(`${missingSector} deal(s) have no Sector/service recorded (shown as "Unknown").`);
  if (missingValue > 0)
    notes.push(`${missingValue} deal(s) have no deal value recorded — likely early-funnel leads not yet sized.`);
  notes.push(
    `"Deal Name" is a masked label, not a unique deal ID — the same name (e.g. "Sakura") repeats across many unrelated deals/companies. Don't treat name matches as identity.`
  );
  notes.push(
    `Client Code on this board (e.g. "COMPANY089") uses a different numbering scheme than Customer Name Code on the Work Orders board (e.g. "WOCOMPANY_002") — there is no reliable shared key to join a specific deal to a specific work order. Cross-board answers are aggregated by sector/owner/time window, not joined record-to-record.`
  );

  dealsCache = { data, notes };
  return dealsCache;
}

// ---------- Filtering ----------

export type WorkOrderFilter = {
  sector?: string;
  executionStatus?: string;
  billingStatus?: string;
  ownerCode?: string;
  poDateFrom?: string;
  poDateTo?: string;
};

export function filterWorkOrders(
  data: CleanWorkOrder[],
  filter: WorkOrderFilter
): CleanWorkOrder[] {
  return data.filter((wo) => {
    if (filter.sector && wo.sector.toLowerCase() !== filter.sector.toLowerCase())
      return false;
    if (
      filter.executionStatus &&
      wo.executionStatus.toLowerCase() !== filter.executionStatus.toLowerCase()
    )
      return false;
    if (
      filter.billingStatus &&
      wo.billingStatus.toLowerCase() !== filter.billingStatus.toLowerCase()
    )
      return false;
    if (filter.ownerCode && wo.bdOwnerCode !== filter.ownerCode) return false;
    if (filter.poDateFrom && (!wo.dateOfPO || wo.dateOfPO < filter.poDateFrom))
      return false;
    if (filter.poDateTo && (!wo.dateOfPO || wo.dateOfPO > filter.poDateTo))
      return false;
    return true;
  });
}

export type DealFilter = {
  sector?: string;
  dealStage?: string;
  dealStatus?: string;
  ownerCode?: string;
  createdFrom?: string;
  createdTo?: string;
};

export function filterDeals(data: CleanDeal[], filter: DealFilter): CleanDeal[] {
  return data.filter((d) => {
    if (filter.sector && d.sector.toLowerCase() !== filter.sector.toLowerCase())
      return false;
    if (
      filter.dealStage &&
      !d.dealStage.toLowerCase().includes(filter.dealStage.toLowerCase())
    )
      return false;
    if (
      filter.dealStatus &&
      d.dealStatus.toLowerCase() !== filter.dealStatus.toLowerCase()
    )
      return false;
    if (filter.ownerCode && d.ownerCode !== filter.ownerCode) return false;
    if (filter.createdFrom && (!d.createdDate || d.createdDate < filter.createdFrom))
      return false;
    if (filter.createdTo && (!d.createdDate || d.createdDate > filter.createdTo))
      return false;
    return true;
  });
}

// ---------- Aggregation (done in code, never left to the LLM to sum) ----------

export function aggregateBy<T>(
  data: T[],
  groupByFn: (row: T) => string,
  metricFn: (row: T) => number | null
): { group: string; sum: number; count: number; avg: number; nullCount: number }[] {
  const groups = new Map<
    string,
    { sum: number; count: number; nullCount: number }
  >();
  for (const row of data) {
    const key = groupByFn(row);
    const val = metricFn(row);
    const g = groups.get(key) ?? { sum: 0, count: 0, nullCount: 0 };
    if (val === null) {
      g.nullCount++;
    } else {
      g.sum += val;
      g.count++;
    }
    groups.set(key, g);
  }
  return Array.from(groups.entries())
    .map(([group, g]) => ({
      group,
      sum: Math.round(g.sum * 100) / 100,
      count: g.count,
      avg: g.count > 0 ? Math.round((g.sum / g.count) * 100) / 100 : 0,
      nullCount: g.nullCount,
    }))
    .sort((a, b) => b.sum - a.sum);
}

// ---------- Leadership update ----------

export async function generateLeadershipUpdate(): Promise<string> {
  const [wo, deals] = await Promise.all([getCleanWorkOrders(), getCleanDeals()]);

  const openDeals = deals.data.filter((d) => d.dealStatus === "Open");
  const wonDeals = deals.data.filter((d) => d.dealStatus === "Won");
  const pipelineValue = openDeals.reduce((s, d) => s + (d.dealValue ?? 0), 0);
  const wonValue = wonDeals.reduce((s, d) => s + (d.dealValue ?? 0), 0);

  const pipelineBySector = aggregateBy(
    openDeals,
    (d) => d.sector,
    (d) => d.dealValue
  );
  const pipelineByStage = aggregateBy(
    openDeals,
    (d) => d.dealStage,
    (d) => d.dealValue
  );

  const collectedByWO = wo.data.reduce((s, w) => s + (w.collectedAmountInclGST ?? 0), 0);
  const billedByWO = wo.data.reduce((s, w) => s + (w.billedValueInclGST ?? 0), 0);
  const receivable = wo.data.reduce((s, w) => s + (w.amountReceivable ?? 0), 0);
  const openWOs = wo.data.filter((w) => w.woStatus === "Open");

  const lines: string[] = [];
  lines.push(`# Leadership Update — Business Snapshot`);
  lines.push(`_Generated from live monday.com data. See caveats at the end._\n`);

  lines.push(`## Pipeline`);
  lines.push(`- Open deals: **${openDeals.length}**, total pipeline value **₹${pipelineValue.toLocaleString("en-IN")}**`);
  lines.push(`- Won deals (all-time in this data): ${wonDeals.length}, total value ₹${wonValue.toLocaleString("en-IN")}`);
  lines.push(`\n**Pipeline by sector (open deals):**`);
  for (const row of pipelineBySector.slice(0, 8)) {
    lines.push(`- ${row.group}: ₹${row.sum.toLocaleString("en-IN")} (${row.count} deals${row.nullCount ? `, ${row.nullCount} unsized` : ""})`);
  }
  lines.push(`\n**Pipeline by stage (open deals):**`);
  for (const row of pipelineByStage.slice(0, 10)) {
    lines.push(`- ${row.group}: ₹${row.sum.toLocaleString("en-IN")} (${row.count} deals)`);
  }

  lines.push(`\n## Execution & Billing`);
  lines.push(`- Open work orders: **${openWOs.length}**`);
  lines.push(`- Total billed to date: ₹${billedByWO.toLocaleString("en-IN")}`);
  lines.push(`- Total collected to date: ₹${collectedByWO.toLocaleString("en-IN")}`);
  lines.push(`- Amount receivable (outstanding): ₹${receivable.toLocaleString("en-IN")}`);

  lines.push(`\n## Data quality caveats`);
  for (const note of [...wo.notes, ...deals.notes]) {
    lines.push(`- ${note}`);
  }

  return lines.join("\n");
}
