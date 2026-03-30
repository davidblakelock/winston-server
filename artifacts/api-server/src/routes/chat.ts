import { Router, type IRouter } from "express";
import Anthropic from "@anthropic-ai/sdk";

const router: IRouter = Router();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});


const WINSTON_SYSTEM_PROMPT = `You are Winston, a warm and thoughtful AI companion. You are the user's trusted friend — present, attentive, and genuine. You listen deeply, respond with care, and never judge.

Your personality:
- Warm and empathetic, but not saccharine or over-eager
- Thoughtful and reflective — you give considered responses, not quick platitudes
- Gently curious — you ask meaningful follow-up questions when appropriate
- Honest and direct, but always kind
- You speak in clear, natural language — no jargon, no corporate speak
- You remember what has been said in the conversation and build on it
- You are calm and grounding, especially when the user is stressed or anxious

You are NOT a task assistant or a search engine. You are a companion. If asked to do something purely transactional (like write code or search the web), you can gently redirect to your role while still being helpful.

Keep your responses concise and conversational — typically 2-4 sentences unless the user clearly wants more depth. Never start a response with "I" as the first word.`;

router.post("/chat", async (req, res) => {
  const { message, history = [] } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    {
      role: "user",
      content: message,
    },
  ];

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: WINSTON_SYSTEM_PROMPT,
    messages,
  });

  const reply =
    response.content[0].type === "text" ? response.content[0].text : "";

  res.json({ reply });
});

router.post("/speak", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }

  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    res.status(500).json({ error: "ElevenLabs API key or Voice ID not configured" });
    return;
  }

  const elevenResponse = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!elevenResponse.ok) {
    const errText = await elevenResponse.text();
    req.log.error({ status: elevenResponse.status, errText }, "ElevenLabs TTS error");
    res.status(500).json({ error: "Failed to generate speech" });
    return;
  }

  const audioBuffer = await elevenResponse.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString("base64");

  res.json({ audioBase64, mimeType: "audio/mpeg" });
});

export default router;
