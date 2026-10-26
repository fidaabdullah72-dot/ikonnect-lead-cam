# BatWos — Build Plan

Goal: turn the current prototype into a hosted, multi-user SaaS for the company's marketing team.
Team members log in, connect **their own WhatsApp by scanning a QR code in the browser**, find leads
on Google Maps, and run safe, trackable WhatsApp campaigns. All of it runs on Render.

---

## 1. Where the project is today

| Part | State | Main problems |
|---|---|---|
| `crm-dashboard/` (Next.js 16) | UI shell only | Every page uses hard-coded demo data; nothing is saved; buttons only show toasts; no login |
| `server/` (Flask + Selenium) | Prototype | All state in memory (lost on restart); WhatsApp needs a visible Chrome window, so it **cannot run on Render** and cannot show a QR in the dashboard; phone numbers stored as raw local digits (`0300…`), which WhatsApp rejects; one global sender for everyone; no auth on any endpoint |
| `Whatsapp Automation/` | Old Streamlit bulk sender | Superseded |
| Database | None | Neither existing Supabase project (BATsols, BATROS Admin) has CRM tables |

## 2. Target architecture

```
                ┌────────────────────────────┐
  Browser  ───► │  Web app  (Next.js 16)     │  Render Web Service
  (team)        │  UI · auth · API routes    │
                └─────────────┬──────────────┘
                              │ Supabase JS (Row-Level Security)
                ┌─────────────▼──────────────┐
                │  Supabase                  │  Postgres · Auth · Realtime · Storage
                │  (the "command bus")       │
                └─────────────▲──────────────┘
                              │ service-role key
                ┌─────────────┴──────────────┐
                │  Engine  (Node worker)     │  Render Background Worker (Docker, always on)
                │  • WhatsApp sessions (QR)  │
                │  • Campaign scheduler      │
                │  • Google Maps scraper     │
                │  • Website enrichment      │
                └────────────────────────────┘
```

**Key decisions**

1. **One language (TypeScript) for everything.** The engine is rewritten in Node because the best
   server-side WhatsApp library (Baileys) is Node-only. Baileys talks to WhatsApp directly, with no
   browser, so it uses little memory, runs headless on Render, and many team members can each
   connect their own number at the same time.
2. **The database is the command bus.** The web app never calls the engine directly. It writes
   intent rows ("connect this WhatsApp", "send this reply", "start campaign", "run scrape job"), the
   engine picks them up, and results flow back to the browser through Supabase Realtime. Campaigns
   keep running when nobody has the dashboard open, and nothing is lost if the engine restarts.
3. **WhatsApp sessions are stored in Postgres**, not on disk, so redeploys and restarts don't log
   anyone out (Render disks are wiped on deploy).
4. **Two scraping providers:**
   - **Google Places API (recommended on Render):** reliable, fast, ToS-compliant, and has a free monthly allowance.
   - **Headless browser (Playwright):** scrolls Google Maps like the current Selenium scraper does.
5. **Multi-tenant from day one.** Everything belongs to a *workspace* with role-based access,
   enforced inside the database by Row-Level Security, not just in the UI.

## 3. Roles & permissions

| | Owner | Admin | Member | Viewer |
|---|:-:|:-:|:-:|:-:|
| View leads, pipeline, analytics | ✓ | ✓ | ✓ | ✓ |
| Create/edit leads, notes, tasks | ✓ | ✓ | ✓ | – |
| Connect own WhatsApp, run own campaigns, reply in inbox | ✓ | ✓ | ✓ | – |
| Use any team WhatsApp number, manage all campaigns | ✓ | ✓ | shared numbers only | – |
| Invite/remove members, change roles, workspace settings | ✓ | ✓ | – | – |
| Delete workspace, transfer ownership | ✓ | – | – | – |

## 4. Feature list (what "complete" means)

### Auth & team
- Email/password sign-up/login, protected routes, session refresh
- Workspace creation on first sign-up; optional `DISABLE_SIGNUP` once the team is set up
- Invite teammates by link (no email server needed), choose role, revoke invites
- Members page: change role, remove member, see each member's connected numbers
- Profile: name, password change; light/dark theme

### WhatsApp accounts (per team member)
- **Connect via QR code shown in the dashboard**, refreshed live; or connect with an **8-character pairing code** (phone number login)
- Live status: connecting / waiting for scan / connected / disconnected / logged out
- Multiple numbers per workspace, labelled; "share with team" toggle
- Per-number daily limit and **warm-up mode** (limit ramps up over 14 days for new numbers)
- Sent-today counter, last activity, disconnect/logout, auto-reconnect after restarts

### Leads
- One unified leads table (replaces the two "with/without website" tables)
- Phone numbers normalised to international format (`+92…`), mobile vs landline detection
- **WhatsApp number check**: mark which leads actually have WhatsApp (bulk, rate-limited)
- Search, filters (stage, has website, city, category, tags, owner, WhatsApp status, rating, source), sort, server-side pagination
- Saved quick views: All · Has website · No website · My leads · Unassigned · Replied
- Bulk actions: assign owner, add/remove tags, change stage, add to campaign, verify WhatsApp, export CSV, delete
- CSV import with column mapping + duplicate detection; manual add/edit
- Lead drawer: details, activity timeline, notes, tasks, WhatsApp chat thread, quick send, deal value
- Opt-out flag (auto-set when a lead replies STOP/unsubscribe)

