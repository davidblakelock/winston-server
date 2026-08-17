export interface TVShow {
  id: number;
  name: string;
  network: string | null;
  genres: string[];
  status: string;
  summary?: string;
}

export interface ScheduledEpisode {
  showId: number;
  showName: string;
  season: number;
  number: number;
  episodeLabel: string;
  title: string;
  airtime: string;
  network: string;
  airedAt?: string; // ISO timestamp from TVmaze airstamp — used for 48-hour staleness check
}

function localYMD(date: Date, tz = "UTC"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const RETRY_DELAYS_MS = [500, 1500]; // 3 attempts total

// A show stuck with tvmaze_id = null used to be caught only by the once-a-day
// backfill sweep (backfillMissingTvmazeIds in showManager.ts) — fine as a
// backstop, but confirmed live that a single flaky/rate-limited call here was
// the actual cause for 5 of 8 watched shows (including well-known titles like
// Ted Lasso, not just ambiguous ones), so a same-day episode could be missed
// entirely before the backfill ever got a chance to run. Retrying here fixes
// it at the source instead of leaning on that backstop.
export async function searchShow(name: string): Promise<TVShow | null> {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(
        `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`
      );
      if (!res.ok) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        return null;
      }
      const results = await res.json() as any[];
      if (!results.length) return null;
      const show = results[0].show;
      return {
        id: show.id,
        name: show.name,
        network: show.network?.name ?? show.webChannel?.name ?? null,
        genres: show.genres ?? [],
        status: show.status ?? "Unknown",
        summary: show.summary?.replace(/<[^>]*>/g, "").slice(0, 300) ?? undefined,
      };
    } catch {
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function getScheduleForDate(
  dateStr: string,
  watchedIds: number[]
): Promise<ScheduledEpisode[]> {
  if (!watchedIds.length) return [];
  try {
    const res = await fetch(
      `https://api.tvmaze.com/schedule?country=US&date=${dateStr}`
    );
    if (!res.ok) return [];
    const episodes = await res.json() as any[];
    return episodes
      .filter((ep) => watchedIds.includes(ep.show?.id))
      .map((ep) => ({
        showId: ep.show.id,
        showName: ep.show.name,
        season: ep.season,
        number: ep.number,
        episodeLabel: `S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`,
        title: ep.name ?? "",
        airtime: ep.airtime ?? "",
        network:
          ep.show.network?.name ?? ep.show.webChannel?.name ?? "streaming",
        airedAt: ep.airstamp ?? undefined,
      }));
  } catch {
    return [];
  }
}

export async function getWebScheduleForDate(
  dateStr: string,
  watchedIds: number[]
): Promise<ScheduledEpisode[]> {
  if (!watchedIds.length) return [];
  try {
    const res = await fetch(
      `https://api.tvmaze.com/schedule/web?date=${dateStr}`
    );
    if (!res.ok) return [];
    const episodes = await res.json() as any[];
    return episodes
      .filter((ep) => watchedIds.includes(ep._embedded?.show?.id))
      .map((ep) => {
        const show = ep._embedded?.show ?? {};
        return {
          showId: show.id,
          showName: show.name,
          season: ep.season,
          number: ep.number,
          airedAt: ep.airstamp ?? undefined,
          episodeLabel: `S${String(ep.season).padStart(2, "0")}E${String(ep.number).padStart(2, "0")}`,
          title: ep.name ?? "",
          airtime: ep.airtime ?? "",
          network: show.webChannel?.name ?? show.network?.name ?? "streaming",
        };
      });
  } catch {
    return [];
  }
}

export async function fetchEpisodesForDate(
  date: Date,
  watchedIds: number[]
): Promise<ScheduledEpisode[]> {
  const dateStr = localYMD(date);
  const [broadcast, web] = await Promise.all([
    getScheduleForDate(dateStr, watchedIds),
    getWebScheduleForDate(dateStr, watchedIds),
  ]);
  const seen = new Set<string>();
  const all: ScheduledEpisode[] = [];
  for (const ep of [...broadcast, ...web]) {
    const key = `${ep.showId}-${ep.episodeLabel}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(ep);
    }
  }
  return all;
}

export function formatEpisodeForPrompt(ep: ScheduledEpisode): string {
  const time = ep.airtime ? ` at ${ep.airtime}` : "";
  const title = ep.title ? ` — "${ep.title}"` : "";
  return `${ep.showName} (${ep.episodeLabel}${title}) on ${ep.network}${time}`;
}
