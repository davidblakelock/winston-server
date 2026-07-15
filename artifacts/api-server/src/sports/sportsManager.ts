import { getProfile } from "../onboarding/onboardingManager.js";
import { getUserLocationContext } from "../lib/userTimezone.js";

export interface GameResult {
  status: "final" | "in_progress" | "scheduled" | "off_season" | "none";
  teamAbbr: string;
  teamName: string;
  teamScore?: number;
  opponentAbbr?: string;
  opponentScore?: number;
  isHome?: boolean;
  isWin?: boolean;
  gameDate?: string;
  gameTime?: string;
  inningOrQuarter?: string;
  nextGame?: { date: string; time?: string; opponent: string; isHome: boolean };
}

interface EspnCompetitor {
  team: { abbreviation: string; displayName: string };
  score?: { value: number; displayValue: string } | string | number;
  homeAway: "home" | "away";
  winner?: boolean;
}

interface EspnStatus {
  type: {
    description: string;
    state: string;
    completed: boolean;
  };
  displayClock?: string;
  period?: number;
}

interface EspnEvent {
  date: string;
  competitions: Array<{
    competitors: EspnCompetitor[];
    status: EspnStatus;
  }>;
}

interface EspnScheduleResponse {
  events: EspnEvent[];
}

// ── Team lookup table ─────────────────────────────────────────────────────────
// Maps common team names / nicknames to ESPN API parameters.

interface TeamDef {
  fullName: string;
  abbr: string;
  id: string;
  sport: "baseball" | "football" | "basketball" | "hockey" | "soccer";
  league: string;
}