### Pipeline
- Kanban with drag-and-drop, **custom stages** (name, colour, order, won/lost)
- Deal value per lead with column totals; filter by owner/tag
- Auto-move: New → Contacted when messaged, → Replied when they answer

### Scraper (Google Maps)
- Job builder: keywords × locations (preset categories and cities + free text), results per query, provider
- Live progress, live log console, stats (found / new / duplicates / with website / without)
- Cancel a running job; job history; jump to the leads a job created
- Dedup by phone and Google place ID within the workspace; auto-tag leads by keyword and city
- Optional **website enrichment**: visit the lead's site to find email and Instagram/Facebook/LinkedIn links

### Templates
- Message template library with variables `{{business_name}}`, `{{city}}`, `{{website}}`, `{{category}}`, `{{owner_name}}`…
- **Spintax** `{Hi|Hello|Salam}` so every message is unique (anti-ban)
- Live preview against a real lead; character count; warnings for links in first messages

### Campaigns
- 5-step builder: Audience → Message → Follow-ups → Sending → Review
  - Audience: filters (same as leads table) or hand-picked leads; live count; excludes opted-out and already-contacted leads
  - Message: up to 5 A/B variants with spintax, optional image/document attachment
  - Follow-ups: automatic follow-up steps after N days *only if no reply*
  - Sending: choose sender numbers (rotation across several numbers), random delay min/max, batch pause (e.g. 10 min every 20 messages), daily cap, sending window (e.g. 10:00–19:00, Mon–Sat, timezone), typing simulation, skip landlines, verify WhatsApp before sending
  - Review & launch now or schedule for later
- Campaign detail: live progress, funnel (queued → sent → delivered → read → replied), per-variant stats, recipient table with per-lead status and errors, pause / resume / cancel / duplicate
- Runs entirely on the server; stops a sequence for a lead the moment they reply

### Team inbox
- All WhatsApp conversations with leads across the team's numbers, live (Realtime)
- Unread counts, filters (mine, unassigned, by number), search
- Chat view with delivery ticks (sent/delivered/read), reply box, quick-insert templates
- Side panel with the lead's details and stage changer; assign conversation to a teammate

### Dashboard & analytics
- KPIs: leads, new this week, messages sent today, delivery rate, read rate, reply rate, meetings, won value
- Charts: messages per day (sent/delivered/read/replied), pipeline funnel, leads by city/category, campaign leaderboard, **team leaderboard** (per member: sent, replies, won)
- Recent activity feed

### Productivity & polish
- Tasks & reminders (per lead, assignable, due dates, "My tasks" view)
- In-app notifications (new reply, campaign finished, scrape finished, WhatsApp disconnected)
- **⌘K command palette** (jump to pages, search leads, quick actions)
- Engine health indicator (online/offline) in the sidebar
- Responsive layout (works on a phone), keyboard-friendly, skeleton loading states, empty states

### Team chat (internal)
- Channels (group chats) — `#general` by default, create public or private channels, add/remove members
- Direct messages (1:1 and small groups) between teammates
- @mentions with notifications, emoji reactions, edit/delete own messages, unread counts, live updates
- Share a lead into a chat (renders as a lead card that opens the lead)

### Lead qualifier & data quality
- **Lead score 0–100** with tiers *Hot / Warm / Cold*, recalculated automatically, based on: mobile number,
  verified WhatsApp, Google rating & review count, website presence (matched to what you sell), email found,
  replies — weights configurable per workspace
- **Qualification rules on every lead search**: minimum rating/reviews, mobile numbers only, skip businesses
  without a phone, skip permanently-closed listings, exclude name keywords (e.g. chains)
- **No duplicates**: phone and Google place ID are unique per workspace (enforced by the database), plus a
  *Possible duplicates* view (same name + city, same website) with one-click merge
- **No double outreach**: a lead already in another team member's active campaign is skipped by default

### Automations
- Rules: *when* (reply received · reply contains keyword · stage changed · campaign finished without reply ·
  new lead created) → *do* (send template · move stage · assign owner · add tag · create task · notify team)
- Optional auto-reply outside working hours; every run logged

### WhatsApp reliability ("connect once, stay connected")
- Sessions stored in Postgres (survive restarts and redeploys)
- Automatic reconnect with exponential backoff, immediate restart on WhatsApp's "restart required" signal,
  watchdog that recreates stuck sockets, keep-alive pings
- **Single active engine lease**: during a Render redeploy the new engine waits for the old one to hand over,
  because two engines on one session make WhatsApp log the device out
- Alerts when a number drops and when it recovers; number health page (sent today, delivery/read/reply rate,
  failures, warm-up progress)
