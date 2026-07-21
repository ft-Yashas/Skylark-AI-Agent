# Decision Log — Skylark BI Agent

## Architecture
- **Next.js 14 (App Router) + TypeScript**, deployed on Vercel. One API route
  (`/api/chat`) runs an LLM tool-calling loop; a single-page chat UI drives it.
- **Google Gemini (`gemini-2.5-flash`)** as the reasoning/query-understanding
  layer, called directly via `fetch` (no SDK) to keep the dependency surface
  small and the code auditable in one file. **Why Gemini over Claude:**
  this prototype needed to run at zero cost (no billing-enabled API key
  available); Google AI Studio issues a free-tier Gemini key with real
  function/tool-calling support and no credit card. The tool-calling loop,
  system prompt, and all business logic are provider-agnostic — `route.ts`
  contains the only Gemini-specific code (a schema converter and a
  canonical-history ↔ Gemini-`contents` adapter), so swapping back to Claude
  or any other tool-calling model is a same-file change, not a rearchitecture.
- **monday.com GraphQL API** (not MCP) for data access, read-only.
- Client is **stateless**: the browser holds the full message history and resends
  it each turn; the server never persists conversation state. Simple, and
  sufficient for a single-user prototype — see "what I'd do differently."

## Why API over MCP
Both are allowed. MCP is arguably the more "impressive" answer, but on a 6-hour
clock it adds a server process / hosting surface to debug. A raw GraphQL client
is one authenticated POST, fully dynamic, and just as capable of satisfying
"query monday.com dynamically, never hardcode CSV data." I judged the time saved
was worth more than the novelty. Column IDs are never hardcoded either — the
board schema (column id → title) is fetched live and used to map monday's opaque
IDs back to the original CSV header names, so the agent keeps working even if
someone re-imports or reorders the board.

## Key data-quality findings (drove the cleaning layer)
Profiled both CSVs directly before writing any code (see `lib/clean.ts` for the
functions this produced):

1. **No reliable join key between the two boards.** Work Orders uses
   `WOCOMPANY_0XX` customer codes; Deals uses `COMPANY0XX` client codes — different
   numbering schemes, not the same entity IDs. "Deal name masked" (e.g. "Sakura")
   is *not* a unique identifier either — it repeats across dozens of unrelated
   deals/companies. **Decision:** the agent never claims to join a specific deal
   to a specific work order. Cross-board questions are answered by aggregating
   each board independently over sector / owner / time window and presenting
   them side by side, with this limitation stated explicitly in the system
   prompt and surfaced in tool output notes.
2. **Corrupted rows.** The Deals CSV contains rows where the data cells are
   literally the column headers again (a re-injected header row from a bad
   export/paste — row 52 in the raw file, `Nezuko,,,Deal Status,Close Date (A)...`).
   **Decision:** detect and drop any row where ≥2 fields exactly equal their own
   column's header text, and report the drop count as a data-quality note rather
   than silently discarding it.
3. **Mixed units in quantity fields.** "Quantities as per PO" mixes acres, HA,
   KM, image counts, and tower counts, including a typo ("415Acers") and clear
   garbage ("L/s"). **Decision:** don't attempt unit conversion/normalization —
   parse the leading number + trailing unit text, keep both, and refuse to sum
   across incompatible units. Summing "acres + km + images" would produce a
   number that looks precise and is meaningless.
4. **Blank categorical fields** (Sector on ~8 deals, Billing/Execution status on
   several work orders) are normalized to explicit "Unknown"/"Unspecified"
   labels rather than dropped, so they still show up in counts and can be
   flagged to the user rather than silently vanishing from totals.
5. **One casing typo** in Billing Status ("BIlled" vs "Billed") — corrected via
   an explicit, narrow rule rather than general fuzzy matching, to avoid masking
   other real distinctions in a field we haven't fully audited.
6. **"Collection status"/"Collection Date"** are empty on effectively every Work
   Order row — flagged as an unmaintained field rather than treated as "zero
   collections."
7. **No literal "Energy" sector exists** (closest is "Renewables"); "Tender" in
   the Deals sector field is a sourcing channel, not an industry. The agent is
   instructed to say what it matched to, or ask, rather than silently guessing —
   this directly addresses the sample founder query in the brief ("energy
   sector this quarter").

## Query understanding & clarifying questions
Handled entirely in the system prompt plus tool descriptions, rather than a
separate NLU layer — the LLM's own reasoning does the mapping from founder
phrasing ("pipeline," "revenue," "this quarter") to the right tool calls and
filters. It's instructed to ask one short clarifying question only when a term
is genuinely ambiguous (e.g., "energy sector," an unspecified fiscal year) and
to state its interpretation otherwise rather than over-asking.

## Accuracy guardrail
All sums/counts/averages are computed **in code** (`aggregateBy` in
`lib/tools.ts`), never by asking the LLM to add up numbers from a returned
list. The system prompt explicitly tells the model to use the aggregate tools for
any "how much / how many" question. This was a deliberate trade-off: it costs
an extra tool-call round trip sometimes, but removes LLM arithmetic error as a
failure mode entirely for the numbers that matter most.

## "Leadership updates" — interpretation
Implemented as an on-demand tool (`generate_leadership_update`) that compiles a
structured markdown snapshot: open pipeline value and count (by sector and by
stage), won-deal value, and Work Order execution/billing metrics (billed,
collected, receivable, open WO count) — with data-quality caveats appended
automatically. I interpreted this as "help a founder walk into a leadership
sync with a ready snapshot," not as scheduled/automated reporting or a
polished export (PDF/slide), given the 6-hour scope. The agent also adds its
own brief synthesis on top when asked in chat, rather than just dumping the
raw markdown.

## Trade-offs / things I'd do differently with more time
- **Export formats.** The leadership update is markdown in-chat only; a real
  version would offer a PDF/Google Doc/Slack-ready export.
- **No conversation persistence.** Multi-user or session resume would need a
  proper store instead of round-tripping the full history from the browser.
- **No caching/rate-limit handling** beyond a 5-minute in-memory schema cache;
  a production version should cache item data too and handle monday.com API
  rate limits explicitly rather than letting a request fail.
- **Fuzzy sector/term matching is intentionally conservative.** I chose to
  surface ambiguity to the user rather than build a broader synonym-mapping
  system, given the time available and the risk of silently misclassifying
  data. A v2 could maintain an explicit alias table reviewed by the business.
- **No automated tests.** Logic was sanity-checked against the real CSVs
  directly (see build notes / README) but there's no regression suite.
- **Single LLM call per tool round-trip, no streaming.** Streaming responses
  would improve perceived latency for longer analyses.

## Assumptions
- "This quarter" and similar relative time phrasing is resolved by the LLM
  using the current date injected into the system prompt each request.
- "Revenue" defaults to billed/collected Work Order amounts unless the user is
  clearly asking about pipeline value.
- The monday.com import preserves the CSV column headers as column titles
  (this is what the app matches against) — if a board is set up with
  differently-worded titles, the corresponding tool inputs would need updating.
