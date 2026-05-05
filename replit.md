# Winston — AI Companion App

Winston is a personal AI companion app with a dark-themed chat interface that provides Claude AI responses and ElevenLabs TTS.

## Run & Operate

- **Run Dev Server**: `pnpm --filter @workspace/api-server run dev`
- **Build**: `pnpm run build` (runs typecheck, then builds all packages)
- **Typecheck**: `pnpm run typecheck` (runs `tsc --build --emitDeclarationOnly` from root)
- **Codegen**: `pnpm --filter @workspace/api-spec run codegen`
- **DB Push**: `pnpm --filter @workspace/db run push` (or `push-force` for fallback)

**Required Environment Variables**:
- `ANTHROPIC_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` (for Web Push)
- `OLIVIA_PASSWORD` (default: `ForOlivia`)
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (if Microsoft auth enabled)
- `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (if Apple auth enabled)

## Stack

- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **TypeScript**: 5.9
- **API Framework**: Express 5
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM
- **Validation**: Zod (`drizzle-zod`)
- **API Codegen**: Orval (from OpenAPI spec)
- **Build Tool**: esbuild

## Where things live

- **API Server**: `artifacts/api-server/`
- **Database Schema**: `lib/db/src/schema/`
- **OpenAPI Spec**: `lib/api-spec/openapi.yaml`
- **Generated API Client (React Query)**: `lib/api-client-react/src/generated/`
- **Generated Zod Schemas**: `lib/api-zod/src/generated/`
- **Shared Libraries**: `lib/`
- **Utility Scripts**: `scripts/`
- **Drizzle Config**: `lib/db/drizzle.config.ts`

## Architecture decisions

- **Anthropic Model Policy**: Use `claude-haiku-4-5-20251001` for most tasks; `claude-sonnet-4-6` only for complex reasoning or high-quality output; Opus models are banned. Models are imported from `src/lib/models.ts`.
- **Multi-Provider Authentication**: Decoupled identity system with separate tables for Google, Microsoft, Apple, and Email+Password users, enabling per-user runtime and integration management.
- **Per-user Runtime**: Schedulers loop through active users and pre-generate briefings/send conversation starters based on individual profiles and wake times.
- **TypeScript Monorepo**: Utilizes `composite: true` and project references for efficient type-checking and build management across packages. `tsc --build --emitDeclarationOnly` is used for type-checking only; esbuild handles actual JS bundling.
- **Proactive Departure Alerts**: Uses OSRM for real-time drive time calculations for scheduled events with locations, alerting users 10 minutes before recommended departure.

## Product

- Chat with a personalized Claude AI companion.
- Text-to-speech via ElevenLabs (with browser TTS fallback) and voice input via ElevenLabs Scribe.
- Personalized morning briefings (weather, Gmail, Calendar, News).
- Medication, Financial Obligation, and Important Date (birthdays/anniversaries) reminders with conversational management and SSE/push notifications.
- List management (shopping, to-do) and navigation to saved locations.
- Google OAuth integration for Gmail and Calendar.
- Multi-provider authentication (Google, Microsoft, Apple, Email+Password).
- Scam/phishing detection for emails with proactive warnings.
- Web push notifications for reminders and briefings.
- Story capture and a password-protected "Olivia Archive" for memories.
- Conversational onboarding experience for new users, populating a dynamic user profile.
- Natural language profile management (places, shows, restaurants, people, interests).
- Cross-conversation memory and weekly summaries.
- Proactive alerts for departures, market summaries, and pickleball tracking.
- Emergency protocol overlay triggered by keywords.
- Evening wind-down routine with customizable settings.

## User preferences

- _Populate as you build_

## Gotchas

- **Typechecking**: Always run `pnpm run typecheck` from the root to ensure correct cross-package type resolution. Running `tsc` inside a single package might fail if dependencies are not built.
- **Microsoft/Apple Auth**: Routes will return `503` if required environment variables (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, etc.) are not set for these providers.
- **Anthropic Models**: Never use any Opus model in production. Adhere strictly to the model policy in `src/lib/models.ts`.
- **Database Migrations**: Production migrations are handled by Replit. In development, use `pnpm --filter @workspace/db run push` or `push-force`.

## Pointers

- **Drizzle ORM Docs**: [https://orm.drizzle.team/docs/overview](https://orm.drizzle.team/docs/overview)
- **Orval Docs**: [https://orval.dev/](https://orval.dev/)
- **Zod Docs**: [https://zod.dev/](https://zod.dev/)
- **Anthropic API Docs**: [https://docs.anthropic.com/](https://docs.anthropic.com/)
- **ElevenLabs API Docs**: [https://docs.elevenlabs.io/](https://docs.elevenlabs.io/)
- **OpenAPI Specification**: [https://swagger.io/specification/](https://swagger.io/specification/)