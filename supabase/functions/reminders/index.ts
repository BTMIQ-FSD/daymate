// DayMate reminders: runs every minute (pg_cron) and sends push notifications
// to the phone, PC and (through the phone) the watch.
// GET ?key=1 returns the public push key the app needs to subscribe.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

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
const db = createClient(SB_URL, SERVICE);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Push keys are created once, on first use, and kept in the database.
let keys: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (keys) return keys;
  const { data } = await db.from("app_config").select("value").eq("key", "vapid").maybeSingle();
  if (data) return (keys = data.value);
  await db.from("app_config").upsert({ key: "vapid", value: webpush.generateVAPIDKeys() }, { onConflict: "key", ignoreDuplicates: true });
  const { data: again } = await db.from("app_config").select("value").eq("key", "vapid").single();
  return (keys = again!.value);
}

const fmt = (t: string | null) => (t ? t.slice(0, 5) : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const k = await vapid();
  if (new URL(req.url).searchParams.get("key")) {
    return new Response(JSON.stringify({ publicKey: k.publicKey }), { headers: { ...cors, "Content-Type": "application/json" } });
  }
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:daymate@users.noreply.github.com", k.publicKey, k.privateKey);

  // Only reminders that are already due are sent, and each only once,
  // so calling this early or often does no harm.
  const now = new Date();
  const { data: due, error } = await db.from("items")
    .select("id,user_id,title,kind,time,remind_minutes")
    .eq("notified", false).eq("done", false)
    .lte("remind_at", now.toISOString())
    .gte("remind_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString())
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });
  let sent = 0;
  for (const it of due ?? []) {
    await db.from("items").update({ notified: true }).eq("id", it.id);
    const { data: subs } = await db.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", it.user_id);
    const mins = it.remind_minutes ?? 0;
    const payload = JSON.stringify({
      title: it.title,
      body: `${it.kind === "event" ? "Starts" : "Due"} ${mins ? `in ${mins} min` : "now"}${it.time ? ` (${fmt(it.time)})` : ""}`,
      tag: it.id,
    });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
        else console.error("push failed", code);
      }
    }
  }
  return new Response(JSON.stringify({ due: due?.length ?? 0, sent }), { headers: { "Content-Type": "application/json" } });
});
