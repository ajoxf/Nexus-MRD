import Anthropic from "@anthropic-ai/sdk";
import { FIELDS, sanitiseMapping } from "../src/lib/csv.js";
import { callerFrom, json, serviceClient } from "./_supabase.js";

/*
 * Working out which column is which, when the regexes cannot.
 *
 * THE MODEL NEVER SEES THE BOOK, AND NEVER TOUCHES A NUMBER.
 *
 * That is the whole design and it is worth stating before the code. What goes out is the
 * column headers and at most three sample rows — enough to tell a price from a quantity,
 * and nothing like a position history. What comes back is a MAPPING: which header holds
 * which field. Every fill is then parsed by rowsToFills() exactly as it always was, on this
 * server, deterministically, still covered by the check scripts.
 *
 * Three reasons it is built this way rather than "send the statement, get fills back":
 *
 *   Correct.  These numbers feed TNE/IM, margin calls and stop-out distances. A model that
 *             transposes a digit in a price gives a confidently wrong margin ratio, and a
 *             wrong number that looks right is worse than an import that fails loudly.
 *   Cheap.    Headers and three rows is a fraction of a penny. A few thousand fills would
 *             be dollars an import, every import, for a worse answer.
 *   Private.  Three sample trades leaving the server is a disclosable thing. Every
 *             customer's complete position history leaving the server is a different
 *             product with a different privacy policy.
 *
 * Opt-in, always. Nothing reaches this endpoint unless the trader ticked the box.
 */

/*
 * Hard caps, enforced here rather than trusted from the browser.
 *
 * The client sends three rows because the client was written to. This endpoint accepts
 * three rows because an edited client is not a reason to ship somebody's book to an API.
 */
const MAX_SAMPLE_ROWS = 3;
const MAX_HEADERS = 80;
const MAX_CELL = 120;

const FIELD_KEYS = FIELDS.map((f) => f.key);

/*
 * The shape of an answer, enforced by the API rather than hoped for.
 *
 * strict: true means tool_use.input validates against this exactly — no missing keys, no
 * invented ones. A mapping is a small, closed thing and it should arrive that way.
 */
const MAPPING_TOOL = {
  name: "propose_mapping",
  description:
    "Report which column of the statement holds each field, or null where the statement does not have it.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      ...Object.fromEntries(FIELD_KEYS.map((k) => [k, {
        type: ["string", "null"],
        description: `The exact column header holding ${k}, or null if absent.`,
      }])),
      dateFormat: {
        type: "string",
        enum: ["auto", "DMY", "MDY"],
        description:
          "DMY or MDY only when a sample row proves it — a day past 12 in the first position means DMY. Otherwise auto.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      notes: {
        type: "string",
        description: "One short sentence for the trader on anything odd. Empty string if nothing is.",
      },
    },
    required: [...FIELD_KEYS, "dateFormat", "confidence", "notes"],
    additionalProperties: false,
  },
};

const SYSTEM = `You map the columns of a futures or FX broker statement onto a fixed set of fields.

You are given only the column headers and a few sample rows. Call propose_mapping exactly once.

Rules:
- Return the column header EXACTLY as given, character for character, or null.
- Never invent a header that is not in the list.
- Never return the same header for two different fields.
- Prefer null over a guess. A field left null is corrected by the trader in one click; a
  wrong one is corrected after they have questioned their own margin figures.
- "qty" is lots or contracts traded, never a running balance or a position total.
- "price" is the fill price, not a profit, not a fee, not a notional value.
- "fee" is commission or brokerage charged, which is usually negative or shown in brackets.
- Headers may be in any language, abbreviated, or duplicated with a suffix.`;

export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  const key = process.env.ANTHROPIC_API_KEY;
  /*
   * No VITE_ prefix, checked nowhere else because it exists nowhere else. Same rule as the
   * Supabase service key and the Stripe secret: a key Vite can see is a key the whole desk
   * can spend.
   */
  if (!key) return json(response, 503, { error: "Column help is not set up on this server." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  /*
   * Signed in, proven from the token. Not because the mapping is secret — it is the
   * trader's own file — but because this endpoint costs real money per call and an open
   * one is somebody else's bill.
   */
  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const body = request.body && typeof request.body === "object" ? request.body : {};

  const headers = Array.isArray(body.headers)
    ? body.headers.filter((h) => typeof h === "string").slice(0, MAX_HEADERS).map((h) => h.slice(0, MAX_CELL))
    : [];
  if (!headers.length) return json(response, 400, { error: "No columns to look at." });

  const samples = (Array.isArray(body.samples) ? body.samples : [])
    .slice(0, MAX_SAMPLE_ROWS)
    .map((row) => (Array.isArray(row) ? row.slice(0, MAX_HEADERS).map((c) => String(c ?? "").slice(0, MAX_CELL)) : []));

  const table = [
    headers.join(" | "),
    ...samples.map((r) => r.join(" | ")),
  ].join("\n");

  try {
    const client = new Anthropic({ apiKey: key });

    const message = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      system: SYSTEM,
      tools: [MAPPING_TOOL],
      /*
       * auto plus an instruction naming the tool, rather than forcing the call. Forced tool
       * use is rejected outright on some current models, and strict: true already
       * guarantees the arguments validate — so this is the shape that does not need
       * revisiting when the model changes.
       */
      tool_choice: { type: "auto" },
      // Opt-in fallback: if a safety classifier declines, the same request is re-run on
      // another model inside the same call rather than simply stopping.
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
      messages: [{
        role: "user",
        content: `Here are the columns and up to three sample rows from a broker statement. Call propose_mapping with your best mapping.\n\n${table}`,
      }],
    });

    if (message.stop_reason === "refusal") {
      return json(response, 502, { error: "The assistant declined to read that file. Map the columns by hand." });
    }

    const call = message.content.find((b) => b.type === "tool_use" && b.name === "propose_mapping");
    if (!call) return json(response, 502, { error: "No mapping came back. Map the columns by hand." });

    const proposed = call.input ?? {};

    /*
     * Checked against the headers we actually sent, by the same pure function the check
     * script exercises. strict mode guarantees the SHAPE of the answer, never its truth.
     */
    const { map, dateFormat, confidence, dropped } = sanitiseMapping(proposed, headers);

    return json(response, 200, {
      ok: true,
      map,
      dateFormat,
      confidence,
      notes: typeof proposed.notes === "string" ? proposed.notes.slice(0, 400) : "",
      // Surfaced rather than swallowed: if columns were dropped, the trader should know the
      // suggestion was imperfect before they trust the rest of it.
      dropped: dropped.length,
    });
  } catch (error) {
    console.error("[parse-statement]", error?.message);
    if (error?.status === 429) return json(response, 429, { error: "Busy just now. Try again in a moment, or map the columns by hand." });
    return json(response, 502, { error: "Could not work out the columns. Map them by hand." });
  }
}
