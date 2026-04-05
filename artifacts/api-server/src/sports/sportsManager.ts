export interface GameResult {
  status: "final" | "in_progress" | "scheduled" | "off_season";
  teamAbbr: string;
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
  sport: "baseball" | "football",
  league: "mlb" | "nfl",
  teamId: string
): Promise<EspnEvent[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule`;
  const fetchedAt = new Date().toISOString();
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  console.log(`[API] ESPN schedule (${league.toUpperCase()} team ${teamId}) — HTTP ${resp.status} at ${fetchedAt}`);
  if (!resp.ok) {
    if (resp.status === 429) console.warn(`RATE LIMIT DETECTED on ESPN (${league.toUpperCase()}) at ${fetchedAt} — HTTP 429`);
    throw new Error(`ESPN schedule error: ${resp.status}`);
  }
  const data = await resp.json() as EspnScheduleResponse;
  return data.events || [];
}

async function fetchTodayScoreboard(
  sport: "baseball" | "football",
  league: "mlb" | "nfl",
  teamAbbr: string
): Promise<EspnEvent | null> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).replace(/-/g, "");
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${today}`;
  const fetchedAt = new Date().toISOString();
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  console.log(`[API] ESPN scoreboard (${league.toUpperCase()} ${teamAbbr}) — HTTP ${resp.status} at ${fetchedAt}`);
  if (!resp.ok) {
    if (resp.status === 429) console.warn(`RATE LIMIT DETECTED on ESPN (${league.toUpperCase()}) at ${fetchedAt} — HTTP 429`);
    return null;
  }
  const data = await resp.json() as { events?: EspnEvent[] };
  const events = data.events || [];
  return events.find((e) =>
    e.competitions?.[0]?.competitors?.some((c) => c.team?.abbreviation === teamAbbr)
  ) ?? null;
}

function formatGameTime(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function parseGameResult(event: EspnEvent, teamAbbr: string): GameResult {
  const comp = event.competitions[0];
  const status = comp.status;
  const team = comp.competitors.find((c) => c.team.abbreviation === teamAbbr)!;
  const opp = comp.competitors.find((c) => c.team.abbreviation !== teamAbbr);
  const isHome = team.homeAway === "home";

  const teamScore = extractScore(team.score);
  const oppScore = opp ? extractScore(opp.score) : undefined;

  const gameDate = event.date.substring(0, 10);
  const gameTime = formatGameTime(event.date);

  const inningOrQuarter =
    status.type.state === "in"
      ? `${status.displayClock ?? ""} Q${status.period ?? ""}`.trim()
      : undefined;

  if (status.type.completed) {
    return {
      status: "final",
      teamAbbr,
      teamScore,
      opponentAbbr: opp?.team.abbreviation,
      opponentScore: oppScore,
      isHome,
      isWin: team.winner === true,
      gameDate,
      gameTime,
    };
  }

  if (status.type.state === "in") {
    return {
      status: "in_progress",
      teamAbbr,
      teamScore,
      opponentAbbr: opp?.team.abbreviation,
      opponentScore: oppScore,
      isHome,
      gameDate,
      gameTime,
      inningOrQuarter,
    };
  }

  return {
    status: "scheduled",
    teamAbbr,
    opponentAbbr: opp?.team.abbreviation,
    isHome,
    gameDate,
    gameTime,
  };
}

export async function fetchRangersScore(): Promise<GameResult> {
  const TEX_ID = "13";

  const todayEvent = await fetchTodayScoreboard("baseball", "mlb", "TEX");
  if (todayEvent) {
    const result = parseGameResult(todayEvent, "TEX");
    if (result.status === "final" || result.status === "in_progress") return result;

    const events = await fetchTeamSchedule("baseball", "mlb", TEX_ID);
    const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
    const last = completed[completed.length - 1];
    const nextGame = {
      date: formatGameDate(result.gameDate!),
      time: result.gameTime,
      opponent: result.opponentAbbr ?? "TBD",
      isHome: result.isHome ?? false,
    };
    if (last) {
      const lastResult = parseGameResult(last, "TEX");
      return { ...lastResult, nextGame };
    }
    return result;
  }

  const events = await fetchTeamSchedule("baseball", "mlb", TEX_ID);
  const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
  const inProgress = events.find((e) => e.competitions?.[0]?.status?.type?.state === "in");
  const upcoming = events.find((e) => !e.competitions?.[0]?.status?.type?.completed && new Date(e.date) > new Date());

  if (inProgress) return parseGameResult(inProgress, "TEX");

  const last = completed[completed.length - 1];
  if (!last) return { status: "off_season", teamAbbr: "TEX" };

  const result = parseGameResult(last, "TEX");
  if (upcoming) {
    const upNext = parseGameResult(upcoming, "TEX");
    result.nextGame = {
      date: formatGameDate(upcoming.date.substring(0, 10)),
      time: upNext.gameTime,
      opponent: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation !== "TEX")?.team.abbreviation ?? "TBD",
      isHome: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation === "TEX")?.homeAway === "home",
    };
  }
  return result;
}

