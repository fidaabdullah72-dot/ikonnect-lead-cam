# BatSols

Find businesses on Google Maps, qualify them, and run WhatsApp campaigns with your whole team — from one
dashboard. Each teammate connects their own WhatsApp by scanning a QR code; admins see everything and get
per-person, per-team and per-campaign reports.

```
crm-dashboard/   Next.js 16 web app (UI, auth, API routes)
engine/          Node worker: WhatsApp sessions, campaign runner, lead finder, automations
packages/shared/ Shared logic (templating/spintax, phone numbers, sending windows, types)
supabase/        Database migrations (schema, row-level security, functions) + database tests
legacy/, server/, Whatsapp Automation/   the old prototype (no longer used — safe to delete)
```

## Features

**Team & access**
- Company workspace with roles: Owner, Admin, Member, Viewer; suspend or remove members without losing history
- **Personal member spaces** — members see their own leads, numbers and campaigns plus what you share with them
  (or switch on “members see every lead”)
- Add members directly (account + password) or by invite link; **teams** (e.g. “Sales Lahore”)
- **Sharing**: lead lists, campaigns, automations, templates and WhatsApp numbers can be shared with members or
  whole teams with *view* or *manage* access
- Per-member permissions: lead finder, campaigns, WhatsApp, import/export, deleting leads, max numbers, daily message cap
- **Team chat**: channels (public/private, #general), direct & group messages, @mentions, reactions, share a lead

**WhatsApp**
- Connect by **QR code** or **8-character pairing code**, live in the dashboard
- Sessions stored in the database → survive restarts and redeploys; auto-reconnect with backoff, watchdog,
  single-engine lease so two engines never fight over a session
- Detects WhatsApp’s own restrictions and pauses the number automatically; alerts when a number drops or recovers
- Number health: sent today vs. limit, 7-day delivery/read/reply rates, failures, warm-up progress
- Per-number daily limit and 14-day **warm-up mode**

**Leads**
- Unified lead table with search, 15+ filters, saved views, sorting, bulk actions (stage, owner, tags, lists,
  campaign, verify WhatsApp, export, opt-out, delete) and “select all matching”
- **Lead score 0–100** (Hot/Warm/Cold) tuned to what you sell; Quality filter
- **No duplicates**: phone and Google place ID are unique per workspace; “possible duplicates” finder with merge
- Lead drawer: timeline, notes, tasks, WhatsApp chat, details, socials; CSV import with column mapping; CSV export
- **Pipeline** Kanban with drag-and-drop and deal values; custom stages (drag to reorder)
- **Lead lists** to group and share leads

**Lead finder (Google Maps)**
- Google Places API (recommended) or headless-browser scraping
- Keywords × locations in **any country, city or area** (looked up on OpenStreetMap), live progress and log, stop anytime
- **Deep search**: covers each place map area by area (closer in where it's busy) and remembers searched areas for 90 days,
  so running a search again finds new businesses instead of the same ones; businesses already saved are skipped while loading
- Admins only by default (members need the “Use the lead finder” permission)
- **Qualifier**: minimum rating/reviews, mobile only, skip closed businesses, with/without website, excluded words
- Website enrichment: emails, Instagram, Facebook, LinkedIn…; auto-tagging and owner assignment

**Campaigns**
- 4-step builder: audience → messages → sending → review, with live recipient count and pre-flight checks
- Spintax + variables, **A/B variants**, media attachments, **follow-ups** (only if no reply, drag to reorder)
- Safe sending: random gaps, batch breaks, sending hours & days, typing indicator, verify-before-send,
  stop on reply, skip landlines, rotation across several numbers, daily caps per number/campaign/member
- **No double outreach**: leads already in another active campaign are skipped
- Live monitor: funnel, activity log, recipients, A/B results, per-sender breakdown, add leads, retry failed, export

**Inbox, templates, tasks, automations, reports**
- Shared inbox across all numbers with **a folder per teammate and per team**, Today / Yesterday dividers, the sender's name on
  every message, unread counts, assignment, archive and lead context; emoji reactions both ways
  (see a lead’s 👍, react back from the dashboard)
- Template library (team or personal) with preview against real leads and quality checks
- Tasks (to-do, call, meeting, follow-up) with assignees and due dates
- **Automations**: when (reply, keyword, stage change, campaign ended without reply, new lead) → then (send
  message/template, move stage, assign/round-robin, tag, create task, notify); assign to members/teams; run history
- **Dashboard** and **Reports**: per member, per team, campaign × person, daily charts, CSV export
- Notifications, ⌘K command palette, light/dark theme, responsive layout

## Run it locally

Requirements: Node 22+, Docker (or Colima) and the Supabase CLI.

```bash
npm install
npx playwright install chromium        # for the browser scraper
supabase start                          # local Postgres/Auth/Realtime/Storage; applies all migrations
```

Create `crm-dashboard/.env.local` (see `crm-dashboard/.env.example`) and `engine/.env` (see `engine/.env.example`)
with the values printed by `supabase status`, then:

```bash
npm run dev          # web on http://localhost:3000 + engine
```

Sign up — the first account creates your workspace. Then connect a WhatsApp number under **WhatsApp numbers**.

## Deploy on one server (Oracle Cloud Always Free, or any Ubuntu VM)

Runs the dashboard, the engine and automatic HTTPS (Caddy) with Docker Compose. A free Oracle Ampere VM
(4 OCPU / 24 GB) handles 20+ WhatsApp numbers plus the Google Maps lead finder.

1. **Supabase**: new project → SQL Editor → paste the output of `deploy/supabase-schema.sh` → Run
   (or `supabase link` + `supabase db push`). Set *Authentication → URL configuration → Site URL* to your app URL.
2. **Server**: Ubuntu 24.04, ports 80 and 443 open in the cloud firewall (Oracle: subnet security list).
3. Copy `deploy/oracle/.env.example` to `deploy/oracle/.env` and fill it in. No domain? Use
   `DOMAIN=<ip-with-dashes>.sslip.io`.
4. From this folder: `deploy/oracle/deploy.sh <server-ip> <ssh-key-file>` — installs Docker on the first run,
   uploads the code, builds and starts everything. Run it again to deploy updates; WhatsApp numbers reconnect
   by themselves.

Logs: `ssh ubuntu@<ip> 'cd batsols && sudo docker compose -f deploy/oracle/docker-compose.yml logs -f engine'`

## Deploy (Supabase + Render)

1. **Supabase**: create a project, then from this folder run
   `supabase link --project-ref <ref>` and `supabase db push` (applies `supabase/migrations`).
   In *Authentication → URL configuration* set the Site URL to your web URL.
2. **Render**: *New → Blueprint* → select this repository. `render.yaml` creates
   - `batsols-web` (Node web service) — set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_APP_URL`
   - `batsols-engine` (Docker background worker, always on) — set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
     optionally `GOOGLE_PLACES_API_KEY`
   The engine needs a paid (always-on) instance: free instances sleep and would drop WhatsApp connections.
3. Once your team has joined, set `DISABLE_SIGNUP=true` on the web service. Invite links keep working.

Keep the service-role key secret: it bypasses row-level security and is only used server-side.

## Tests

```bash
npm run test:db                 # 91 database tests: schema, RLS isolation, roles, sharing, reports (PGlite)
npm test -w @batsols/shared     # templating, spintax, phone numbers, sending windows
npm run typecheck
```

## Using WhatsApp responsibly

BatSols links to WhatsApp the same way WhatsApp Web does. WhatsApp does not officially allow automated cold
outreach, so numbers can be restricted or banned if they send too much too fast. The built-in safeguards
(warm-up, limits, random gaps, breaks, variations, verification, opt-out handling) reduce that risk; they can’t
remove it. Use established numbers, keep daily limits modest, and always honour opt-outs. WhatsApp also unlinks
devices whose phone stays offline for about 14 days. Scraping Google Maps directly is against Google’s terms; the
Places API source is the compliant option.
