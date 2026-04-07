/**
 * Normalize text before sending to ElevenLabs TTS.
 * Converts abbreviations, symbols, and formats into fully speakable words.
 * All replacements run in order — more specific patterns come first.
 */
export function normalizeTtsText(text: string): string {
  let s = text;

  // ── Currency ───────────────────────────────────────────────────────────────
  // $1,250.50 → "1250 dollars and 50 cents"
  s = s.replace(/\$(\d[\d,]*)\.(\d{2})\b/g, (_, dollars, cents) =>
    `${dollars.replace(/,/g, "")} dollars and ${cents} cents`
  );
  // $50 → "50 dollars"
  s = s.replace(/\$(\d[\d,]*)\b/g, (_, n) => `${n.replace(/,/g, "")} dollars`);

  // ── Temperature ───────────────────────────────────────────────────────────
  // 68°F / 68F → "68 degrees Fahrenheit"
  s = s.replace(/(\d+(?:\.\d+)?)\s*°?\s*F\b/g, "$1 degrees Fahrenheit");
  // 20°C / 20C → "20 degrees Celsius"
  s = s.replace(/(\d+(?:\.\d+)?)\s*°?\s*C\b/g, "$1 degrees Celsius");
  // Bare degree symbol: 72° → "72 degrees"
  s = s.replace(/(\d+(?:\.\d+)?)\s*°/g, "$1 degrees");

  // ── Percentages ───────────────────────────────────────────────────────────
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent");

  // ── Time ─────────────────────────────────────────────────────────────────
  // 10:30 AM → "10 30 AM"  /  10:00 → "10 00"  (ElevenLabs reads colons awkwardly)
  s = s.replace(/\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/g, "$1 $2 $3");
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, "$1 $2");

  // ── Address abbreviations ─────────────────────────────────────────────────
  // Order matters: more specific (e.g. "Blvd") before shorter ones ("Bl")
  // Trailing period optional; word boundary required to avoid false positives.

  // "Dr." before a name (Doctor context) vs "Dr" after a number/street (Drive)
  // Heuristic: if preceded by a digit → Drive; if preceded by a person title prefix → Doctor
  s = s.replace(/\b([A-Z][a-z]+)\s+Dr\.?\b(?=\s+[A-Z]|$|,)/g, "$1 Drive"); // "Oak Dr" → Drive
  s = s.replace(/\bDr\.?\s+([A-Z])/g, "Doctor $1");                          // "Dr. Smith" → Doctor

  s = s.replace(/\bBlvd\.?\b/g, "Boulevard");
  s = s.replace(/\bAve\.?\b/g, "Avenue");
  s = s.replace(/\bRd\.?\b/g, "Road");
  s = s.replace(/\bLn\.?\b/g, "Lane");
  s = s.replace(/\bCt\.?\b/g, "Court");
  s = s.replace(/\bPl\.?\b/g, "Place");
  s = s.replace(/\bHwy\.?\b/g, "Highway");
  s = s.replace(/\bFwy\.?\b/g, "Freeway");
  s = s.replace(/\bPkwy\.?\b/g, "Parkway");
  s = s.replace(/\bSte\.?\b/g, "Suite");

  // "St." before a name → Saint; "St" at end of address → Street
  s = s.replace(/\bSt\.?\s+([A-Z])/g, "Saint $1");   // "St. Patrick" → Saint Patrick
  s = s.replace(/\bSt\.?\b/g, "Street");              // "Main St" → Main Street

  // ── Common text symbols ───────────────────────────────────────────────────
  s = s.replace(/&/g, "and");
  s = s.replace(/#(\d+)/g, "number $1");    // #5 → number 5
  s = s.replace(/\bNo\.\s*(\d+)/g, "number $1"); // No. 4 → number 4

  // ── Ordinals (written as digits) ─────────────────────────────────────────
  // Leave these — ElevenLabs handles "1st", "2nd", "3rd", "4th" fine.

  // ── Markdown artifacts ───────────────────────────────────────────────────
  // Strip bold/italic markers that sometimes leak into spoken text
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/\*(.+?)\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/_(.+?)_/g, "$1");

  // ── Whitespace cleanup ───────────────────────────────────────────────────
  s = s.replace(/\s{2,}/g, " ").trim();

  return s;
}
