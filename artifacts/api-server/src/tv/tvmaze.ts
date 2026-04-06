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

function localYMD(date: Date, tz = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export async function searchShow(name: string): Promise<TVShow | null> {
  try {
    const res = await fetch(
      `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`
    );
    if (!res.ok) return null;
    const results: any[] = await res.json();
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
    return null;
  }
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
    const episodes: any[] = await res.json();
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
    const episodes: any[] = await res.json();
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
