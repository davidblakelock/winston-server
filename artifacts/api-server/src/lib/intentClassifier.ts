import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./models.js";

const anthropic = new Anthropic();

// ── Result shape ──────────────────────────────────────────────────────────────

export interface MessageClassification {
  morning_greeting: boolean;
  evening_greeting: boolean;
  emergency: boolean;

  reminder_list: boolean;
  reminder_set: boolean;

  list_modify: boolean;
  list_type: "shopping" | "to-do" | "grocery" | "errand" | "task" | null;
  casual_list_add: boolean;
  list_share: boolean;

  email: boolean;
  call: boolean;
  text_compose: boolean;

  calendar_read: boolean;
  calendar_create: boolean;
  calendar_modify: boolean;
  calendar_delete: boolean;
  dinner_tonight: boolean;

  contact_lookup: boolean;
  contact_save: boolean;
  contact_compound_save: boolean;
  google_contact_write: boolean;

  story_read: boolean;
  story_count: boolean;
  olivia_call: boolean;
  olivia_mention: boolean;

  trip_plan: boolean;
  trip_save: boolean;
  hotel_availability: boolean;
  hotel_swap: boolean;
  trip_price_query: boolean;

  profile_update: boolean;

  tv_add: boolean;
  tv_remove: boolean;
  tv_tonight: boolean;
  tv_recommend: boolean;
  tv_list: boolean;

  med_taken: boolean;
  med_add: boolean;
  med_list: boolean;
  med_remove: boolean;
  med_mute: boolean;
  med_unmute: boolean;
  med_reschedule: boolean;

  wake_time_change: boolean;
  briefing_pref: boolean;

  news_dig: boolean;
  news_story_number: number;

  sports: boolean;
  markets: boolean;
  weather: boolean;
  weather_city: string | null;

  local_events: boolean;
  restaurant_reco: boolean;
  nearby_places: boolean;
  restaurant_intel: boolean;

  bill_add: boolean;
  bill_list: boolean;
  bill_remove: boolean;

  myday_get: boolean;
  myday_add: boolean;

  date_add: boolean;
  date_list: boolean;
  date_remove: boolean;

  headache: boolean;

  journal_review: boolean;
  transcript_search: boolean;
  transcript_search_term: string | null;

  briefing_followup: boolean;
  navigation: boolean;

  goal: boolean;
  winddown_note: boolean;

  sms_retry: boolean;
  sms_edit: boolean;
  reservation_cal_add: boolean;
}

export interface ClassificationContext {
  requestContext: string;
  hasActiveTripPlan: boolean;
  hasStoredHeadlines: boolean;
  hasCachedBriefing: boolean;
}

// Safe fallback — all false/null/0 — routes to general chat
const SAFE_DEFAULT: MessageClassification = {
  morning_greeting: false, evening_greeting: false, emergency: false,
  reminder_list: false, reminder_set: false,
  list_modify: false, list_type: null, casual_list_add: false, list_share: false,
  email: false, call: false, text_compose: false,
  calendar_read: false, calendar_create: false, calendar_modify: false,
  calendar_delete: false, dinner_tonight: false,
  contact_lookup: false, contact_save: false, contact_compound_save: false,
  google_contact_write: false,
  story_read: false, story_count: false, olivia_call: false, olivia_mention: false,
  trip_plan: false, trip_save: false, hotel_availability: false,
  hotel_swap: false, trip_price_query: false,
  profile_update: false,
  tv_add: false, tv_remove: false, tv_tonight: false, tv_recommend: false, tv_list: false,
  med_taken: false, med_add: false, med_list: false, med_remove: false,
  med_mute: false, med_unmute: false, med_reschedule: false,
  wake_time_change: false, briefing_pref: false,
  news_dig: false, news_story_number: 0,
  sports: false, markets: false, weather: false, weather_city: null,
  local_events: false, restaurant_reco: false, nearby_places: false, restaurant_intel: false,
  bill_add: false, bill_list: false, bill_remove: false,
  myday_get: false, myday_add: false,
  date_add: false, date_list: false, date_remove: false,
  headache: false,
  journal_review: false, transcript_search: false, transcript_search_term: null,
  briefing_followup: false,
  navigation: false,
  goal: false, winddown_note: false,
  sms_retry: false, sms_edit: false, reservation_cal_add: false,
};

const LIST_TYPES = new Set(["shopping", "to-do", "grocery", "errand", "task"]);

// ── Main export ───────────────────────────────────────────────────────────────