const TEAM_LOOKUP: Record<string, TeamDef> = {
  // ── MLB ───────────────────────────────────────────────────────────────────
  "rangers":          { fullName: "Texas Rangers",        abbr: "TEX", id: "13",  sport: "baseball",    league: "mlb" },
  "texas rangers":    { fullName: "Texas Rangers",        abbr: "TEX", id: "13",  sport: "baseball",    league: "mlb" },
  "astros":           { fullName: "Houston Astros",       abbr: "HOU", id: "18",  sport: "baseball",    league: "mlb" },
  "houston astros":   { fullName: "Houston Astros",       abbr: "HOU", id: "18",  sport: "baseball",    league: "mlb" },
  "yankees":          { fullName: "New York Yankees",     abbr: "NYY", id: "10",  sport: "baseball",    league: "mlb" },
  "red sox":          { fullName: "Boston Red Sox",       abbr: "BOS", id: "2",   sport: "baseball",    league: "mlb" },
  "cubs":             { fullName: "Chicago Cubs",         abbr: "CHC", id: "16",  sport: "baseball",    league: "mlb" },
  "white sox":        { fullName: "Chicago White Sox",    abbr: "CWS", id: "4",   sport: "baseball",    league: "mlb" },
  "dodgers":          { fullName: "Los Angeles Dodgers",  abbr: "LAD", id: "19",  sport: "baseball",    league: "mlb" },
  "giants":           { fullName: "San Francisco Giants", abbr: "SF",  id: "26",  sport: "baseball",    league: "mlb" },
  "sf giants":        { fullName: "San Francisco Giants", abbr: "SF",  id: "26",  sport: "baseball",    league: "mlb" },
  "mets":             { fullName: "New York Mets",        abbr: "NYM", id: "21",  sport: "baseball",    league: "mlb" },
  "braves":           { fullName: "Atlanta Braves",       abbr: "ATL", id: "15",  sport: "baseball",    league: "mlb" },
  "cardinals":        { fullName: "St. Louis Cardinals",  abbr: "STL", id: "24",  sport: "baseball",    league: "mlb" },
  "st. louis cardinals": { fullName: "St. Louis Cardinals", abbr: "STL", id: "24", sport: "baseball",  league: "mlb" },
  "phillies":         { fullName: "Philadelphia Phillies",abbr: "PHI", id: "22",  sport: "baseball",    league: "mlb" },
  "mariners":         { fullName: "Seattle Mariners",     abbr: "SEA", id: "12",  sport: "baseball",    league: "mlb" },

  // ── NFL ───────────────────────────────────────────────────────────────────
  "cowboys":          { fullName: "Dallas Cowboys",       abbr: "DAL", id: "6",   sport: "football",    league: "nfl" },
  "dallas cowboys":   { fullName: "Dallas Cowboys",       abbr: "DAL", id: "6",   sport: "football",    league: "nfl" },
  "eagles":           { fullName: "Philadelphia Eagles",  abbr: "PHI", id: "21",  sport: "football",    league: "nfl" },
  "patriots":         { fullName: "New England Patriots", abbr: "NE",  id: "17",  sport: "football",    league: "nfl" },
  "packers":          { fullName: "Green Bay Packers",    abbr: "GB",  id: "9",   sport: "football",    league: "nfl" },
  "steelers":         { fullName: "Pittsburgh Steelers",  abbr: "PIT", id: "23",  sport: "football",    league: "nfl" },
  "49ers":            { fullName: "San Francisco 49ers",  abbr: "SF",  id: "25",  sport: "football",    league: "nfl" },
  "chiefs":           { fullName: "Kansas City Chiefs",   abbr: "KC",  id: "12",  sport: "football",    league: "nfl" },
  "bears":            { fullName: "Chicago Bears",        abbr: "CHI", id: "3",   sport: "football",    league: "nfl" },
  "giants nfl":       { fullName: "New York Giants",      abbr: "NYG", id: "19",  sport: "football",    league: "nfl" },
  "ny giants":        { fullName: "New York Giants",      abbr: "NYG", id: "19",  sport: "football",    league: "nfl" },
  "texans":           { fullName: "Houston Texans",       abbr: "HOU", id: "34",  sport: "football",    league: "nfl" },
  "houston texans":   { fullName: "Houston Texans",       abbr: "HOU", id: "34",  sport: "football",    league: "nfl" },
  "ravens":           { fullName: "Baltimore Ravens",     abbr: "BAL", id: "33",  sport: "football",    league: "nfl" },
  "broncos":          { fullName: "Denver Broncos",       abbr: "DEN", id: "7",   sport: "football",    league: "nfl" },
  "seahawks":         { fullName: "Seattle Seahawks",     abbr: "SEA", id: "26",  sport: "football",    league: "nfl" },

  // ── NBA ───────────────────────────────────────────────────────────────────
  "mavericks":        { fullName: "Dallas Mavericks",     abbr: "DAL", id: "6",   sport: "basketball",  league: "nba" },
  "mavs":             { fullName: "Dallas Mavericks",     abbr: "DAL", id: "6",   sport: "basketball",  league: "nba" },
  "dallas mavericks": { fullName: "Dallas Mavericks",     abbr: "DAL", id: "6",   sport: "basketball",  league: "nba" },
  "rockets":          { fullName: "Houston Rockets",      abbr: "HOU", id: "10",  sport: "basketball",  league: "nba" },
  "lakers":           { fullName: "Los Angeles Lakers",   abbr: "LAL", id: "13",  sport: "basketball",  league: "nba" },
  "celtics":          { fullName: "Boston Celtics",       abbr: "BOS", id: "2",   sport: "basketball",  league: "nba" },
  "warriors":         { fullName: "Golden State Warriors",abbr: "GSW", id: "9",   sport: "basketball",  league: "nba" },
  "nets":             { fullName: "Brooklyn Nets",        abbr: "BKN", id: "17",  sport: "basketball",  league: "nba" },
  "bulls":            { fullName: "Chicago Bulls",        abbr: "CHI", id: "4",   sport: "basketball",  league: "nba" },
  "knicks":           { fullName: "New York Knicks",      abbr: "NYK", id: "18",  sport: "basketball",  league: "nba" },
  "spurs":            { fullName: "San Antonio Spurs",    abbr: "SAS", id: "24",  sport: "basketball",  league: "nba" },
  "suns":             { fullName: "Phoenix Suns",         abbr: "PHX", id: "21",  sport: "basketball",  league: "nba" },

  // ── NHL ───────────────────────────────────────────────────────────────────
  // IDs verified against https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams
  "stars":            { fullName: "Dallas Stars",         abbr: "DAL", id: "9",   sport: "hockey",      league: "nhl" },
  "dallas stars":     { fullName: "Dallas Stars",         abbr: "DAL", id: "9",   sport: "hockey",      league: "nhl" },
  "blackhawks":       { fullName: "Chicago Blackhawks",   abbr: "CHI", id: "4",   sport: "hockey",      league: "nhl" },
  "bruins":           { fullName: "Boston Bruins",        abbr: "BOS", id: "1",   sport: "hockey",      league: "nhl" },
  "rangers nhl":      { fullName: "New York Rangers",     abbr: "NYR", id: "13",  sport: "hockey",      league: "nhl" },
  "ny rangers":       { fullName: "New York Rangers",     abbr: "NYR", id: "13",  sport: "hockey",      league: "nhl" },
  "penguins":         { fullName: "Pittsburgh Penguins",  abbr: "PIT", id: "16",  sport: "hockey",      league: "nhl" },
  "maple leafs":      { fullName: "Toronto Maple Leafs",  abbr: "TOR", id: "21",  sport: "hockey",      league: "nhl" },
  "canadiens":        { fullName: "Montreal Canadiens",   abbr: "MTL", id: "10",  sport: "hockey",      league: "nhl" },
  "oilers":           { fullName: "Edmonton Oilers",      abbr: "EDM", id: "6",   sport: "hockey",      league: "nhl" },
};

