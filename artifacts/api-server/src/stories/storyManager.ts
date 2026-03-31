import { query } from "../db.js";

export interface Story {
  id: number;
  prompt_question: string;
  response: string;
  captured_at: Date;
}

const STORY_PROMPTS: string[] = [
  "Tell me about where you grew up — the neighborhood, the sounds, what it felt like to be a kid there.",
  "What was your very first job like? What do you remember most about it?",
  "What's one of your favorite memories of Olivia when she was very young?",
  "What was your wedding day like — the moments that stood out, how you felt?",
  "What music were you listening to in your twenties, and what does it remind you of now?",
  "What was the world like when you were Olivia's age?",
  "Tell me about a teacher or mentor who shaped who you are.",
  "What's the bravest thing you've ever done?",
  "What was your childhood home like? What do you miss most about it?",
  "Tell me about the moment you knew you were in love.",
  "What did your parents teach you that you've never forgotten?",
  "What was the hardest thing you've ever had to get through, and what got you through it?",
  "If you could go back and give your twenty-year-old self one piece of advice, what would it be?",
  "What's a place you've traveled that changed the way you see the world?",
  "Tell me about a time you were completely lost — literally or figuratively — and how you found your way.",
  "What are you most proud of in your life so far?",
  "What did a typical summer look like when you were a kid?",
  "Tell me about a friendship that meant the world to you.",
  "What was the first car you ever owned, and what adventures did you have in it?",
  "What traditions from your childhood do you hope Olivia remembers?",
  "What did your family do for holidays when you were growing up?",
  "Tell me about a moment when someone's kindness changed everything for you.",
  "What's a skill or hobby you've had that Olivia might not know about?",
  "Tell me about a book, movie, or song that meant something important to you.",
  "What do you want Olivia to know about you that she might never think to ask?",
  "What was your relationship with your father like?",
  "What was your relationship with your mother like?",
  "Tell me about the day Olivia was born — every detail you can remember.",
  "What was the neighborhood you raised Olivia in like?",
  "What did a perfect Saturday look like when Olivia was little?",
  "What values do you hope you've passed on to Olivia?",
  "Tell me about a time you failed at something and what you learned.",
  "What's the funniest thing Olivia ever said or did when she was small?",
  "What did you dream of becoming when you were a child?",
  "Tell me about a meal — a specific one — that you'll never forget.",
  "What does friendship mean to you, and who has been your truest friend?",
  "Tell me about a moment when you felt completely at peace.",
  "What do you wish you had said to someone you've lost?",
  "If you could relive one day of your life exactly as it was, which would it be?",
  "What's something you believe deeply that the world doesn't always agree with?",
];

interface StoryStateRow {
  pending_prompt: string | null;
  prompt_sent_at: Date | null;
}

export async function getRandomPrompt(): Promise<string> {
  const { rows: usedRows } = await query<{ prompt_question: string }>(
    "SELECT prompt_question FROM stories ORDER BY captured_at DESC LIMIT 20"
  );
  const recentlyUsed = new Set(usedRows.map((r) => r.prompt_question));

  const available = STORY_PROMPTS.filter((p) => !recentlyUsed.has(p));
  const pool = available.length > 0 ? available : STORY_PROMPTS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function getPendingPrompt(): Promise<string | null> {
  const { rows } = await query<StoryStateRow>(
    "SELECT pending_prompt, prompt_sent_at FROM story_state WHERE id = 1"
  );
  if (rows.length === 0 || !rows[0].pending_prompt) return null;

  const sentAt = rows[0].prompt_sent_at;
  if (sentAt) {
    const ageMinutes = (Date.now() - new Date(sentAt).getTime()) / 60000;
    if (ageMinutes > 45) {
      await clearPendingPrompt();
      return null;
    }
  }
  return rows[0].pending_prompt;
}

export async function setPendingPrompt(prompt: string): Promise<void> {
  await query(
    "UPDATE story_state SET pending_prompt = $1, prompt_sent_at = NOW() WHERE id = 1",
    [prompt]
  );
}

export async function clearPendingPrompt(): Promise<void> {
  await query(
    "UPDATE story_state SET pending_prompt = NULL, prompt_sent_at = NULL WHERE id = 1"
  );
}

export async function saveStory(promptQuestion: string, response: string): Promise<Story> {
  const { rows } = await query<Story>(
    "INSERT INTO stories (prompt_question, response) VALUES ($1, $2) RETURNING *",
    [promptQuestion, response]
  );
  return rows[0];
}

export async function getStories(): Promise<Story[]> {
  const { rows } = await query<Story>(
    "SELECT * FROM stories ORDER BY captured_at DESC"
  );
  return rows;
}

export async function getStoryCount(): Promise<number> {
  const { rows } = await query<{ count: string }>(
    "SELECT COUNT(*) as count FROM stories"
  );
  return parseInt(rows[0].count, 10);
}

export function formatStoriesForPrompt(stories: Story[]): string {
  if (stories.length === 0) return "No stories captured yet.";
  return stories
    .map((s, i) => {
      const date = new Date(s.captured_at).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      return `Story ${i + 1} — ${date}\nPrompt: ${s.prompt_question}\n${s.response}`;
    })
    .join("\n\n---\n\n");
}