export async function classifyMessage(
  message: string,
  ctx: ClassificationContext,
): Promise<MessageClassification> {
  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 500,
      system:
`You are an intent classifier for a personal AI companion. Return ONE JSON object classifying the user message.
ALL fields required. Return ONLY valid JSON — no markdown, no commentary.

PRIORITY RULES (apply first):
1. morning_greeting=true → set ALL other fields false/null/0.
2. emergency=true → morning_greeting=false, evening_greeting=false; other flags still allowed.
3. trip_save over trip_plan — "yes go ahead", "build it" after discussing a trip → trip_save=true, trip_plan=false.
4. reminder_list over reminder_set — "what are my reminders" → reminder_list=true, reminder_set=false.
5. calendar_create over calendar_modify — explicit add/create/schedule wins.
6. restaurant_reco over local_events — restaurant question → reco=true, local_events=false.

FIELD DEFINITIONS:
morning_greeting: message STARTS with morning greeting — "good morning", "morning briefing", "just woke up", "waking up". Do NOT fire mid-sentence "morning" e.g. "update my morning preferences".
evening_greeting: evening wind-down — "good evening", "winding down", "heading to bed", "calling it a night", "good night", "goodnite", "wrapping up".
emergency: life-threatening — "call 911", "chest pain", "can't breathe", "I've fallen", "heart attack", "stroke", "I need an ambulance", "I've been hurt".
reminder_list: wants to SEE reminders — "what are my reminders", "show reminders", "do I have any reminders".
reminder_set: wants to CREATE a reminder — "remind me to X", "set a reminder", "don't let me forget".
list_modify: explicit list op — add/remove/clear/show a named list. list_type = "shopping"|"to-do"|"grocery"|"errand"|"task" or null.
casual_list_add: implicit list add — "as well", "throw in", "also add/get/grab", ends with "too".
list_share: send/share a list via connect.
email: check email/inbox — "check my email", "any emails", "what's in my inbox".
call: make a phone call — "call Mom", "phone John". NOT "call 911".
text_compose: compose/send a text — "text Susan", "send a message to Mom", "shoot John a text".
calendar_read: read schedule — "what's on my calendar", "what do I have today", "am I free tomorrow".
calendar_create: create new event — "add a meeting", "schedule lunch", "put on calendar".
calendar_modify: reschedule/change existing event — "move my appointment", "reschedule", "push back my meeting".
calendar_delete: cancel/delete event — "cancel my appointment", "delete the meeting".
dinner_tonight: dinner plans query — "what's for dinner", "dinner plans", "where should I eat tonight".
contact_lookup: look up contact info — "who is John", "find John's number".
contact_save: save someone as a contact — "save John as a contact", "add Susan to contacts".
contact_compound_save: look up AND save a contact in the same message.
google_contact_write: write/update Google Contacts specifically.
story_read: read Olivia stories/archive — "read me a story", "show the archive".
story_count: count stories — "how many stories do I have".
olivia_call: mentioned calling/FaceTiming/talking to Olivia (daughter) — "called Olivia", "talked to Olivia".
olivia_mention: any mention of the name "Olivia" anywhere in the message.
trip_plan: plan a new trip — "plan me a trip to X", "I want to plan a vacation to Y".
trip_save: save/build/confirm itinerary — "yes go ahead", "build it", "save this trip", "create the itinerary", "make it".
hotel_availability: search for hotels — "find me a hotel", "hotels in Dallas", "check hotel availability".
hotel_swap: swap/change a hotel in itinerary${ctx.requestContext === "trip-planning" ? " [TRIP CONTEXT ACTIVE — watch carefully]" : ""} — "swap the hotel", "change to the Omni", "use a different hotel".
trip_price_query: asking hotel/trip cost — "how much does it cost", "nightly rate", "per night price".
profile_update: update personal profile — add/remove places, restaurants, shows, people, interests, doctors, service providers.
tv_add: started watching / add show — "I started watching X", "I'm watching X now", "add X to my shows".
tv_remove: stopped watching / remove show — "I finished X", "I stopped watching X".
tv_tonight: what's on tonight — "what's on tonight", "next episode of X".
tv_recommend: recommend a show — "what should I watch", "recommend something".
tv_list: list shows — "what am I watching", "show my watch list".
med_taken: confirmed taking meds (SHORT ≤12 words) — "took my meds", "meds done", "took them".
med_add: add a new medication — "add lisinopril 10mg", "start taking Metformin".
med_list: list medications — "what medications do I take", "list my meds".
med_remove: stop/remove medication — "stop taking X", "remove X from my medications".
med_mute: turn off medication reminders — "stop medication reminders", "don't remind me about meds".
med_unmute: re-enable medication reminders — "remind me about meds again".
med_reschedule: change medication reminder time — "change my med reminder to 9am", "move pill reminder to 8pm".
wake_time_change: change wake-up time — "change my wake-up time to 7am", "I wake up at 8 now".
briefing_pref: change morning briefing preferences — "add weather to my briefing", "remove news from briefing".
news_dig: wants details on a specific morning news story${ctx.hasStoredHeadlines ? " [HEADLINES AVAILABLE]" : " [NO HEADLINES — set false]"} — "tell me more about story 3", "dig into number 2". news_story_number = story number 1–10 or 0.
sports: sports scores — Rangers or Cowboys — "how did the Rangers do", "Cowboys score".
markets: stock market — "how are the markets", "S&P 500", "Dow Jones", "market update".
weather: weather query — "what's the weather", "will it rain", "temperature outside". weather_city = city name if specified (e.g. "Houston" from "weather in Houston") or null.
local_events: what's happening locally — "what's going on this weekend", "things to do", "local events".
restaurant_reco: recommend a restaurant — "where should I eat", "recommend a restaurant", "good places to eat nearby".
nearby_places: essential places near user — pharmacy, urgent care, hospital, grocery, gas station, ATM near me.
restaurant_intel: info about a specific named restaurant, or making a reservation — "make a reservation at X", "directions to X restaurant".
bill_add: add/track a bill or financial obligation — "my electric bill is due on the 15th", "track my Netflix subscription", "my rent is due".
bill_list: list bills — "what bills do I have", "show upcoming payments".
bill_remove: remove/stop tracking a bill — "remove my cable bill", "stop tracking Netflix".
myday_get: get today's focus/priorities — "what's my priority today", "my day log", "what did I add to my day".
myday_add: add to today's focus — "add this to my day", "log this for today", "note that".
date_add: add a birthday or anniversary — "Susan's birthday is June 5", "my anniversary is July 4".
date_list: list birthdays/anniversaries — "what birthdays are coming up", "any anniversaries".
date_remove: remove a birthday/anniversary — "remove Susan's birthday".
headache: health symptom — "I have a headache", "my head is killing me", "migraine", "body aches", "feeling achy", "feeling off".
journal_review: read/review journal entries — "read my journal", "show my journal entries", "what did I journal".
transcript_search: recall past conversation — "what did I say about X", "what did we discuss last week", "remind me what I said about Y". transcript_search_term = the topic to search (stripped of meta-language) or null.
briefing_followup${ctx.hasCachedBriefing ? " [BRIEFING ACTIVE]" : " [NO BRIEFING — set false]"}: follow up on morning briefing — "tell me more", "more about that", "what's the full story", "more details on", "dig into", "what happened with". ONLY when briefing context is active.
navigation: get directions — "take me to X", "directions to X", "navigate to X", "how do I get to X".
goal: personal goal setting — "I want to start reading more", "I need to exercise", "I should call my parents more".
winddown_note: note for tomorrow's briefing — "remember to X tomorrow", "note for tomorrow", "add to my morning briefing".
sms_retry: user wants to retry opening Messages after a text was dispatched — "it didn't open", "try again", "send it again", "messages didn't open", "retry", "resend".
sms_edit: user wants to edit/revise a text message they just composed or sent — "edit that", "make it shorter", "change the message", "rewrite it", "fix that text", "add something to it", "make it more casual", "different wording".
reservation_cal_add: user wants to add a restaurant reservation to their calendar — "add it to my calendar", "put it on my schedule", "yes add it", "sync to calendar", "add the reservation", "put the booking on my calendar".`,
      messages: [{ role: "user", content: message }],
    });

    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "{}";
    const m   = raw.match(/\{[\s\S]*\}/);
    if (!m) return SAFE_DEFAULT;

    const p = JSON.parse(m[0]) as Partial<MessageClassification>;

    return {
      morning_greeting:       !!p.morning_greeting,
      evening_greeting:       !!p.evening_greeting,
      emergency:              !!p.emergency,
      reminder_list:          !!p.reminder_list,
      reminder_set:           !!p.reminder_set,
      list_modify:            !!p.list_modify,
      list_type:              LIST_TYPES.has(p.list_type as string) ? p.list_type as MessageClassification["list_type"] : null,
      casual_list_add:        !!p.casual_list_add,
      list_share:             !!p.list_share,
      email:                  !!p.email,
      call:                   !!p.call,
      text_compose:           !!p.text_compose,
      calendar_read:          !!p.calendar_read,
      calendar_create:        !!p.calendar_create,
      calendar_modify:        !!p.calendar_modify,
      calendar_delete:        !!p.calendar_delete,
      dinner_tonight:         !!p.dinner_tonight,
      contact_lookup:         !!p.contact_lookup,
      contact_save:           !!p.contact_save,
      contact_compound_save:  !!p.contact_compound_save,
      google_contact_write:   !!p.google_contact_write,
      story_read:             !!p.story_read,
      story_count:            !!p.story_count,
      olivia_call:            !!p.olivia_call,
      olivia_mention:         !!p.olivia_mention,
      trip_plan:              !!p.trip_plan,
      trip_save:              !!p.trip_save,
      hotel_availability:     !!p.hotel_availability,
      hotel_swap:             !!p.hotel_swap,
      trip_price_query:       !!p.trip_price_query,
      profile_update:         !!p.profile_update,
      tv_add:                 !!p.tv_add,
      tv_remove:              !!p.tv_remove,
      tv_tonight:             !!p.tv_tonight,
      tv_recommend:           !!p.tv_recommend,
      tv_list:                !!p.tv_list,
      med_taken:              !!p.med_taken,
      med_add:                !!p.med_add,
      med_list:               !!p.med_list,
      med_remove:             !!p.med_remove,
      med_mute:               !!p.med_mute,
      med_unmute:             !!p.med_unmute,
      med_reschedule:         !!p.med_reschedule,
      wake_time_change:       !!p.wake_time_change,
      briefing_pref:          !!p.briefing_pref,
      news_dig:               !!p.news_dig,
      news_story_number:      typeof p.news_story_number === "number" ? Math.floor(p.news_story_number) : 0,
      sports:                 !!p.sports,
      markets:                !!p.markets,
      weather:                !!p.weather,
      weather_city:           typeof p.weather_city === "string" && p.weather_city.length > 0 ? p.weather_city : null,
      local_events:           !!p.local_events,
      restaurant_reco:        !!p.restaurant_reco,
      nearby_places:          !!p.nearby_places,
      restaurant_intel:       !!p.restaurant_intel,
      bill_add:               !!p.bill_add,
      bill_list:              !!p.bill_list,
      bill_remove:            !!p.bill_remove,
      myday_get:              !!p.myday_get,
      myday_add:              !!p.myday_add,
      date_add:               !!p.date_add,
      date_list:              !!p.date_list,
      date_remove:            !!p.date_remove,
      headache:               !!p.headache,
      journal_review:         !!p.journal_review,
      transcript_search:      !!p.transcript_search,
      transcript_search_term: typeof p.transcript_search_term === "string" && p.transcript_search_term.length > 0 ? p.transcript_search_term.slice(0, 100) : null,
      briefing_followup:      !!p.briefing_followup,
      navigation:             !!p.navigation,
      goal:                   !!p.goal,
      winddown_note:          !!p.winddown_note,
      sms_retry:              !!p.sms_retry,
      sms_edit:               !!p.sms_edit,
      reservation_cal_add:    !!p.reservation_cal_add,
    };
  } catch (err) {
    console.error("[IntentClassifier] Failed, using safe default:", err);
    return SAFE_DEFAULT;
  }
}