export async function fetchCowboysScore(): Promise<GameResult> {
  const DAL_ID = "6";

  const todayEvent = await fetchTodayScoreboard("football", "nfl", "DAL");
  if (todayEvent) {
    const result = parseGameResult(todayEvent, "DAL");
    if (result.status === "final" || result.status === "in_progress") return result;
  }

  const events = await fetchTeamSchedule("football", "nfl", DAL_ID);
  const completed = events.filter((e) => e.competitions?.[0]?.status?.type?.completed);
  const inProgress = events.find((e) => e.competitions?.[0]?.status?.type?.state === "in");
  const upcoming = events.find((e) => !e.competitions?.[0]?.status?.type?.completed && new Date(e.date) > new Date());

  if (inProgress) return parseGameResult(inProgress, "DAL");

  const last = completed[completed.length - 1];
  if (!last) return { status: "off_season", teamAbbr: "DAL" };

  const result = parseGameResult(last, "DAL");
  if (upcoming) {
    const upNext = parseGameResult(upcoming, "DAL");
    result.nextGame = {
      date: formatGameDate(upcoming.date.substring(0, 10)),
      time: upNext.gameTime,
      opponent: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation !== "DAL")?.team.abbreviation ?? "TBD",
      isHome: upcoming.competitions[0].competitors.find((c) => c.team.abbreviation === "DAL")?.homeAway === "home",
    };
  }
  return result;
}

function formatGameDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function describeResult(g: GameResult, teamName: string): string {
  if (g.status === "in_progress") {
    const loc = g.isHome ? "hosting" : "at";
    return `${teamName} are currently ${loc} the ${g.opponentAbbr} — score ${g.teamScore}–${g.opponentScore}${g.inningOrQuarter ? ` (${g.inningOrQuarter})` : ""}.`;
  }

  if (g.status === "final") {
    const won = g.isWin;
    const verb = won ? "beat" : "lost to";
    const score = (g.teamScore !== undefined && g.opponentScore !== undefined)
      ? (won ? `${g.teamScore}–${g.opponentScore}` : `${g.opponentScore}–${g.teamScore}`)
      : "";
    const when = isToday(g.gameDate!) ? "today" : isYesterday(g.gameDate!) ? "yesterday" : `on ${formatGameDate(g.gameDate!)}`;
    const scoreStr = score ? ` ${score}` : "";
    const next = g.nextGame
      ? ` Next up: ${g.nextGame.isHome ? "home vs" : "at"} ${g.nextGame.opponent} on ${g.nextGame.date}${g.nextGame.time ? ` at ${g.nextGame.time} CT` : ""}.`
      : "";
    return `${teamName} ${verb} the ${g.opponentAbbr}${scoreStr} ${when}.${next}`;
  }

  if (g.status === "scheduled") {
    const loc = g.isHome ? "host" : "visit";
    const when = isToday(g.gameDate!)
      ? (g.gameTime ? `today at ${g.gameTime} CT` : "today")
      : formatGameDate(g.gameDate!);
    return `${teamName} ${loc} the ${g.opponentAbbr} ${when}.`;
  }

  if (g.nextGame) {
    return `${teamName} are in the off-season. Next game: ${g.nextGame.isHome ? "home vs" : "at"} ${g.nextGame.opponent} on ${g.nextGame.date}${g.nextGame.time ? ` at ${g.nextGame.time} CT` : ""}.`;
  }

  return `${teamName} are in the off-season — no upcoming games on the schedule yet.`;
}

function isToday(iso: string): boolean {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return iso === today;
}

function isYesterday(iso: string): boolean {
  const yd = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  return iso === yd;
}

export interface SportsScores {
  rangers: GameResult;
  cowboys: GameResult;
}

export async function fetchSportsScores(): Promise<SportsScores> {
  const [rangers, cowboys] = await Promise.all([
    fetchRangersScore().catch(() => ({ status: "off_season" as const, teamAbbr: "TEX" })),
    fetchCowboysScore().catch(() => ({ status: "off_season" as const, teamAbbr: "DAL" })),
  ]);
  return { rangers, cowboys };
}

export function formatSportsForPrompt(scores: SportsScores): string {
  const rangersLine = describeResult(scores.rangers, "Rangers");
  const cowboysLine = describeResult(scores.cowboys, "Cowboys");

  return (
    `\n\n[Live Sports Scores — fetched just now]\n` +
    `• Texas Rangers (MLB): ${rangersLine}\n` +
    `• Dallas Cowboys (NFL): ${cowboysLine}\n` +
    `\nIMPORTANT: Use ONLY these exact scores. Do NOT add, invent, or recall any other scores. ` +
    `Report exactly what the data says — final score and result, or the exact start time if scheduled. ` +
    `Mention them naturally if David's briefing or question calls for it — e.g. "Rangers lost to Baltimore 8–3 this afternoon" or "Cowboys are in the off-season."`
  );
}
