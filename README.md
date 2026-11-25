# DayMate — AI planner

An installable app (Windows, Mac, Android, iPhone, web) for tasks, schedule and meetings, with an AI assistant and push reminders that also reach Android smartwatches.

- `web/` — the app (no build step). `config.js` is generated on deploy.
- `supabase/` — database schema and server functions (`ai`, `reminders`).
- `.github/workflows/deploy.yml` — every push to `main` publishes the website to GitHub Pages.

Server setup (Supabase): run `supabase/migrations/0001_init.sql`, deploy the `ai` and `reminders` functions with JWT verification off, set the `GEMINI_API_KEY` secret, and schedule `reminders` every minute with pg_cron.