// ── Async medication extraction (replaces regex-based extractMedicationFromMessage) ──

export async function extractMedicationWithAI(message: string): Promise<{
  name: string;
  dosage?: string;
  reminderTime?: string;
} | null> {
  try {
    const resp = await anthropic.messages.create({
      model:      MODEL_HAIKU,
      max_tokens: 100,
      system: `Extract medication info from the user message. Return ONLY valid JSON:
{"name": "medication name", "dosage": "dose like 10mg or null", "reminderTime": "HH:MM 24h or null"}
If no medication mentioned: {"name": null}.
Examples:
- "add lisinopril 10mg taken at 9am" → {"name":"lisinopril","dosage":"10mg","reminderTime":"09:00"}
- "start taking Metformin" → {"name":"Metformin","dosage":null,"reminderTime":null}
- "add atorvastatin 40mg at 8pm" → {"name":"atorvastatin","dosage":"40mg","reminderTime":"20:00"}`,
      messages: [{ role: "user", content: message }],
    });

    const raw = resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "{}";
    const m   = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { name?: string | null; dosage?: string | null; reminderTime?: string | null };
    if (!parsed.name || parsed.name.length < 2) return null;
    return {
      name:         parsed.name,
      dosage:       parsed.dosage ?? undefined,
      reminderTime: parsed.reminderTime ?? undefined,
    };
  } catch {
    return null;
  }
}
