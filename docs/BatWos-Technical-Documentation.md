# BatWos — Technical Documentation

Tech stack, architecture, deployment and operations of **BatWos**, the Google Maps lead-generation and
WhatsApp-campaign CRM for teams. Written for developers and whoever runs the servers.

> **This repository is the Contabo deployment.** A second, completely separate copy of the same code runs on Oracle Cloud under its own brand, with its own servers, Supabase project and repository (see section 10). Changes here never touch it.

---

## 1. What the product does

- **Lead finder** — searches Google Maps (Google Places API or a headless browser) for businesses by keyword ×
  location anywhere in the world, qualifies them (rating, reviews, mobile number, website) and saves them as leads.
- **Leads & lists** — one lead table with 15+ filters, saved filters, lead score (Hot/Warm/Cold), pipeline (Kanban),
  CSV import/export, duplicate finder, and **lead lists** to group, share, message and track leads.
- **WhatsApp** — every teammate links their own number by QR or pairing code (like WhatsApp Web). Sessions are
  stored in the database and survive restarts.
- **Campaigns** — audience (lead lists, filters or hand-picked) → messages (spintax, variables, A/B, media,
  follow-ups) → sending rules (pacing, hours, daily caps, warm-up, rotation) → live monitor and reports.
- **Inbox, automations, tasks, team chat, reports** — shared inbox per teammate/team, if-this-then-that automations,
  tasks, internal chat, per-member/per-team/per-campaign reports.

## 2. Architecture

```
            Browser (team members)
                    │ HTTPS
                    ▼
     ┌──────────────────────────────┐
     │ Caddy 2  (automatic HTTPS)   │
     │   └─► web: Next.js 16 app    │  dashboard UI + API routes (auth, team)
     └──────────────┬───────────────┘
                    │ supabase-js (user's session → row-level security)
                    ▼
     ┌──────────────────────────────┐        ┌───────────────────────────────┐
     │ Supabase (managed)           │◄──────►│ engine: Node 22 worker        │
     │  Postgres + RLS + functions  │ service│  WhatsApp sessions (Baileys)  │
     │  Auth, Realtime, Storage     │  role  │  campaign runner, outbox      │
     └──────────────────────────────┘        │  inbound + reply detection    │
                                             │  automations, jobs            │
                                             │  lead finder (Places/Chromium)│
                                             └───────┬───────────────────────┘
                                                     │
                         WhatsApp servers ◄──────────┤
                         Google Places / Maps ◄──────┤
                         OpenStreetMap Nominatim ◄───┘  (turns locations into map areas)
```

- The **web app** never talks to WhatsApp. It writes rows (a campaign, an outbox message, a job) and the engine picks
  them up. Database triggers write to `engine_signals`, so the engine reacts within a second instead of polling.
- The **engine** runs as exactly **one** instance per database: it holds a lease (`engine_acquire_lease`) so two
  engines never fight over the same WhatsApp session.
- **Realtime** pushes changes (messages, campaign progress, number status) to open dashboards.

## 3. Tech stack

| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | 22+ |
| Language | TypeScript | 5.9.3 |
| Monorepo | npm workspaces (`packages/*`, `crm-dashboard`, `engine`) | — |
| Web framework | Next.js (App Router, `proxy.ts`) | 16.3.8 |
| UI | React | 19.2.8 |
| Styling | Tailwind CSS (PostCSS plugin) | 4 |
| Components | Radix UI, lucide-react icons, cmdk (⌘K), sonner (toasts), dnd-kit (drag & drop) | 1.6 / 1.50 / 1.1 / 2.0 / 6–10 |
| Data fetching | TanStack Query | 5.104 |
| Charts | Recharts | 3.10 |
| Forms / validation | zod | 4.6 |
| CSV | papaparse | 5.7 |
| Database / auth / realtime / storage | Supabase (Postgres 15+, GoTrue, Realtime, Storage) | supabase-js 2.117, @supabase/ssr 0.12 |
| WhatsApp | Baileys (WhatsApp Web multi-device protocol) | 7.0.0-rc14 |
| Lead finder | Google Places API (New) · Playwright Chromium (browser mode) | playwright 1.63 |
| Images | sharp | 0.35 |
| Phone numbers | libphonenumber-js | 1.13 |
| Logging | pino | 10.4 |
| Engine bundling | esbuild | 0.28 |
| Tests | Vitest 5 · PGlite (in-process Postgres for database tests) | 5.0 / 0.5 |
| Containers | Docker + Docker Compose | — |
| HTTPS | Caddy 2 (Let's Encrypt) · sslip.io hostname when there is no domain | 2 |
| Server OS | Ubuntu 24.04 | — |

## 4. Repository layout

```
crm-dashboard/        Next.js web app
  app/                routes: (auth) login/signup, (app) dashboard, leads, lists, campaigns, inbox, scraper,
                      automations, templates, tasks, reports, settings, whatsapp; api/ (team, auth)
  components/         feature folders (leads, lists, campaigns, inbox, whatsapp, …) + ui/ primitives
  lib/                Supabase clients, React Query hooks, filters, workspace/permissions context
engine/               background worker (src/index.ts is the entry point)
  src/wa/             WhatsApp sessions (session.ts), manager, auth state in the database, message content
  src/messaging/      inbound.ts (replies, receipts, automatic-reply detection), outbox.ts (manual sends)
  src/campaigns/      runner.ts (pacing, rotation, follow-ups, limits, stop on reply)
  src/automations/    automation rules
  src/scraper/        lead finder: Places API, browser scraping, areas/geocoding, qualifier, website enrichment
  src/jobs/           background jobs (verify numbers, bulk actions, …)
packages/shared/      code used by both: types, templating/spintax, phone numbers, sending windows, constants
supabase/migrations/  database schema, row-level security, functions — applied in filename order
supabase/tests/       database tests (schema, RLS isolation, roles, sharing, reports, replies, lists)
deploy/               server scripts (deploy.sh, deploy-micro.sh, deploy-patch.sh, docker-compose.yml, Caddyfile)
                      and supabase-schema.sh (all migrations as one SQL file)
BatWos-Supabase-Schema.sql  every migration in one file, for a brand-new Supabase project
```

> Internal identifiers keep the original technical name `batsols` (npm scope `@batsols/*`, Docker images
> `batsols-web` / `batsols-engine`, server folder `~/batsols`, the `x-batsols-automation` header the database
> triggers look for). They are invisible to users; renaming them would make the next deploy start a second engine
> next to the running one and break automation triggers.

## 5. Data model and security

Main tables: `workspaces`, `workspace_members` (roles owner/admin/member/viewer, per-member permissions), `teams`,
`leads`, `pipeline_stages`, `lead_lists` + `lead_list_items`, `saved_views`, `campaigns`, `campaign_steps`,
`campaign_recipients`, `campaign_events`, `whatsapp_accounts`, `conversations`, `messages`, `automations`,
`message_templates`, `tasks`, `activities`, `notifications`, `scrape_jobs`, `chat_*`, `resource_access` (sharing),
`engine_status` / `engine_signals`.

- **Row-level security** on every table. The browser uses the user's own session, so a member only sees what their
  role and the sharing rules allow (own leads/numbers/campaigns + shared lists, campaigns, numbers, templates).
- **Business logic in SQL functions** (called with `rpc`): `filtered_leads` (every lead filter), `campaign_add_recipients`,
  `lead_list_add`, `lead_list_stats`, `dashboard_overview`, `report_*`, `account_health`, `inbox_folders`, `merge_leads`, …
- The **service-role key** is used only by the engine and the web app's server routes. It bypasses RLS: never ship it
  to the browser or commit it.
- **Storage** bucket `media` holds campaign attachments and incoming WhatsApp media.

### Reply detection (how a "reply" is counted)

1. Incoming WhatsApp messages are saved in `messages` (`direction = 'in'`). Receipts set `status` and, when the message
   reaches the lead's phone, `delivered_at`.
2. System notices (calls, status mentions, placeholders, history notices, …) are ignored: they are not something the
   lead typed.
3. **Automatic replies**: WhatsApp Business greeting/away messages are sent by the lead's phone the moment our message
   arrives. A message that comes **within 20 seconds of our campaign message being sent or delivered** is saved with
   `auto_reply = true`, shown in the chat as "automatic reply", logged in the campaign activity, and **not** counted:
   follow-ups continue, the lead stays in its stage, and reports/dashboards/number health leave it out.
4. A real reply counts for a campaign only if that campaign **already messaged the lead, from the same number, before
   the reply**. (Before this fix, any message from the lead marked every campaign containing the lead as "replied",
   including campaigns that had not messaged them yet.)
5. Opt-out keywords still cancel every campaign for that lead.

### WhatsApp safe mode (always on)

Numbers linked through WhatsApp Web are banned when they message many strangers quickly, look up many unknown numbers,
or get reported. The engine enforces these rules for every campaign, old ones included (`packages/shared`
`SAFE_PACE`, `safeDailyLimit`, `SAFE_CHECKS_PER_DAY`):

| Rule | Value |
|---|---|
| Gap between two messages from one number | at least 2 minutes (default 2.5–5 minutes), never regular |
| Break | at least 15 minutes after at most 10 messages (default 20 minutes after 8) |
| New numbers (first 14 days, or after warm-up is switched on) | 10 a day (days 1–4), 20 (days 5–8), 40 (days 9–14) |
| Any number | at most 80 messages a day |
| "Is this number on WhatsApp?" look-ups | off by default before sending; at most 100 per number per day, 20–40 seconds apart; numbers already checked are not looked up again |
| WhatsApp restricts a number | it rests at least 48 hours and its daily limit is halved (minimum 10) |
| WhatsApp rate limit, or 5 failed sends in a row | the number rests 6 hours and the owner is notified |
| Human-like behaviour | "online" only while sending, typing indicator, blue ticks 5–90 seconds after a lead's message |

Not possible for free: a different, residential IP per number. All numbers on a server share its data-centre IP (extra
IPv6 addresses from the same /64 are treated by WhatsApp as the same network). The free way to get a home/office IP is
to run only the engine on a computer at the office (the web app stays on the server); a residential or mobile proxy per
number is the paid way.

### Lead lists

- **Import a CSV straight into a list** (Lead lists → Import CSV, or the list's menu). Leads that already exist are not
  duplicated but are added to the list too, so the list always matches the file.
- **Message a list**: campaign builder → Audience → **Lead lists** (pick one or more, optionally narrow with filters).
  From a list card: **Campaign** (new campaign with that list) or **Add to a running campaign**. A campaign's
  "Add leads" dialog also has **From lead lists**.
- **Track a list**: each card shows leads, how many can be messaged, contacted, replied (reply rate), in campaigns
  (active), won, opted out and the campaigns that used it (`lead_list_stats`). The campaign page shows which lists its
  audience came from.

## 6. Engine internals

| Part | File | What it does |
|---|---|---|
| Start-up, lease, signals | `src/index.ts`, `lease.ts`, `signals.ts` | single-engine lease; wakes workers on database signals |
| WhatsApp sessions | `src/wa/session.ts`, `manager.ts`, `auth-state.ts` | QR/pairing, credentials in DB, reconnect with backoff, watchdog, restriction detection |
| Campaign runner | `src/campaigns/runner.ts` | claims recipients, verifies numbers, renders spintax/variables, typing indicator, random gaps, batch breaks, sending windows, daily caps, follow-ups, stop on reply |
| Outbox | `src/messaging/outbox.ts` | messages typed in the dashboard |
| Inbound | `src/messaging/inbound.ts` | replies, own phone messages, reactions, receipts, automatic-reply detection, opt-outs, stage moves, notifications |
| Automations | `src/automations/runner.ts` | triggers (reply, keyword, stage change, no reply, new lead) → actions |
| Lead finder | `src/scraper/*` | Places API or Chromium; area splitting ("deep search"), qualifier, enrichment |

## 7. Environment variables

Server file `deploy/oracle/.env` (copy `deploy/oracle/.env.example`; git-ignored, never committed):

| Variable | Used by | Meaning |
|---|---|---|
| `DOMAIN` | Caddy, web | public host name, e.g. `<ip-with-dashes>.sslip.io` |
| `SUPABASE_URL` | web, engine | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | web (browser) | public anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | engine, web server | secret key — bypasses RLS |
| `GOOGLE_PLACES_API_KEY` | engine | optional default key (workspaces can set their own) |
| `DISABLE_SIGNUP` | web | `true` stops new workspaces; invite links still work |
| `SCRAPER_BROWSER`, `ENGINE_ROLE`, `LOG_LEVEL`, `GEOCODER_URL`, `GEOCODER_EMAIL` | engine | optional, see `engine/.env.example` |

Local development: `crm-dashboard/.env.local` (see `.env.example`) and `engine/.env` (see `engine/.env.example`).

## 8. Deployment of this instance (Contabo)

| | |
|---|---|
| App address | https://169-58-17-43.sslip.io |
| Server | Contabo Cloud VPS `169.58.17.43` — Ubuntu 24.04, 4 vCPU / 8 GB, user `ubuntu`, SSH key `~/.ssh/contabo-crm.key` (password login disabled) |
| Services on the server | `web`, `engine` (incl. lead finder with Chromium), `caddy` — one Docker Compose stack |
| Supabase project | `tzsikldxqgytlkxhhgfu` (https://tzsikldxqgytlkxhhgfu.supabase.co) |
| Git repository | https://github.com/fidaabdullah72-dot/ikonnect-lead-cam |
| Local folder | `~/Documents/Own Products/iKonnect Lead Cam` |
| Server folder | `~/batsols` (Docker Compose project `batsols`) |

### Deploy an update

From this project's folder on the Mac (never from the other project's folder):

```bash
deploy/oracle/deploy.sh 169.58.17.43 ~/.ssh/contabo-crm.key
```

The script prepares the server (Docker, firewall, swap) on the first run, uploads the code with rsync
(secrets and local files excluded), copies `deploy/oracle/.env`, rebuilds the images on the server and restarts
the stack. A full deploy takes ~5–10 minutes. (The folder is called `deploy/oracle` for historical reasons; it works on
any Ubuntu VM.)

### Database updates

New migrations live in `supabase/migrations/`. For each release there is a ready-to-paste file in the project root
(for this release: `Database-Update-26-Oct.sql`). Run it **in this instance's Supabase project only**
(`tzsikldxqgytlkxhhgfu`) → SQL Editor → New query → paste → Run. It is one transaction and safe to run twice.
**Run the database update first, then deploy the code.** (The engine copes with the update missing — it simply cannot
flag automatic replies until it is applied — but the list statistics need it.)

A brand-new Supabase project: paste `BatWos-Supabase-Schema.sql` (generate it with
`deploy/supabase-schema.sh > BatWos-Supabase-Schema.sql`) and set *Authentication → URL configuration → Site URL* to the app address.

### Operations

```bash
# logs
ssh -i ~/.ssh/contabo-crm.key ubuntu@169.58.17.43 'cd batsols && sudo docker compose -f deploy/oracle/docker-compose.yml --env-file deploy/oracle/.env logs -f --tail 200 engine'
# status of the containers
ssh -i ~/.ssh/contabo-crm.key ubuntu@169.58.17.43 'cd batsols && sudo docker compose -f deploy/oracle/docker-compose.yml --env-file deploy/oracle/.env ps'
```

- **WhatsApp numbers** reconnect by themselves after a deploy or restart (sessions are in the database).
- **Rollback**: check out the previous commit locally and run the deploy command again.
- **Backups**: Supabase takes daily backups of the database (Project → Database → Backups).
- **Never** run two engines against the same Supabase project, and never point this server at the other instance's
  database.

## 9. Local development and tests

```bash
npm install
npx playwright install chromium   # browser lead finder
supabase start                    # local Postgres/Auth/Realtime/Storage with all migrations
npm run dev                       # web on http://localhost:3000 + engine
npm test                          # shared + engine unit tests and 129 database tests (PGlite)
npm run build                     # production build (also generates Next.js route types)
npm run typecheck                 # after a build
```

## 10. Two separate deployments

The same code runs as two independent businesses. They share **nothing** at runtime:

| | Oracle instance | Contabo instance |
|---|---|---|
| Brand shown to users | CoreNexa | BatWos |
| Local folder | `Lead Crm` | `iKonnect Lead Cam` |
| Git repository | github.com/Abdullah-Fida/Lead-Crm | github.com/fidaabdullah72-dot/ikonnect-lead-cam |
| Supabase project | `lzmfwesnsusxbktvpoku` | `tzsikldxqgytlkxhhgfu` |
| Servers | 141.148.55.67 (web + lead finder), 193.122.220.74 (engine) | 169.58.17.43 (everything) |
| Deploy | `deploy-patch.sh` / `deploy-micro.sh` | `deploy.sh` |

Feature changes meant for both are committed, database-updated and deployed **separately** in each folder. Each
folder has its own `deploy/oracle/.env` with its own keys.

## 11. Release notes — 26 Oct 2026

- **Reply detection fixed**: automatic WhatsApp Business replies are no longer counted; replies count only for the
  campaign and number that messaged the lead; system notices are ignored; past data corrected by the database update
  (recipients that never really replied are put back so their follow-ups continue; leads moved to "Replied" only by an
  automatic reply go back to "Contacted").
- **Lead lists in campaigns**: Lead lists audience in the campaign builder, "From lead lists" when adding leads,
  "Campaign" / "Add to a running campaign" from a list.
- **Import lists**: CSV import goes into a new or existing list (default: a new list named after the file), including
  leads that already existed.
- **List tracking**: per-list contacted / replied / in campaigns / won / campaigns used; campaigns show their lists.
- **Branding**: every user-facing "BatSols" is now **BatWos** (page titles, logo text, login/sign-up, settings,
  WhatsApp notices, engine messages, docs). Internal technical names stay `batsols` (see section 4).
  Also update the name in Supabase → Authentication → Email templates if they mention the old name.

## 12. Release notes — 29 Oct 2026

- **WhatsApp safe mode** (see section 5): enforced pacing, warm-up for new numbers, max 80 a day, limited number
  look-ups, 48-hour rest and halved limit after a restriction, auto-pause after failures, human-like presence and read
  receipts.
- **How many leads**: send a campaign to only the best-scored N matching leads (100, 200, 300, … or any number).
