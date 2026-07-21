# Skylark BI Agent

A conversational business-intelligence agent that answers founder-level
questions by querying two monday.com boards (Work Orders + Deals) live —
no hardcoded data. See `DECISION_LOG.docx` for assumptions and trade-offs.

## Architecture

```
Browser (chat UI, app/page.tsx)
   │  full message history each turn
   ▼
/api/chat  (Next.js route, app/api/chat/route.ts)
   │  tool-calling loop against Google Gemini (free tier)
   ▼
lib/dispatch.ts  — tool schemas + dispatcher
   │
   ├─ lib/tools.ts   — fetch, clean, filter, aggregate (server-side math)
   │      │
   │      ▼
   └─ lib/monday.ts  — GraphQL client, dynamic schema discovery, pagination
          │
          ▼
     monday.com API (read-only token)
```

- **No column IDs or CSV data are hardcoded anywhere.** `lib/monday.ts` fetches
  each board's column schema (id → title) at request time and uses it to map
  monday's opaque column IDs back to the original field names.
- **All arithmetic (sums, counts, averages) happens in TypeScript**
  (`aggregateBy` in `lib/tools.ts`), not in the LLM — see Decision Log.
- The cleaning rules in `lib/clean.ts` were written against the actual
  messiness found in the two sample CSVs (see Decision Log for the specific
  issues found and how each is handled).

## Setup

### 1. monday.com — create the boards

For each of the two provided CSVs:
1. In monday.com, create a new board (e.g. `Work Orders`, `Deals Pipeline`).
2. Use **Import → Excel/CSV** to import the corresponding file.
3. During the import mapping step, review the auto-detected column types.
   Recommended types (fix anything monday guessed wrong):

   **Work Orders board**
   | CSV column | Recommended type |
   |---|---|
   | Deal name masked, Customer Name Code, Serial #, Nature of Work, Type of Work, BD/KAM Personnel code, latest invoice no. | Text |
   | Execution Status, Document Type, Invoice Status, WO Status (billed), Collection status, Billing Status, AR Priority account | Status / Dropdown |
   | Sector | Status / Dropdown |
   | Data Delivery Date, Date of PO/LOI, Probable Start Date, Probable End Date, Last invoice date, Collection Date | Date |
   | Amount in Rupees (Excl/Incl of GST), Billed Value, Collected Amount, Amount to be billed, Amount Receivable | Numbers |
   | Quantity by Ops, Quantities as per PO, Quantity billed, Balance in quantity | **Text** (values mix units — e.g. "5360 HA", "10.5 KM" — a Numbers column would silently truncate these) |
   | Is any Skylark software platform... | Text or Dropdown |
   | Last executed month, Expected/Actual Billing Month, Actual Collection Month | Text |

   **Deals board**
   | CSV column | Recommended type |
   |---|---|
   | Deal Name, Owner code, Client Code | Text |
   | Deal Status, Closure Probability, Deal Stage, Product deal, Sector/service | Status / Dropdown |
   | Close Date (A), Tentative Close Date, Created Date | Date |
   | Masked Deal value | Numbers |

4. Note each board's **ID** from its URL: `https://<account>.monday.com/boards/<ID>`.
5. Generate a **read-only-scoped Personal API Token**: avatar → *Developers* →
   *My Access Tokens*.

> The app doesn't hardcode which column IDs monday.com assigns — it re-reads
> the schema by title every request — so exact type choices above are
> recommendations for clean import, not hard requirements.

### 2. Environment variables

Copy `.env.example` to `.env.local` (for local dev) or set these in your
hosting provider's dashboard:

```
GEMINI_API_KEY=your Google Gemini API key (free tier — https://aistudio.google.com/apikey)
MONDAY_API_TOKEN=your monday.com personal API token (read-only)
MONDAY_WORK_ORDERS_BOARD_ID=the Work Orders board ID
MONDAY_DEALS_BOARD_ID=the Deals board ID
```

### 3. Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

### 4. Deploy (Vercel)

```bash
npm i -g vercel
vercel
```
Or: push this repo to GitHub → import it in the Vercel dashboard → add the four
environment variables above in Project Settings → Environment Variables →
redeploy. No other configuration is needed; `vercel.json` is not required for
this app.

## Using the agent

Ask things like:
- "How's our pipeline looking for the Renewables sector?"
- "What's our total revenue collected so far?"
- "Which sector has the most work orders stuck on billing?"
- "Give me a leadership update"

The agent will call monday.com live, clean the data, compute exact totals in
code, and surface relevant data-quality caveats (e.g. missing sector,
unreliable fields) alongside the answer rather than silently dropping them.

## Project structure

```
app/
  page.tsx             chat UI
  layout.tsx, globals.css
  api/chat/route.ts    Gemini tool-use loop
lib/
  monday.ts            GraphQL client + dynamic schema mapping
  clean.ts             normalization rules
  tools.ts             fetch/clean/filter/aggregate + leadership update
  dispatch.ts          tool schemas + dispatcher
DECISION_LOG.docx
```
