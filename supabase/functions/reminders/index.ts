// DayMate reminders: runs every minute (pg_cron) and sends push notifications
// to the phone, PC and (through the phone) the watch.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const fmt = (t: string | null) => (t ? t.slice(0, 5) : "");

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
  const db = createClient(SB_URL, SERVICE);
  const now = new Date();
  const { data: due, error } = await db.from("items")
    .select("id,user_id,title,kind,time,remind_minutes,remind_at")
    .eq("notified", false).eq("done", false)
    .lte("remind_at", now.toISOString())
    .gte("remind_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString())
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });
  let sent = 0;
  for (const it of due ?? []) {
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
    await db.from("items").update({ notified: true }).eq("id", it.id);
  }
  return new Response(JSON.stringify({ due: due?.length ?? 0, sent }), { headers: { "Content-Type": "application/json" } });
});
