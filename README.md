# DayMate — AI planner

An installable app (Windows, Mac, Android, iPhone, web) for tasks, schedule and meetings, with an AI assistant and push reminders that also reach Android smartwatches.

- `web/` — the app (no build step). `config.js` is generated on deploy.
- `supabase/` — database schema and server functions (`ai`, `reminders`).
- `.github/workflows/deploy.yml` — every push to `main` updates the database, functions and the website.

Repository secrets needed: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `GEMINI_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`.
