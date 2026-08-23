import Anthropic from "@anthropic-ai/sdk";
import {
  searchContacts,
  formatContactsForPrompt,
  saveCuratedContact,
  getCuratedContacts,
  createGoogleContact,
  updateGoogleContact,
  type Contact as GoogleContact,
} from "../../google/contacts.js";
import { createPerson } from "../../people/peopleManager.js";
import { createProvider } from "../../providers/providerManager.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL_HAIKU = "claude-haiku-4-5-20251001";

export interface ContactHandlerResult {
  contextBlock: string;
}

export interface HandleContactParams {
  message: string;
  sessionUserName: string;
  isContactRequest: boolean;
  isCompoundContactAndSave: boolean;
  isSaveContactRequest: boolean;
  isGoogleContactWrite: boolean;
  history: Array<{ role: string; content: string }>;
  userProfile: { companionName?: string | null; name?: string | null } | null;
  log: { warn: (obj: object, msg?: string) => void; info: (obj: object, msg?: string) => void };
}

export async function handleContact(params: HandleContactParams): Promise<ContactHandlerResult> {
  const {
    message,
    sessionUserName,
    isContactRequest,
    isCompoundContactAndSave,
    isSaveContactRequest,
    isGoogleContactWrite,
    history,
    userProfile,
    log,
  } = params;

  let contextBlock = "";

  const suppressionNote = `\n\n[Contact Operation — People-Profile Suppression]\nThe profile context above may list saved "People" entries. For THIS response, completely disregard that "People" section. Do NOT volunteer, summarise, or reference any person from the profile items list. Your response must address ONLY the specific contact name mentioned in the user's current message.`;

  // ── Google Contacts search ─────────────────────────────────────────────────
  if (isContactRequest) {
    contextBlock += suppressionNote;
    try {
      const nameMatch =
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:[A-Za-z'.]+\s+){0,3}[A-Za-z'.]+?)\s+and\s+(?:add|save|put)\s+(?:him|her|them)\b/i) ??
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:[A-Za-z'.]+\s+){0,3}[A-Za-z'.]+)\s+(?:in|from)\s+(?:my\s+)?contacts?/i) ??
        message.match(/do\s+you\s+have\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        message.match(/(?:get|find)\s+me\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        message.match(/what(?:['']s?|\s+is)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save)\s+((?:\w+\s+){0,3}\w+)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i) ??
        message.match(/(?:find|look\s+up|search(?:\s+for)?|get|pull\s+up|add|save|remember)\s+((?:\w+\s+){0,2}\w+)\s*$/i) ??
        message.match(/^((?:\w+\s+){0,3}\w+?)['']s\s+(?:phone|number|email|contact|info(?:rmation)?|address)/i);

      const rawQuery = (
        (nameMatch?.[1])?.trim() ??
        message.replace(/\b(find|look\s+up|search(\s+for)?|get|pull\s+up|add|save|remember|in\s+my\s+contacts?|from\s+my\s+contacts?|to\s+my\s+(?:winston\s+)?contacts?|my\s+contacts?|their?\s+(phone|email|number|contact)|please|for\s+me)\b/gi, "").trim()
      ).replace(/\b(please|for\s+me|thanks?|thank\s+you|can\s+you|could\s+you)\b/gi, "").replace(/\s+/g, " ").trim();

      const searchQuery = rawQuery.slice(0, 60).trim();

      if (searchQuery.length > 1) {
        const result = await searchContacts(searchQuery, sessionUserName).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));

        if (isCompoundContactAndSave && result.contacts && result.contacts.length === 1) {
          const found = result.contacts[0];
          await saveCuratedContact(found, sessionUserName);
          contextBlock += (
            `\n\n[Compound Contact Request — Lookup + Save Complete]\n` +
            `Found in Google Contacts: ${found.name}` +
            (found.phone ? ` | Phone: ${found.phone}` : "") +
            (found.email ? ` | Email: ${found.email}` : "") +
            (found.address ? ` | Address: ${found.address}` : "") + "\n" +
            `Action taken: Saved to the user's ${userProfile?.companionName ?? "Winston"} contacts AND added to their profile.\n` +
            `Respond with: "Found [Name] in your contacts — I've added them to your ${userProfile?.companionName ?? "Winston"} profile. ` +
            `[Share phone/email if present.] Just ask next time and I'll have the info ready."\n` +
            `CRITICAL: Mention ONLY ${found.name} in your response.`
          );
          log.info({ name: found.name }, "[CONTACTS] Compound lookup+save complete");
        } else if (isCompoundContactAndSave && (!result.contacts || result.contacts.length === 0)) {
          contextBlock += (
            `\n\n[Compound Contact Request — Contact Not Found]\n` +
            `Searched Google Contacts for "${searchQuery}" — no results.\n` +
            `Tell the user: "I searched your contacts but couldn't find anyone named ${searchQuery}. Want me to add them manually?"`
          );
          log.info({ query: searchQuery }, "[CONTACTS] Compound lookup — not found");
        } else {
          contextBlock += formatContactsForPrompt(result, searchQuery, userProfile?.companionName ?? undefined);
        }

        log.info({ query: searchQuery, found: result.contacts?.length ?? 0, needsReauth: result.needsReauth, compound: isCompoundContactAndSave }, "[CONTACTS] Search complete");
      }
    } catch (err) {
      log.warn({ err }, "[CONTACTS] Search failed");
    }
  }

  // ── Save contact ───────────────────────────────────────────────────────────
  if (isSaveContactRequest) {
    contextBlock += suppressionNote;
    try {
      const msgLower = message.toLowerCase();
      const saveDestination: "my_people" | "service_providers" | "curated" =
        /\bservice\s+providers?\b/.test(msgLower) ? "service_providers" :
        /\bmy\s+people\b/.test(msgLower) ? "my_people" :
        "curated";

      const recentContext = [...history]
        .slice(-6)
        .map((m: { role: string; content: string }) => `${m.role === "assistant" ? "Winston" : "User"}: ${m.content}`)
        .join("\n");

      const extractionResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 400,
        messages: [{
          role: "user",
          content:
            `Extract the contact's information from this conversation. Return ONLY valid JSON.\n\n` +
            `Conversation:\n${recentContext}\n\nCurrent message: "${message}"\n\n` +
            `Return JSON:\n{ "name": "<full name or null>", "phone": "<phone or null>", "email": "<email or null>", "relationship": "<or null>", "specialty": "<or null>", "company": "<or null>", "address": "<or null>", "website": "<or null>", "notes": "<or null>" }`,
        }],
      }).catch(() => null);

      let extracted: {
        name?: string | null; phone?: string | null; email?: string | null;
        relationship?: string | null; specialty?: string | null; company?: string | null;
        address?: string | null; website?: string | null; notes?: string | null;
      } = {};

      if (extractionResp) {
        const raw = extractionResp.content[0]?.type === "text" ? extractionResp.content[0].text.trim() : "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) { try { extracted = JSON.parse(jsonMatch[0]); } catch { /* ignore */ } }
      }

      let gcContact: GoogleContact | null = null;
      if (!extracted.name) {
        const emptyContacts: GoogleContact[] = [];
        const explicitNameMatch =
          message.match(/\b(?:save|add|remember)\s+((?:[A-Z]\w*\s+){1,2}[A-Z]\w*)\s+(?:to|in)\b/i) ??
          message.match(/\b(?:save|add|remember)\s+((?:\w+\s+){1,3}\w+)\s+(?:to|in)\b/i);
        if (explicitNameMatch?.[1]) {
          const { contacts } = await searchContacts(explicitNameMatch[1].trim(), sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
          if (contacts.length > 0) gcContact = contacts[0];
        } else {
          const lastAssistant = [...history].reverse().find((m: { role: string; content: string }) => m.role === "assistant");
          if (lastAssistant) {
            const bulletMatch = lastAssistant.content.match(/•\s+([\w\s]+?)(?:\s+—|\n|$)/);
            const verifiedMatch = lastAssistant.content.match(/(?:found|here(?:'s|\s+is))\s+([\w\s]+?)(?:'s|\s+in\s+your\s+contacts|\s+—|\.|,)/i);
            const candidateName = (bulletMatch?.[1] ?? verifiedMatch?.[1] ?? "").trim();
            if (candidateName.length > 2) {
              const { contacts } = await searchContacts(candidateName, sessionUserName).catch(() => ({ contacts: emptyContacts, needsReauth: false, source: "none" as const }));
              if (contacts.length > 0) gcContact = contacts[0];
            }
          }
        }
        if (gcContact) extracted.name = gcContact.name;
        if (gcContact?.phone && !extracted.phone) extracted.phone = gcContact.phone;
        if (gcContact?.email && !extracted.email) extracted.email = gcContact.email;
        if (gcContact?.address && !extracted.address) extracted.address = gcContact.address;
      }

      const contactName = extracted.name?.trim() ?? null;
      if (contactName) {
        const cName = userProfile?.companionName ?? "Winston";

        if (saveDestination === "my_people") {
          const person = await createPerson(sessionUserName, {
            name: contactName,
            relationship: extracted.relationship ?? null,
            phone: extracted.phone ?? null,
            email: extracted.email ?? null,
            address: extracted.address ?? null,
            notes: [extracted.specialty, extracted.company, extracted.notes].filter(Boolean).join(" · ") || null,
          });
          contextBlock +=
            `\n\n[Contact Saved — My People]\n"${person.name}" has been saved to My People.` +
            (person.phone ? ` Phone: ${person.phone}.` : "") +
            (person.email ? ` Email: ${person.email}.` : "") +
            `\nConfirm naturally: "Done — I've added ${person.name} to your People." Keep it brief.`;
          log.info({ name: person.name, id: person.id }, "[CONTACTS] Saved to key_people");

        } else if (saveDestination === "service_providers") {
          const categoryHint = (extracted.specialty ?? extracted.relationship ?? "").trim();
          const category = await (async (): Promise<string> => {
            if (!categoryHint) return "Personal";
            try {
              const catResp = await anthropic.messages.create({
                model: MODEL_HAIKU,
                max_tokens: 10,
                system: "Classify this professional role into one word: Medical, Legal, Financial, Home, Auto, or Personal.",
                messages: [{ role: "user", content: categoryHint }],
              });
              const result = (catResp.content[0]?.type === "text" ? catResp.content[0].text.trim() : "Personal").replace(/[^A-Za-z]/g, "");
              return ["Medical", "Legal", "Financial", "Home", "Auto", "Personal"].includes(result) ? result : "Personal";
            } catch { return "Personal"; }
          })();

          const provider = await createProvider(sessionUserName, {
            name: contactName, category,
            specialty: extracted.specialty ?? null,
            phone: extracted.phone ?? null,
            email: extracted.email ?? null,
            address: extracted.address ?? null,
            website: extracted.website ?? null,
            company: extracted.company ?? null,
            notes: extracted.notes ?? null,
          });
          contextBlock +=
            `\n\n[Contact Saved — Service Providers]\n"${provider.name}" saved under ${provider.category}.` +
            (provider.phone ? ` Phone: ${provider.phone}.` : "") +
            `\nConfirm: "Got it — ${provider.name} is now in your Service Providers." Keep it brief.`;
          log.info({ name: provider.name, category: provider.category }, "[CONTACTS] Saved to service_providers");

        } else {
          const contactData: GoogleContact = {
            name: contactName,
            phone: extracted.phone ?? gcContact?.phone ?? undefined,
            email: extracted.email ?? gcContact?.email ?? undefined,
            address: extracted.address ?? gcContact?.address ?? undefined,
            resourceName: gcContact?.resourceName,
            photoUrl: gcContact?.photoUrl ?? undefined,
          };
          await saveCuratedContact(contactData, sessionUserName);
          contextBlock +=
            `\n\n[Contact Saved to ${cName} Curated List]\n"${contactName}" saved.` +
            (contactData.phone ? ` Phone: ${contactData.phone}.` : "") +
            `\nConfirm: "Got it — I've saved ${contactName} to your ${cName} contacts."` +
            `\nCRITICAL: Mention ONLY "${contactName}" in your response.`;
          log.info({ name: contactName }, "[CONTACTS] Saved to curated list");
        }
      } else {
        contextBlock += `\n\n[Contact Save — Name Not Found]\nAsk the user: "Who would you like me to add?"`;
      }
    } catch (err) {
      log.warn({ err }, "[CONTACTS] Save contact failed");
    }
  }

  // ── Google Contact write (create / update) ─────────────────────────────────
  if (isGoogleContactWrite) {
    try {
      const extractionResp = await anthropic.messages.create({
        model: MODEL_HAIKU,
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            `Extract contact write intent. Return ONLY valid JSON.\n\nMessage: "${message}"\n\n` +
            `Return: { "action": "create" | "update", "name": "<full name>", "phone": "<or null>", "email": "<or null>", "address": "<or null>" }`,
        }],
      });

      const raw = extractionResp.content[0]?.type === "text" ? extractionResp.content[0].text.trim() : "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) as { action?: string; name?: string; phone?: string | null; email?: string | null; address?: string | null } : null;

      if (parsed?.name) {
        const contactName = parsed.name.trim();
        if (parsed.action === "update") {
          const searchResult = await searchContacts(contactName, sessionUserName).catch(() => ({ contacts: [], needsReauth: false, source: "none" as const }));
          const found = searchResult.contacts[0];
          if (found?.resourceName) {
            const updates: { phone?: string; email?: string; address?: string } = {};
            if (parsed.phone) updates.phone = parsed.phone;
            if (parsed.email) updates.email = parsed.email;
            if (parsed.address) updates.address = parsed.address;
            const result = await updateGoogleContact(sessionUserName, found.resourceName, updates);
            if (result.ok) {
              contextBlock += `\n\n[Google Contact Updated]\nUpdated ${contactName}.\nConfirm: "Done — I've updated ${contactName}'s info in your Google Contacts."`;
            } else if (result.needsReauth) {
              contextBlock += `\n\n[Google Contact Update — Reconnect Required]\nTell user: "To write to your Google Contacts, reconnect Google in app settings."`;
            } else {
              contextBlock += `\n\n[Google Contact Update — Failed]\nTell user: "I wasn't able to update ${contactName}'s contact."`;
            }
          } else {
            contextBlock += `\n\n[Google Contact Update — Not Found]\nTell user: "I couldn't find ${contactName} in your Google Contacts."`;
          }
        } else {
          const result = await createGoogleContact({
            name: contactName,
            phone: parsed.phone ?? undefined,
            email: parsed.email ?? undefined,
            address: parsed.address ?? undefined,
          }, sessionUserName);
          if (result.ok) {
            contextBlock += `\n\n[Google Contact Created]\nCreated ${contactName}.\nConfirm: "Done — I've added ${contactName} to your Google Contacts."`;
          } else if (result.needsReauth) {
            contextBlock += `\n\n[Google Contact Create — Reconnect Required]\nTell user: "To add contacts to Google, reconnect Google in app settings."`;
          } else {
            contextBlock += `\n\n[Google Contact Create — Failed]\nTell user: "I wasn't able to add ${contactName} to your Google Contacts."`;
          }
        }
      } else {
        contextBlock += `\n\n[Google Contact Write — Parse Failed]\nAsk: "Could you give me the full name and details you'd like to save?"`;
      }
    } catch (err) {
      log.warn({ err }, "[CONTACTS] Google contact write failed");
    }
  }

  return { contextBlock };
}