# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Winston — AI Companion App

Winston is a personal AI companion app with a dark-themed chat interface. Users type messages, get Claude AI responses, and hear them spoken via ElevenLabs TTS.

### Required Secrets
- `ANTHROPIC_API_KEY` — Claude AI for conversation
- `ELEVENLABS_API_KEY` — ElevenLabs text-to-speech
- `ELEVENLABS_VOICE_ID` — ElevenLabs voice ID

### Anthropic Model Policy
- **Default model**: `claude-haiku-4-5-20251001` — use for all extraction, parsing, formatting, summarization, scheduled tasks, and simple generation
- **Complex reasoning only**: `claude-sonnet-4-6` — use only when multi-step reasoning or high-quality output is required (morning briefing delivery, calendar parsing, evening check-in, text composition, profile analysis, web_search-based news)
- **Opus is banned in production** — never use any Opus model
- Import from `src/lib/models.ts` (`MODEL_HAIKU`, `MODEL_SONNET`) instead of hardcoding strings

### Features
- Chat with Claude AI (personalized companion system prompt, fully multi-user — no hardcoded names)
- Auto text-to-speech via ElevenLabs with browser TTS fallback
- Typing indicator, replay button, voice input (STT via ElevenLabs Scribe)
- Morning briefings: weather (dynamic city from profile), Gmail, Google Calendar
- On-demand email and calendar queries
- Reminder system with SSE push + recurring support
- **Medication Reminders**: Daily meds (statin + Meloxicam) at 8am, 9am follow-up if not confirmed, DB logging; add/remove/list via conversation; morning briefing includes med reminder if not yet taken
- List management (shopping, to-do, etc.)
- Navigation to saved locations (home, gym, doctor)
- Google OAuth (popup flow) for Gmail + Calendar
- **Multi-Provider Auth** (Phases 1–6, April 2026): Full multi-provider identity system with decoupled integrations and per-user runtime.
  - **Providers**: Google (identity-only scopes), Microsoft (OAuth2 code flow via Microsoft Identity Platform), Apple (Sign in with Apple / `apple-signin-auth`), Email+Password
  - **Sign-in page** (`/`): 2×2 grid — Google | Microsoft / Apple | Demo — plus collapsible email+password form (login/register toggle)
  - **Identity tables**: `google_users` (sub → userName), `microsoft_users` (OID → userName), `apple_users` (sub → userName), `email_users` (email+bcrypt hash → userName)
  - **Integrations table**: `user_integrations` (userName + provider → OAuth tokens; providers: google_calendar, gmail, google_contacts, outlook_calendar, outlook_mail, garmin, google_fit, oura)
  - **Session flow**: any provider → `lookupOrCreate*User()` in `auth/sessionAuth.ts` → `createSession()` → 30-day `app_sessions` → `/?token=<t>&name=<n>&new=<0|1>`
  - **Shared auth middleware**: `auth/middleware.ts` exports `authenticate()` (hard 401) and `tryAuthenticate()` (lenient); used consistently across all route files
  - **Google scope split**: `?signin=1` uses IDENTITY_SCOPES (openid, email, profile only); integration connect uses full SCOPES (calendar, gmail, contacts)
  - **Per-user Google auth**: `getAuthClientForUser(userName)` in `google/oauth.ts` checks `google_auth WHERE user_name = $1`, falls back to global preference
  - **Native bypass**: `x-api-key: winston-native-2026` → "David" still works through all phases for the native app
  - **Per-user runtime** (Phase 6): schedulers loop `getActiveUsers()` from `user_profiles WHERE onboarding_completed = true`; briefings pre-generated per-user at their `wake_time − 5min`; Dallas proactive filtered to Dallas-area users; conversation starters sent per-user with their companion name
  - **Credentials needed to activate Microsoft**: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (env secrets); routes return 503 if missing
  - **Credentials needed to activate Apple**: `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (env secrets); routes return 503 if missing
- **Scam/Phishing Detection**: Every email is analyzed locally before being shown to Emma — brand/domain mismatch, free email impersonation, urgency language, gift card requests, sensitive info requests, typosquatting; high/medium risk emails trigger protective Emma warnings ("David, I want to flag something…"); legitimate emails summarized normally
- **Web Push Notifications** (VAPID keys in env vars `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_EMAIL`): Service worker at `/sw.js`; Bell icon in header; notification permission banner in chat with Emma's warm ask; push triggers: 6am morning briefing, 8am medication reminder, 9am medication follow-up, reminder fires, 9pm wind-down, every 15min weather alerts (NWS API for Dallas); subscription saved in `push_subscriptions` table; notification click opens/focuses Winston
- Story capture: evening memory prompts for Olivia's memory book (51 prompts, saved to DB); stories stored in `stories` table (id, prompt_question, response, captured_at)
- **Olivia Archive** (`/olivia`): Password-protected warm memoir-style page displaying all captured stories in chronological order; password = `OLIVIA_PASSWORD` env var (default: `ForOlivia`); includes Print/Save as PDF; API at `GET /api/stories/archive?password=xxx`; completely separate visual identity (warm cream/parchment, Georgia serif)
- **Personalized Morning News Briefing**: curated news woven into every morning greeting
  - Fetches 6 RSS feeds concurrently: WSJ Markets, BBC World, Google News (Rangers, Cowboys, Dallas local, AI/Tech)
  - Passed raw to Claude which selects 5-6 stories most relevant to David and writes them conversationally
  - Logic: sports score first if game last night → market moves → Dallas local → global → end with AI/tech
  - Tone: trusted friend, not news anchor — explains why each story matters to David personally
  - Zero API keys needed — uses public RSS feeds with 5-second timeout per feed
- **Onboarding Experience**: Full 9-scene conversational onboarding for new users
  - Emma Peel speaks first (unprompted), following an exact script to introduce herself and learn the user
  - Scene 1: Welcome & introduction; Scene 2: Name, city, wake time; Scene 3: People (family/friends with location for weather); Scene 4: Health & wellbeing; Scene 5: Places; Scene 6: What You Love (shows, restaurants, sports, music, hobbies); Scene 7: Voice selection (4 ElevenLabs voices with live preview); Scene 8: Story archive introduction; Scene 9: Personalized first morning briefing
  - Scene progress indicator (thin bar at top, labeled for each scene)
  - Voice input/output throughout — fully conversational
  - All data saved to `user_profiles` table + `profile_items` table for persistent cross-session access
  - New vs. returning user detection: new → onboarding, returning → main Chat
  - On completion, transitions to the main chat interface automatically
  - Dynamic profile system: if user has completed onboarding, their profile drives Emma's system prompt (instead of hardcoded BASE_SYSTEM_PROMPT)
  - DB tables: `user_profiles` (id, user_name, name, city, lat, lon, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed) — `user_name` added April 2026 for multi-user isolation; `getProfile(userName)` filters by user_name; `onboarding/status` endpoint validates session to determine userName before checking profile
- **Profile Management**: David can add/remove/read personal profile items via natural language
  - Categories: Places (with address), Shows (watching), Restaurants (favorites), People, Interests, Other
  - Add: "Ms. Peel add a new place called Chelsea Corner at 6315 La Vista Drive Dallas TX"
  - Add: "Ms. Peel I am watching The Diplomat" / "add Tate's Pizza as a favorite restaurant"
  - Read: "Ms. Peel what places do I have saved" / "what shows am I watching"
  - Remove: "Ms. Peel remove Chelsea Corner from my places"
  - Deduplication: updating an existing item updates its detail instead of creating a duplicate
  - Navigation-aware: places added with an address are automatically available for navigation ("take me to Chelsea Corner")
  - All dynamic items injected into every chat context alongside static profile; Emma reads them naturally
  - DB table: `profile_items` (id, category, name, detail, created_at)
- **Conversation Memory**: Emma remembers what David has talked about across conversations
  - Auto-saves a memory summary at page close (`sendBeacon`) and every 6 user turns as a checkpoint
  - Summaries generated by Claude: health, family, plans, mood, new experiences, follow-up items
  - Last 7 days of memories injected into every conversation's context
  - Emma references memories naturally — "How's the knee today?" not a robotic recitation
  - `conversation_memories` table: one entry per day, updated throughout the day
- **Financial Obligations Tracking**: DB-backed bill tracking with conversational add/list/remove and daily automated reminders
  - Add via natural language: "My Amex bill is due on the 15th of every month" / "quarterly taxes are due" / "track my Netflix subscription"
  - Claude extracts: name, category (credit_card, rent_mortgage, insurance, subscription, quarterly_tax, registration, annual_fee, other), frequency (monthly/quarterly/annual), due day, due months, amount
  - List: "what bills do I have" / "show me my upcoming bills" / "my upcoming payments"
  - Remove: "remove my Amex bill" / "stop tracking Netflix" / "delete my car insurance reminder"
  - Soft-delete (`active=false`) preserves history
  - Daily 9am Central cron checks `reminder_lead_days` before due date: monthly = 3 days, annual = 14 days, quarterly = 30 days
  - Deduplication: skips remind if `last_reminded_date` within past 7 days
  - Morning briefing includes upcoming bills (within 14 days) — only mentioned if something is due within 7 days
  - Fires SSE reminder event + web push notification when bill is approaching
  - DB table: `financial_obligations` (id, user_name, name, category, amount, frequency, due_day, due_months, reminder_lead_days, notes, active, last_reminded_date, created_at)
  - Quarterly tax default dates: April 15, June 15, September 15, January 15
- **Birthday/Anniversary Tracking** (`important_dates` table): Add/list/remove birthdays and anniversaries via conversation; proactive reminders at 14, 7, 3, 0 days before each event at 9am Central; dedup via `date_reminder_log` table; morning briefing includes upcoming dates within 14 days
  - Add: "My daughter's birthday is May 15th" / "our anniversary is June 3rd"
  - List: "what dates do I have coming up" / "show me my important dates"
  - Remove: "remove my sister's birthday" / "delete the anniversary reminder"
  - DB table: `important_dates` (id, user_name, name, event_type, month, day, year, notes, active, created_at)

- **Recommendation Follow-Through** (`recommendations` table): Automatically extracts place/restaurant/show recommendations from Emma's responses and saves them; follow-up prompts in morning briefing for pending items >3 days old; marks as followed-up when David says "went there", "tried it" etc.
  - DB table: `recommendations` (id, user_name, name, category, source_context, recommended_at, followed_up_at, notes)
  - Fire-and-forget post-response extraction: Claude response is analyzed for new recommendations each turn

- **Weekly Sunday Summary**: Special Sunday morning briefing block summarizing the past week — pickleball sessions, story captures, new places added, memory highlights

- **Morning Motivation**: Emma weaves in a motivational or inspirational note tailored to David's week every morning

- **Susan Coordination**: Reminders tagged "Susan" (David's girlfriend) appear in morning briefing as a dedicated block; Susan-related chat context injected for relevant queries

- **Proactive Departure Alerts** (`departure_alert_log` table): Scheduler checks every 2 minutes for upcoming scheduled events with a location; uses OSRM for real-time drive time (Nominatim geocoding + haversine fallback); fires when 10 min before recommended leave time; dedup log prevents repeat alerts
  - DB table: `departure_alert_log` (id, event_id, alerted_at)

- **Market Summary**: Yahoo Finance v7 quote API (no key needed); fetches S&P 500, Dow, Nasdaq, crude oil; 10-minute cache; woven into morning briefing as a brief market pulse
  - Symbols: ^GSPC, ^DJI, ^IXIC, CL=F

- **Pickleball Tracking** (`pickleball_sessions` table): Log sessions via conversation; post-session check-in fires at 11am on Mon/Wed/Fri/Sat if no session logged; knee health check included; recent session summary available in context
  - Log: "just finished pickleball, won 3-1, knee felt fine" / "played pickleball today, knee was a bit sore"
  - DB table: `pickleball_sessions` (id, user_name, session_date, won, score, knee_notes, notes, created_at)

- **Emergency Protocol**: Frontend overlay triggered by keywords ("I've fallen", "call 911", "chest pain", "heart attack" etc.); full-screen dark overlay shows 9-1-1 in large text, David's home address (6345 Diamond Head Circle, Dallas TX 75225), tappable "Call 911 Now" link (`tel:911`), dismiss button; Emma's response also guides David calmly; backend emergency context block added to system prompt

- **Evening Wind-Down**: scheduled proactive conversation at configurable time (default 9 PM CT)
  - Emma initiates with a warm check-in generated by Claude
  - Multi-stage: day check-in → loose ends/notes for tomorrow → story prompt → personalized goodnight
  - Notes captured during wind-down appear in next morning's briefing
  - Settings modal (gear icon in header): time picker + enable/disable toggle
  - Wind-down messages styled with indigo accent + Moon icon

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
