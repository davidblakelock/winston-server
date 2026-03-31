# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Winston — AI Companion App

Winston is a personal AI companion app with a dark-themed chat interface. Users type messages, get Claude AI responses, and hear them spoken via ElevenLabs TTS.

### Required Secrets
- `ANTHROPIC_API_KEY` — Claude AI for conversation
- `ELEVENLABS_API_KEY` — ElevenLabs text-to-speech
- `ELEVENLABS_VOICE_ID` — ElevenLabs voice ID

### Features
- Chat with Claude Opus (personalized Emma Peel system prompt for David Blakelock)
- Auto text-to-speech via ElevenLabs with browser TTS fallback
- Typing indicator, replay button, voice input (STT via ElevenLabs Scribe)
- Morning briefings: weather (Dallas + Knoxville), Gmail, Google Calendar
- On-demand email and calendar queries
- Reminder system with SSE push + recurring support
- **Medication Reminders**: Daily meds (statin + Meloxicam) at 8am, 9am follow-up if not confirmed, DB logging; add/remove/list via conversation; morning briefing includes med reminder if not yet taken
- List management (shopping, to-do, etc.)
- Navigation to saved locations (home, gym, doctor)
- Google OAuth (popup flow) for Gmail + Calendar
- **Magic Link Auth** (multi-device): `magic_link_tokens` + `app_sessions` tables; `POST /api/auth/magic-link` returns a one-tap URL (+ sends email if `RESEND_API_KEY` set); `POST /api/auth/magic-link/verify` creates a 30-day session; `GET /api/auth/session` validates; session token in localStorage (`winston_session_token`); `setAuthTokenGetter` wired via `useAuth` hook so all API calls auto-include `Authorization: Bearer`; allowed emails: `davidblakelock.winston@gmail.com`; magic link URL built from `REPLIT_DEV_DOMAIN`/`REPLIT_DOMAINS`/`APP_URL`
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
  - DB tables: `user_profiles` (id, name, city, lat, lon, timezone, wake_time, voice_id, health_notes, raw_data, onboarding_completed)
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