- Note: WhatsApp itself unlinks devices if the phone stays offline for ~14 days; the app warns before that

### Later / optional (after the core is done)
- AI message writer and AI reply suggestions (needs an Anthropic API key)
- Outgoing webhooks and a public API for other tools
- Email channel

## 5. Anti-ban safeguards built into the engine
Random human-like delays · batch pauses · per-number daily caps · warm-up for new numbers ·
sending windows · spintax + message variants · typing indicator before each message ·
skip numbers not on WhatsApp · stop on reply · opt-out keywords · automatic 1-hour back-off if
WhatsApp rate-limits · rotation across several numbers.

> **Be aware:** automating WhatsApp through WhatsApp Web (what QR-scan tools do) is not officially
> sanctioned by WhatsApp, so numbers can be banned if they send too much cold outreach. The
> safeguards reduce that risk; they can't remove it. Use warmed-up numbers and modest daily limits.
> Likewise, scraping Google Maps directly is against Google's terms; the Places API provider is the
> compliant option.

## 6. Data model (Supabase)

`workspaces` · `workspace_members` (role) · `workspace_invites` · `profiles` ·
`pipeline_stages` · `leads` · `lead_notes` · `tasks` · `activities` ·
`whatsapp_accounts` · `wa_auth_keys` (engine-only) · `conversations` · `messages` ·
`message_templates` · `campaigns` · `campaign_steps` · `campaign_recipients` ·
`scrape_jobs` · `engine_jobs` · `notifications` · `engine_status`

Every table carries `workspace_id`, and RLS policies restrict all reads/writes to members of that
workspace with the right role. `wa_auth_keys` is never readable from the browser.

## 7. Repository layout

```
Lead Crm/
├─ PLAN.md · README.md · render.yaml · package.json (npm workspaces)
├─ supabase/migrations/      SQL schema, RLS, functions, triggers
├─ supabase/tests/           RLS & schema tests (run locally with PGlite)
├─ packages/shared/          template/spintax rendering, phone utils, sending-window logic, types
├─ crm-dashboard/            Next.js web app (rebuilt in TypeScript)
├─ engine/                   Node worker: WhatsApp, campaigns, scraper, enrichment
├─ server/                   legacy Python prototype (superseded, delete when happy)
└─ Whatsapp Automation/      legacy Streamlit sender (superseded)
```

## 8. Tech stack
- **Web:** Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, Radix UI
  primitives, lucide icons, TanStack Query, Recharts, cmdk, sonner, dnd-kit
- **Engine:** Node 22, TypeScript, Baileys 7, Playwright (Chromium), libphonenumber-js, pino
- **Data:** Supabase Postgres + Auth + Realtime + Storage
- **Hosting:** Render Blueprint (`render.yaml`): web service + Docker background worker

## 9. Build phases

| # | Phase | Delivers |
|---|---|---|
| 0 | Foundation | Monorepo, DB schema + RLS + tests, auth, workspaces, roles, app shell, design system |
| 1 | Leads & pipeline | Leads table, filters, bulk actions, drawer, notes, tasks, import/export, Kanban, custom stages |
| 2 | WhatsApp | Engine skeleton, Baileys sessions in Postgres, QR + pairing-code connect UI, single send, inbound capture, delivery receipts, team inbox |
| 3 | Campaigns | Templates, builder wizard, scheduler with all safeguards, follow-ups, detail page, analytics |
| 4 | Scraper | Places API + Playwright providers, job builder, live console, enrichment, dedup |
| 5 | Team & quality | Team chat, lead scoring & qualifier, duplicate merge, saved segments, automations |
| 6 | Insights | Dashboard, analytics, team leaderboard, number health, notifications polish |
| 7 | Ship | Dockerfile, `render.yaml`, env docs, README/runbook, security review, full end-to-end QA on a local Supabase stack |

**Design direction:** enterprise-grade and clean. One consistent design system (tokens for light and dark
themes), lucide line icons and custom SVG illustrations (no emoji), Inter typography, generous spacing, and
dense-but-calm data tables.

Each phase ends with type-checks, a production build, and automated tests passing.

## 10. What I need from you (not blocking the build)
1. **A Supabase project for the CRM.** Your org already has 2 projects (the free-plan limit), so either
   pause one, create a new free org, or upgrade. I can create it and apply the schema for you once you confirm.
2. **A Google Places API key** (Google Cloud → enable "Places API (New)") if you want the recommended scraper on Render.
3. **A Render account.** The engine needs an always-on instance (Starter, ~$7/mo) because free
   instances sleep and would drop WhatsApp connections. The web app can start on the free tier.

## 11. Verification strategy
- Unit tests (Vitest) for spintax/templating, phone normalisation, sending-window and throttle logic
- Database tests run the real migrations in PGlite (in-process Postgres) and prove workspace isolation under RLS
- `tsc` + `next build` for the web app, `tsc` for the engine, on every phase
- Things that need real accounts (scanning a QR, sending to a phone, Places API) are listed in the
  README as a manual go-live checklist