function lookupTeam(name: string): TeamDef | null {
  return TEAM_LOOKUP[name.toLowerCase().trim()] ?? null;
}

// ── ESPN API helpers ──────────────────────────────────────────────────────────

function extractScore(score: EspnCompetitor["score"]): number | undefined {
  if (score === null || score === undefined) return undefined;
  if (typeof score === "number") return score;
  if (typeof score === "string") {
    const n = parseInt(score, 10);
    return isNaN(n) ? undefined : n;
  }
  if (typeof score === "object" && "value" in score) return (score as { value: number }).value;
  return undefined;
}

async function fetchTeamSchedule(
  sport: string,
  league: string,
  teamId: string
): Promise<EspnEvent[]> {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule`;
  const resp = await fetch(base, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`ESPN schedule error: ${resp.status}`);
  const data = await resp.json() as EspnScheduleResponse;
  const events = data.events || [];

  // If the default (postseason) endpoint returns no events the team was
  // eliminated before the current playoffs.  Fall back to regular-season
  // games so we can still report their most recent result.
  if (events.length === 0) {
    const fallback = await fetch(`${base}?seasontype=2`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (fallback?.ok) {
      const fallbackData = await fallback.json() as EspnScheduleResponse;
      return fallbackData.events || [];
    }
  }

  return events;
}

async function fetchTodayScoreboard(
  sport: string,
  league: string,
  teamAbbr: string,
  tz: string
): Promise<EspnEvent | null> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz }).replace(/-/g, "");
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${today}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;
  const data = await resp.json() as { events?: EspnEvent[] };
  const events = data.events || [];
  return events.find((e) =>
    e.competitions?.[0]?.competitors?.some((c) => c.team?.abbreviation === teamAbbr)
  ) ?? null;
}

function formatGameTime(isoDate: string, tz: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatGameDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function isToday(iso: string, tz: string): boolean {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return iso === today;
}

function isYesterday(iso: string, tz: string): boolean {
  const yd = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: tz });
  return iso === yd;
}

function parseGameResult(event: EspnEvent, teamAbbr: string, teamName: string, tz: string): GameResult {
  const comp = event.competitions[0];
  const status = comp.status;
  const team = comp.competitors.find((c) => c.team.abbreviation === teamAbbr)!;
  const opp = comp.competitors.find((c) => c.team.abbreviation !== teamAbbr);
  const isHome = team.homeAway === "home";

  const teamScore = extractScore(team.score);
  const oppScore = opp ? extractScore(opp.score) : undefined;
  const gameDate = event.date.substring(0, 10);
  const gameTime = formatGameTime(event.date, tz);

  const inningOrQuarter =
    status.type.state === "in"
      ? `${status.displayClock ?? ""} Q${status.period ?? ""}`.trim()
      : undefined;

  if (status.type.completed) {
    return { status: "final", teamAbbr, teamName, teamScore, opponentAbbr: opp?.team.abbreviation, opponentScore: oppScore, isHome, isWin: team.winner === true, gameDate, gameTime };
  }

  if (status.type.state === "in") {
    return { status: "in_progress", teamAbbr, teamName, teamScore, opponentAbbr: opp?.team.abbreviation, opponentScore: oppScore, isHome, gameDate, gameTime, inningOrQuarter };
  }

  return { status: "scheduled", teamAbbr, teamName, opponentAbbr: opp?.team.abbreviation, isHome, gameDate, gameTime };
}

// ── Generic single-team fetch ─────────────────────────────────────────────────

async function fetchTeamScore(def: TeamDef, tz = "UTC"): Promise<GameResult> {
  const { sport, league, abbr, id, fullName } = def;

  const todayEvent = await fetchTodayScoreboard(sport, league, abbr, tz);
  if (todayEvent) {
    const result = parseGameResult(todayEvent, abbr, fullName, tz);
    if (result.status === "final" || result.status === "in_progress") return result;
  }

  const events = await fetchTeamSchedule(sport, league, id);
  const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
  const inProgress = events.find((e) => e.competitions?.[0]?.status?.type?.state === "in");
  const upcoming = events.find((e) => !e.competitions?.[0]?.status?.type?.completed && new Date(e.date) > new Date());

  if (inProgress) return parseGameResult(inProgress, abbr, fullName, tz);

  const last = completed[completed.length - 1];
  if (!last) return { status: "off_season", teamAbbr: abbr, teamName: fullName };

  const lastGameDate = last.date.substring(0, 10);
  if (!isYesterday(lastGameDate, tz)) {
    // Most recent completed game wasn't yesterday — nothing worth reporting today.
    return { status: "none", teamAbbr: abbr, teamName: fullName };
  }

  const result = parseGameResult(last, abbr, fullName, tz);
  if (upcoming) {
    const upNext = parseGameResult(upcoming, abbr, fullName, tz);
    result.nextGame = {
      date: formatGameDate(upcoming.date.substring(0, 10)),
      time: upNext.gameTime,
      opponent: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation !== abbr)?.team.abbreviation ?? "TBD",
      isHome: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation === abbr)?.homeAway === "home",
    };
  }
  return result;
}

// ── Named convenience functions kept for backward compat ─────────────────────

export async function fetchRangersScore(): Promise<GameResult> {
  return fetchTeamScore(TEAM_LOOKUP["rangers"]);
}

export async function fetchCowboysScore(): Promise<GameResult> {
  return fetchTeamScore(TEAM_LOOKUP["cowboys"]);
}

// ── Result description ────────────────────────────────────────────────────────

function describeResult(g: GameResult, tz: string): string {
  const name = g.teamName;
  if (g.status === "none") return "";
  if (g.status === "in_progress") {
    const loc = g.isHome ? "hosting" : "at";
    return `${name} are currently ${loc} the ${g.opponentAbbr} — score ${g.teamScore}–${g.opponentScore}${g.inningOrQuarter ? ` (${g.inningOrQuarter})` : ""}.`;
  }
  if (g.status === "final") {
    const won = g.isWin;
    const verb = won ? "beat" : "lost to";
    const score = g.teamScore !== undefined && g.opponentScore !== undefined
      ? won ? `${g.teamScore}–${g.opponentScore}` : `${g.opponentScore}–${g.teamScore}`
      : "";
    const when = isToday(g.gameDate!, tz) ? "today" : isYesterday(g.gameDate!, tz) ? "yesterday" : `on ${formatGameDate(g.gameDate!)}`;
    const scoreStr = score ? ` ${score}` : "";
    const next = g.nextGame
      ? ` Next up: ${g.nextGame.isHome ? "home vs" : "at"} ${g.nextGame.opponent} on ${g.nextGame.date}${g.nextGame.time ? ` at ${g.nextGame.time}` : ""}.`
      : "";
    return `${name} ${verb} the ${g.opponentAbbr}${scoreStr} ${when}.${next}`;
  }
  if (g.status === "scheduled") {
    const loc = g.isHome ? "host" : "visit";
    const when = isToday(g.gameDate!, tz)
      ? g.gameTime ? `today at ${g.gameTime}` : "today"
      : formatGameDate(g.gameDate!);
    return `${name} ${loc} the ${g.opponentAbbr} ${when}.`;
  }
  if (g.nextGame) {
    return `${name} are in the off-season. Next game: ${g.nextGame.isHome ? "home vs" : "at"} ${g.nextGame.opponent} on ${g.nextGame.date}${g.nextGame.time ? ` at ${g.nextGame.time}` : ""}.`;
  }
  return `${name} are in the off-season — no upcoming games on the schedule yet.`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SportsScores {
  rangers: GameResult;
  cowboys: GameResult;
  extra?: GameResult[];
  timezone?: string;
}

/**
 * Fetch sports scores for a user. Reads the user's sportsTeams from their
 * profile and fetches results for all recognized teams.
 * Falls back to Rangers + Cowboys if no profile / no recognized teams.
 */
export async function fetchSportsScores(userName?: string): Promise<SportsScores> {
  const { timezone } = userName
    ? await getUserLocationContext(userName)
    : { timezone: "UTC" };

  let teamNames: string[] = [];

  if (userName) {
    const profile = await getProfile(userName).catch(() => null);
    // sportsTeams is a structured column (string, comma-separated) — split into array
    const rawTeams = profile?.sportsTeams;
    if (rawTeams) {
      teamNames = rawTeams.split(",").map((t) => t.toLowerCase().trim()).filter(Boolean);
    }
  }

  // Always include Rangers + Cowboys as defaults (David's teams)
  const defaultDefs = [TEAM_LOOKUP["rangers"], TEAM_LOOKUP["cowboys"]];

  // Build the list of unique team defs to fetch
  const extraDefs: TeamDef[] = [];
  for (const name of teamNames) {
    const def = lookupTeam(name);
    if (!def) continue;
    const alreadyIncluded =
      defaultDefs.some((d) => d.abbr === def.abbr && d.league === def.league) ||
      extraDefs.some((d) => d.abbr === def.abbr && d.league === def.league);
    if (!alreadyIncluded) extraDefs.push(def);
  }

  const [rangers, cowboys, ...extraResults] = await Promise.all([
    fetchTeamScore(defaultDefs[0], timezone).catch(() => ({ status: "off_season" as const, teamAbbr: "TEX", teamName: "Texas Rangers" })),
    fetchTeamScore(defaultDefs[1], timezone).catch(() => ({ status: "off_season" as const, teamAbbr: "DAL", teamName: "Dallas Cowboys" })),
    ...extraDefs.map((def) => fetchTeamScore(def, timezone).catch(() => ({ status: "off_season" as const, teamAbbr: def.abbr, teamName: def.fullName }))),
  ]);

  return {
    rangers,
    cowboys,
    ...(extraResults.length > 0 ? { extra: extraResults } : {}),
    timezone,
  };
}

export function formatSportsForPrompt(scores: SportsScores): string {
  const tz = scores.timezone ?? "UTC";
  const rangersLine = describeResult(scores.rangers, tz);
  const cowboysLine = describeResult(scores.cowboys, tz);

  const baseLines = [
    scores.rangers.status !== "none" ? `• ${scores.rangers.teamName} (${scores.rangers.teamAbbr === "TEX" ? "MLB" : ""}): ${rangersLine}` : null,
    scores.cowboys.status !== "none" ? `• ${scores.cowboys.teamName} (${scores.cowboys.teamAbbr === "DAL" ? "NFL" : ""}): ${cowboysLine}` : null,
  ].filter((line): line is string => line !== null);

  const extraLines = (scores.extra ?? [])
    .filter((g) => g.status !== "none")
    .map((g) => `• ${g.teamName}: ${describeResult(g, tz)}`);

  const allLines = [...baseLines, ...extraLines];
  if (allLines.length === 0) return "";

  return (
    `\n\n[VERIFIED — Sports API — Live Scores, fetched just now]\n` +
    allLines.join("\n") +
    `\n\nThis is VERIFIED data. Use ONLY these exact scores. Do NOT add, invent, or recall any other scores. ` +
    `Report exactly what the data says — final score and result, or the exact start time if scheduled. ` +
    `Mention them naturally if the user's briefing or question calls for it.`
  );
}
