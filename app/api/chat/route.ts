import { NextRequest, NextResponse } from "next/server";
import { TOOLS, dispatchTool } from "@/lib/dispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "gemini-2.5-flash";
const GEMINI_URL = (apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

const SYSTEM_PROMPT = `You are a business intelligence agent for Skylark Drones' founders and executives. You answer questions about the company's sales pipeline (Deals board) and project execution/billing (Work Orders board) on monday.com by calling tools that fetch and aggregate the live data — never invent numbers.

How to behave:
- For any question involving totals, sums, counts, or "how much/how many", use the aggregate_work_orders / aggregate_deals tools rather than manually adding numbers from get_work_orders / get_deals. Those tools compute exact sums server-side.
- Interpret founder-style shorthand sensibly: "pipeline" = open deals; "revenue" usually means billed/collected amounts on Work Orders unless they clearly mean pipeline value; "this quarter" needs you to reason about dates using today's actual date context if given, otherwise ask.
- The data uses specific category names that don't always match casual phrasing (e.g. there is no "Energy" sector — "Renewables" is the closest). If a term the user used doesn't cleanly map to a real category in the data, say what you found the closest match to be, or ask a brief clarifying question if it's genuinely ambiguous — don't silently guess and don't silently fabricate a category that doesn't exist.
- Always mention material data-quality caveats returned by the tools (missing values, unreliable fields, the lack of a join key between boards) when they're relevant to the answer, briefly — don't bury a caveat that changes how much to trust the number.
- The two boards do NOT share a reliable join key (see tool notes) — never claim you joined a specific deal to a specific work order. Cross-board questions should be answered by aggregating each board independently over sector/owner/time and presenting them side by side, being explicit that it's an aggregate comparison, not a joined record.
- Give a direct, founder-level answer first (the number/insight), then brief supporting context. Don't just dump raw tables — synthesize.
- If a query is genuinely ambiguous (e.g. "how's Q3 looking" without saying which fiscal year, or "energy sector" which isn't a literal category), ask one short clarifying question before running the analysis — don't over-ask for things you can reasonably infer.
- For "leadership update" / "exec summary" / "board update" requests, use generate_leadership_update and present it well, adding your own brief synthesis on top of the caveats it returns.`;

type Block = { type: string; [key: string]: any };
type ChatMessage = { role: "user" | "assistant"; content: string | Block[] };

function jsonSchemaTypeToGemini(t: string): string {
  return String(t).toUpperCase();
}

function convertSchema(s: any): any {
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  if (s.type) out.type = jsonSchemaTypeToGemini(s.type);
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = convertSchema(v);
  }
  if (s.items) out.items = convertSchema(s.items);
  if (s.required) out.required = s.required;
  return out;
}

const GEMINI_TOOLS = [
  {
    functionDeclarations: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: convertSchema(t.input_schema),
    })),
  },
];

function toGeminiContents(messages: ChatMessage[]) {
  const idToName = new Map<string, string>();
  const contents: any[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        contents.push({ role: "user", parts: [{ text: m.content }] });
      } else {
        const parts = (m.content as Block[]).map((b) => {
          const name = idToName.get(b.tool_use_id) ?? "unknown_tool";
          let responseObj: any;
          try {
            responseObj = JSON.parse(b.content);
          } catch {
            responseObj = { result: b.content };
          }
          return { functionResponse: { name, response: responseObj } };
        });
        contents.push({ role: "user", parts });
      }
    } else {
      const blocks = m.content as Block[];
      const parts = blocks.map((b) => {
        if (b.type === "tool_use") {
          idToName.set(b.id, b.name);
          return { functionCall: { name: b.name, args: b.input ?? {} } };
        }
        return { text: b.text ?? "" };
      });
      contents.push({ role: "model", parts });
    }
  }
  return contents;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter += 1;
  return `call_${Date.now()}_${callCounter}`;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }

    const body = await req.json();
    const incomingMessages: ChatMessage[] = body.messages ?? [];

    if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) {
      return NextResponse.json({ error: "messages[] is required." }, { status: 400 });
    }

    const messages: ChatMessage[] = [...incomingMessages];

    for (let turn = 0; turn < 8; turn++) {
      const res = await fetch(GEMINI_URL(apiKey), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: `${SYSTEM_PROMPT}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.` }],
          },
          tools: GEMINI_TOOLS,
          contents: toGeminiContents(messages),
          generationConfig: { maxOutputTokens: 2048 },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return NextResponse.json(
          { error: `Gemini API error (${res.status}): ${errText.slice(0, 800)}` },
          { status: 502 }
        );
      }

      const data = await res.json();
      const candidate = data.candidates?.[0];

      if (!candidate) {
        const blockReason = data.promptFeedback?.blockReason;
        return NextResponse.json(
          { error: blockReason ? `Gemini blocked the request: ${blockReason}` : "Gemini returned no candidates." },
          { status: 502 }
        );
      }

      const parts = candidate.content?.parts ?? [];
      const functionCalls = parts.filter((p: any) => p.functionCall);

      const assistantBlocks: Block[] = parts.map((p: any) => {
        if (p.functionCall) {
          return { type: "tool_use", id: nextCallId(), name: p.functionCall.name, input: p.functionCall.args ?? {} };
        }
        return { type: "text", text: p.text ?? "" };
      });

      messages.push({ role: "assistant", content: assistantBlocks });

      if (functionCalls.length === 0) {
        return NextResponse.json({ messages });
      }

      const toolUseBlocks = assistantBlocks.filter((b) => b.type === "tool_use");
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tu) => {
          let output: string;
          try {
            output = await dispatchTool(tu.name, tu.input);
          } catch (err: any) {
            output = JSON.stringify({ error: err?.message ?? String(err) });
          }
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: output,
          };
        })
      );

      messages.push({ role: "user", content: toolResults });
    }

    return NextResponse.json(
      { error: "Too many tool-use turns without a final answer." },
      { status: 500 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown server error" },
      { status: 500 }
    );
  }
}
