import {
  getCleanWorkOrders,
  getCleanDeals,
  filterWorkOrders,
  filterDeals,
  aggregateBy,
  generateLeadershipUpdate,
  CleanWorkOrder,
  CleanDeal,
} from "./tools";

// ---------- Tool definitions given to Claude ----------

export const TOOLS = [
  {
    name: "get_work_orders",
    description:
      "Fetch cleaned Work Orders (project execution/billing data) from monday.com, optionally filtered. Returns up to 50 matching records plus a total match count and data-quality notes. Use this to inspect specific records; use aggregate_work_orders for totals/breakdowns instead of summing this output yourself.",
    input_schema: {
      type: "object" as const,
      properties: {
        sector: {
          type: "string",
          description:
            'Exact sector name, e.g. "Mining", "Renewables", "Powerline", "Railways", "Construction", "Others". There is no literal "Energy" sector in this data — "Renewables" is the closest match; ask the user to confirm if they say "energy" and you are not sure.',
        },
        executionStatus: {
          type: "string",
          description:
            'e.g. "Completed", "Ongoing", "Not Started", "Executed until current month", "Partial Completed", "Pause / struck", "Details pending from Client"',
        },
        billingStatus: {
          type: "string",
          description:
            'e.g. "Billed", "Partially Billed", "Update Required", "Not Billable", "Stuck"',
        },
        ownerCode: { type: "string", description: 'BD/KAM personnel code, e.g. "OWNER_003"' },
        poDateFrom: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive lower bound on PO/LOI date" },
        poDateTo: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive upper bound on PO/LOI date" },
      },
    },
  },
  {
    name: "get_deals",
    description:
      "Fetch cleaned Deals (sales pipeline) from monday.com, optionally filtered. Returns up to 50 matching records plus a total match count and data-quality notes. Use aggregate_deals for totals/breakdowns instead of summing this output yourself.",
    input_schema: {
      type: "object" as const,
      properties: {
        sector: {
          type: "string",
          description:
            'Exact sector name, e.g. "Mining", "Renewables", "Powerline", "Railways", "DSP", "Tender", "Construction", "Others", "Manufacturing", "Security and Surveillance", "Aviation". "Tender" is a sourcing channel, not an industry — flag this if the user seems to be asking about it as an industry.',
        },
        dealStage: {
          type: "string",
          description:
            'Substring match on stage, e.g. "Negotiations", "Proposal", "Lead Generated", "Work Order Received", "Project Won", "Project Lost", "On Hold"',
        },
        dealStatus: { type: "string", description: '"Open", "Won", "Dead", or "On Hold"' },
        ownerCode: { type: "string", description: 'Deal owner code, e.g. "OWNER_003"' },
        createdFrom: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive lower bound on Created Date" },
        createdTo: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive upper bound on Created Date" },
      },
    },
  },
  {
    name: "aggregate_work_orders",
    description:
      "Compute accurate sums/counts/averages over Work Orders, grouped by a field. Always prefer this over manual arithmetic on get_work_orders output for any totals, breakdowns, or 'how much/how many' question.",
    input_schema: {
      type: "object" as const,
      properties: {
        groupBy: {
          type: "string",
          enum: ["sector", "executionStatus", "billingStatus", "woStatus", "bdOwnerCode"],
        },
        metric: {
          type: "string",
          enum: [
            "count",
            "amountInclGST",
            "billedValueInclGST",
            "collectedAmountInclGST",
            "amountReceivable",
          ],
          description: '"count" gives row counts per group; other options sum that rupee field per group.',
        },
        filter: {
          type: "object",
          description: "Optional filters, same shape as get_work_orders parameters.",
          properties: {
            sector: { type: "string" },
            executionStatus: { type: "string" },
            billingStatus: { type: "string" },
            ownerCode: { type: "string" },
            poDateFrom: { type: "string" },
            poDateTo: { type: "string" },
          },
        },
      },
      required: ["groupBy", "metric"],
    },
  },
  {
    name: "aggregate_deals",
    description:
      "Compute accurate sums/counts/averages over Deals, grouped by a field. Always prefer this over manual arithmetic on get_deals output for any totals, breakdowns, or 'how much/how many' question (e.g. pipeline value by sector, deal counts by stage).",
    input_schema: {
      type: "object" as const,
      properties: {
        groupBy: {
          type: "string",
          enum: ["sector", "dealStage", "dealStatus", "ownerCode"],
        },
        metric: {
          type: "string",
          enum: ["count", "dealValue"],
          description: '"count" gives deal counts per group; "dealValue" sums the masked deal value per group.',
        },
        filter: {
          type: "object",
          description: "Optional filters, same shape as get_deals parameters.",
          properties: {
            sector: { type: "string" },
            dealStage: { type: "string" },
            dealStatus: { type: "string" },
            ownerCode: { type: "string" },
            createdFrom: { type: "string" },
            createdTo: { type: "string" },
          },
        },
      },
      required: ["groupBy", "metric"],
    },
  },
  {
    name: "generate_leadership_update",
    description:
      "Generate a structured markdown leadership-update snapshot combining pipeline (by sector/stage) and execution/billing metrics from both boards, with data-quality caveats included. Use when the user asks for a leadership update, exec summary, board update, or similar recap document.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

// ---------- Dispatcher ----------

const WO_METRIC: Record<string, (w: CleanWorkOrder) => number | null> = {
  count: () => 1,
  amountInclGST: (w) => w.amountInclGST,
  billedValueInclGST: (w) => w.billedValueInclGST,
  collectedAmountInclGST: (w) => w.collectedAmountInclGST,
  amountReceivable: (w) => w.amountReceivable,
};

const WO_GROUP: Record<string, (w: CleanWorkOrder) => string> = {
  sector: (w) => w.sector,
  executionStatus: (w) => w.executionStatus,
  billingStatus: (w) => w.billingStatus,
  woStatus: (w) => w.woStatus,
  bdOwnerCode: (w) => w.bdOwnerCode || "Unassigned",
};

const DEAL_METRIC: Record<string, (d: CleanDeal) => number | null> = {
  count: () => 1,
  dealValue: (d) => d.dealValue,
};

const DEAL_GROUP: Record<string, (d: CleanDeal) => string> = {
  sector: (d) => d.sector,
  dealStage: (d) => d.dealStage,
  dealStatus: (d) => d.dealStatus,
  ownerCode: (d) => d.ownerCode || "Unassigned",
};

export async function dispatchTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "get_work_orders": {
      const { data, notes } = await getCleanWorkOrders();
      const filtered = filterWorkOrders(data, input ?? {});
      return JSON.stringify(
        {
          totalMatches: filtered.length,
          records: filtered.slice(0, 50),
          truncated: filtered.length > 50,
          dataQualityNotes: notes,
        },
        null,
        2
      );
    }
    case "get_deals": {
      const { data, notes } = await getCleanDeals();
      const filtered = filterDeals(data, input ?? {});
      return JSON.stringify(
        {
          totalMatches: filtered.length,
          records: filtered.slice(0, 50),
          truncated: filtered.length > 50,
          dataQualityNotes: notes,
        },
        null,
        2
      );
    }
    case "aggregate_work_orders": {
      const { data, notes } = await getCleanWorkOrders();
      const filtered = filterWorkOrders(data, input?.filter ?? {});
      const groupFn = WO_GROUP[input.groupBy];
      const metricFn = WO_METRIC[input.metric];
      if (!groupFn || !metricFn) {
        return JSON.stringify({ error: "Invalid groupBy or metric." });
      }
      const result = aggregateBy(filtered, groupFn, metricFn);
      return JSON.stringify({ groupBy: input.groupBy, metric: input.metric, result, dataQualityNotes: notes }, null, 2);
    }
    case "aggregate_deals": {
      const { data, notes } = await getCleanDeals();
      const filtered = filterDeals(data, input?.filter ?? {});
      const groupFn = DEAL_GROUP[input.groupBy];
      const metricFn = DEAL_METRIC[input.metric];
      if (!groupFn || !metricFn) {
        return JSON.stringify({ error: "Invalid groupBy or metric." });
      }
      const result = aggregateBy(filtered, groupFn, metricFn);
      return JSON.stringify({ groupBy: input.groupBy, metric: input.metric, result, dataQualityNotes: notes }, null, 2);
    }
    case "generate_leadership_update": {
      const markdown = await generateLeadershipUpdate();
      return markdown;
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}
