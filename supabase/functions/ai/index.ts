// DayMate AI: turns text into planner actions using Google Gemini.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest";
const LITE_MODEL = Deno.env.get("GEMINI_LITE_MODEL") ?? "gemini-flash-lite-latest";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "60");
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS", "SUPABASE_SECRET_KEY");

function envKey(...names: string[]) {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (!v) continue;
    try { const j = JSON.parse(v); const first = typeof j === "object" ? Object.values(j)[0] : j; if (first) return String(first); } catch { return v; }
  }
  return "";
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const itemProps = {
  kind: { type: "STRING", enum: ["task", "event"], description: "event = meeting/appointment at a set time; task = to-do" },
  title: { type: "STRING" },
  date: { type: "STRING", description: "YYYY-MM-DD, or empty" },
  time: { type: "STRING", description: "HH:MM 24h, or empty" },
  end_time: { type: "STRING", description: "HH:MM 24h end, or empty" },
  priority: { type: "STRING", enum: ["high", "normal", "low"] },
  link: { type: "STRING", description: "https meeting link if given" },
  notes: { type: "STRING" },
  remind_minutes: { type: "INTEGER", description: "minutes before to remind; 10 for meetings; omit for none" },
};
const tools = [{
  functionDeclarations: [
    { name: "add_item", description: "Create a task or event.", parameters: { type: "OBJECT", properties: itemProps, required: ["kind", "title"] } },
    {
      name: "update_item", description: "Change an existing item by id (reschedule, rename, mark done, priority).",
      parameters: { type: "OBJECT", properties: { id: { type: "STRING" }, ...itemProps, done: { type: "BOOLEAN" } }, required: ["id"] },
    },
    { name: "delete_item", description: "Delete an item by id, only when the user clearly asks.", parameters: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] } },
  ],
}];

async function gemini(model: string, body: unknown) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? `Gemini error ${r.status}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_KEY) return json({ error: "AI is not set up yet." }, 503);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const admin = createClient(SB_URL, SERVICE);
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Please sign in again." }, 401);

  // Per-user daily limit keeps the free AI quota fair for everyone.
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from("ai_usage").select("calls").eq("user_id", user.id).eq("day", today).maybeSingle();
  if ((usage?.calls ?? 0) >= DAILY_LIMIT) return json({ error: "You've reached today's AI limit. It resets tomorrow." }, 429);
  await admin.from("ai_usage").upsert({ user_id: user.id, day: today, calls: (usage?.calls ?? 0) + 1 });

  let input: { mode?: string; text?: string; messages?: { role: string; content: string }[]; now?: string; tz?: string; items?: string };
  try { input = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const ctx = `Now: ${String(input.now ?? new Date().toString()).slice(0, 120)}. Time zone: ${String(input.tz ?? "UTC").slice(0, 60)}.`;
  const items = String(input.items ?? "").slice(0, 20000);

  try {
    if (input.mode === "parse") {
      const data = await gemini(LITE_MODEL, {
        systemInstruction: { parts: [{ text: `${ctx}\nTurn the user's note into ONE planner item. Resolve relative dates against now. Meetings, calls and appointments are events with a time (default 1 hour, remind_minutes 10). Otherwise a task. Reply with JSON only: {kind,title,date,time,end_time,priority,link,notes,remind_minutes}.` }] },
        contents: [{ role: "user", parts: [{ text: String(input.text ?? "").slice(0, 500) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      });
      const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "{}";
      return json({ item: JSON.parse(text) });
    }

    if (input.mode === "brief") {
      const data = await gemini(LITE_MODEL, {
        systemInstruction: { parts: [{ text: `${ctx}\nWrite the user's daily briefing in plain text under 90 words: a one-line overview, the order to tackle today's items (include overdue), and one tip to protect focus time. No markdown.` }] },
        contents: [{ role: "user", parts: [{ text: `My items:\n${items}` }] }],
      });
      return json({ text: data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "" });
    }

    // chat
    const msgs = (input.messages ?? []).slice(-12).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content).slice(0, 2000) }],
    }));
    const data = await gemini(MODEL, {
      systemInstruction: { parts: [{ text: `You are DayMate, a friendly planning assistant inside the user's planner app. ${ctx}\nUse the tools to change the planner when asked (create, reschedule, complete, delete), then confirm in one or two short sentences with day and time. Working hours 09:00-18:00 unless told otherwise. Never invent meetings. Use 24h HH:MM in tools.\nCurrent items (id | kind | title | date time | priority | status):\n${items || "(none)"}` }] },
      contents: msgs,
      tools,
    });
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const actions = parts.filter((p: { functionCall?: unknown }) => p.functionCall).map((p: { functionCall: { name: string; args: unknown } }) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} }));
    const text = parts.map((p: { text?: string }) => p.text ?? "").join("").trim();
    return json({ text, actions });
  } catch (e) {
    console.error(e);
    return json({ error: "The AI is busy right now. Please try again in a minute." }, 502);
  }
});
