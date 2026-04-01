import {
  useState,
  useEffect,
  useRef,
  useCallback,
  FormEvent,
} from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

type StepType = "scene" | "margaret" | "emma" | "insight" | "reveal";

interface DemoStep {
  type: StepType;
  scene?: number;
  title?: string;
  icon?: string;
  text?: string;
  insightMain?: string;
  insightDetail?: string;
}

interface ChatMessage {
  id: string;
  speaker: "margaret" | "emma";
  text: string;
}

// ── Demo Script ───────────────────────────────────────────────────────────────

const EMMA_REVEAL =
  "That's what Winston does — not for Margaret, but for you. Your name. Your family. Your life. Your stories. Alexa answers questions. Siri sets timers. Google searches the web. Winston knows you.";

const STEPS: DemoStep[] = [
  { type: "scene", scene: 1, title: "Morning Briefing", icon: "☀️" },
  { type: "margaret", text: "Good morning." },
  {
    type: "emma",
    text: "Good morning, Margaret! It's Tuesday in Dallas — 74 and sunny, a beautiful day ahead. A few things for you: Claire called last night and mentioned that little Emma's school recital is the 18th, so keep that evening open. Your cardiologist appointment is Thursday at 10 AM — I've got that flagged. And your book club meets Friday evening. Is there anything particular on your mind this morning?",
  },
  {
    type: "insight",
    insightMain: "Alexa says \"Good morning.\"",
    insightDetail:
      "She doesn't know your name, your daughter's city, or that Thursday matters.",
  },

  { type: "scene", scene: 2, title: "Email Summary", icon: "✉️" },
  { type: "margaret", text: "Anything important in my email?" },
  {
    type: "emma",
    text: "Eleven new emails — mostly newsletters, I've set those aside. Two worth your attention: Claire sent a folder of photos from Emma's recital last Saturday. And there's one marked urgent from 'Medicare Benefits Office' asking you to verify your Social Security number. Margaret, that is a scam. Medicare never contacts you by email asking for that. Delete it without clicking anything.",
  },
  {
    type: "insight",
    insightMain: "Alexa can't read your email at all.",
    insightDetail:
      "Neither Siri nor Google would have warned you about that scam.",
  },

  { type: "scene", scene: 3, title: "Directions by Name", icon: "🗺️" },
  { type: "margaret", text: "I need directions to Dr. Martinez." },
  {
    type: "emma",
    text: "Of course — Dr. Elena Martinez at Presbyterian Dallas on Walnut Hill Lane. Pulling up directions now. About 19 minutes in current traffic. You're in good shape.",
  },
  {
    type: "insight",
    insightMain: "Siri would ask: \"What's the address?\"",
    insightDetail: "She doesn't know your doctors.",
  },

  { type: "scene", scene: 4, title: "Perfect Recommendation", icon: "🍽️" },
  {
    type: "margaret",
    text: "Claire's visiting next week. Where should I take her for dinner?",
  },
  {
    type: "emma",
    text: "For you and Claire — something special — I'd suggest Lucia in Oak Cliff. It's intimate, the Italian is quietly exceptional, and the kind of room where you can really talk without being rushed. Or if you want something grander, Bullion downtown is stunning — French-American cuisine, a beautiful room. Either would make a lovely evening for the two of you.",
  },
  {
    type: "insight",
    insightMain: "Google shows everyone the same sponsored results.",
    insightDetail: "Emma chose these for you and Claire specifically.",
  },

  { type: "scene", scene: 5, title: "Capturing a Memory", icon: "📖" },
  {
    type: "emma",
    text: "Before you turn in tonight — I'd love to ask you something for Claire's memory book. When she was little, what's a moment with her that you can still picture perfectly?",
  },
  {
    type: "margaret",
    text: "She used to sneak downstairs on Saturday mornings to make me breakfast. Always burnt toast and orange juice... but she'd carry it up to me in bed with this enormous, proud smile.",
  },
  {
    type: "emma",
    text: "That image of her carrying that tray — so proud of herself. That is exactly the kind of thing Claire will treasure for the rest of her life. I've saved it to her memory book. Thank you for sharing that, Margaret.",
  },
  {
    type: "insight",
    insightMain: "Alexa has been in Margaret's home for six years.",
    insightDetail: "She has never once asked about Margaret's life.",
  },

  { type: "reveal" },
];

const TOTAL_SCENES = 5;

// ── Audio Utilities ───────────────────────────────────────────────────────────

async function fetchDemoAudio(text: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/api/demo/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function speakBrowserTTS(text: string, onEnd: () => void): () => void {
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.92;
  utter.pitch = 1.05;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) =>
      v.lang.startsWith("en") &&
      (v.name.toLowerCase().includes("female") ||
        v.name.toLowerCase().includes("samantha") ||
        v.name.toLowerCase().includes("karen") ||
        v.name.toLowerCase().includes("victoria") ||
        v.name.toLowerCase().includes("zira"))
  );
  if (preferred) utter.voice = preferred;
  utter.onend = onEnd;
  utter.onerror = onEnd;
  window.speechSynthesis.speak(utter);
  return () => window.speechSynthesis.cancel();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Demo() {
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(-1);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentScene, setCurrentScene] = useState(0);
  const [insight, setInsight] = useState<{ main: string; detail: string } | null>(null);
  const [insightVisible, setInsightVisible] = useState(false);
  const [showReveal, setShowReveal] = useState(false);
  const [revealText, setRevealText] = useState("");
  const [showCTA, setShowCTA] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [email, setEmail] = useState("");
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlsRef = useRef<string[]>([]);
  const cancelTTSRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const advanceRef = useRef<(() => void) | null>(null);
  const isMutedRef = useRef(isMuted);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const advance = useCallback(() => {
    setStepIndex((prev) => prev + 1);
  }, []);

  useEffect(() => {
    advanceRef.current = advance;
  }, [advance]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, insight]);

  // Preload voices for browser TTS
  useEffect(() => {
    window.speechSynthesis?.getVoices();
  }, []);

  // Step execution engine
  useEffect(() => {
    if (stepIndex < 0 || stepIndex >= STEPS.length) return;

    const step = STEPS[stepIndex];
    let cancelled = false;

    const doAdvance = () => {
      if (!cancelled) advanceRef.current?.();
    };

    // Stop any in-progress audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    cancelTTSRef.current?.();
    cancelTTSRef.current = null;

    if (step.type === "scene") {
      setCurrentScene(step.scene!);
      setInsight(null);
      setInsightVisible(false);
      const t = setTimeout(doAdvance, 800);
      return () => { cancelled = true; clearTimeout(t); };
    }

    if (step.type === "margaret") {
      const msg: ChatMessage = { id: `m-${stepIndex}`, speaker: "margaret", text: step.text! };
      setMessages((prev) => [...prev, msg]);
      // Estimate read time: ~100ms per word, min 1.2s, max 2.5s
      const words = step.text!.split(" ").length;
      const delay = Math.min(2500, Math.max(1200, words * 100));
      const t = setTimeout(doAdvance, delay);
      return () => { cancelled = true; clearTimeout(t); };
    }

    if (step.type === "emma") {
      const msg: ChatMessage = { id: `e-${stepIndex}`, speaker: "emma", text: step.text! };
      setMessages((prev) => [...prev, msg]);

      if (isMutedRef.current) {
        const words = step.text!.split(" ").length;
        const delay = Math.min(4000, Math.max(2000, words * 75));
        const t = setTimeout(doAdvance, delay);
        return () => { cancelled = true; clearTimeout(t); };
      }

      // Try ElevenLabs first
      fetchDemoAudio(step.text!).then((blobUrl) => {
        if (cancelled) {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return;
        }
        if (blobUrl) {
          blobUrlsRef.current.push(blobUrl);
          const audio = new Audio(blobUrl);
          audioRef.current = audio;
          audio.onended = doAdvance;
          audio.onerror = () => {
            if (!cancelled) {
              cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
            }
          };
          audio.play().catch(() => {
            if (!cancelled) {
              cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
            }
          });
        } else {
          if (!cancelled) {
            cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
          }
        }
      });

      return () => {
        cancelled = true;
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.onended = null;
        }
        cancelTTSRef.current?.();
      };
    }

    if (step.type === "insight") {
      setInsight({ main: step.insightMain!, detail: step.insightDetail! });
      const t1 = setTimeout(() => setInsightVisible(true), 50);
      const t2 = setTimeout(doAdvance, 4500);
      return () => {
        cancelled = true;
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }

    if (step.type === "reveal") {
      // Small pause then reveal transition
      const t = setTimeout(() => {
        if (!cancelled) setShowReveal(true);
      }, 600);

      // Type out the reveal text word by word while playing audio
      const words = EMMA_REVEAL.split(" ");
      let wordIdx = 0;
      let typer: ReturnType<typeof setInterval>;

      const startTyping = () => {
        typer = setInterval(() => {
          if (cancelled) { clearInterval(typer); return; }
          wordIdx++;
          setRevealText(words.slice(0, wordIdx).join(" "));
          if (wordIdx >= words.length) {
            clearInterval(typer);
            const ctaTimer = setTimeout(() => {
              if (!cancelled) setShowCTA(true);
            }, 1200);
            return () => clearTimeout(ctaTimer);
          }
        }, 130);
      };

      if (!isMutedRef.current) {
        fetchDemoAudio(EMMA_REVEAL).then((blobUrl) => {
          if (cancelled) { if (blobUrl) URL.revokeObjectURL(blobUrl); return; }
          if (blobUrl) {
            blobUrlsRef.current.push(blobUrl);
            const audio = new Audio(blobUrl);
            audioRef.current = audio;
            audio.play().catch(() => {});
          } else {
            cancelTTSRef.current = speakBrowserTTS(EMMA_REVEAL, () => {});
          }
          startTyping();
        });
      } else {
        startTyping();
      }

      return () => {
        cancelled = true;
        clearTimeout(t);
        clearInterval(typer);
        if (audioRef.current) { audioRef.current.pause(); audioRef.current.onended = null; }
        cancelTTSRef.current?.();
      };
    }
  }, [stepIndex]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      window.speechSynthesis?.cancel();
      if (audioRef.current) audioRef.current.pause();
    };
  }, []);

  const startDemo = () => {
    setStarted(true);
    setStepIndex(0);
  };

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setEmailError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE}/api/demo/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (!res.ok) {
        setEmailError("Something went wrong. Please try again.");
        return;
      }
      setEmailSubmitted(true);
    } catch {
      setEmailError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleMuteToggle = () => {
    setIsMuted((m) => {
      const next = !m;
      if (next) {
        audioRef.current?.pause();
        cancelTTSRef.current?.();
      }
      return next;
    });
  };

  // ── Splash Screen ────────────────────────────────────────────────────────────

  if (!started) {
    return (
      <div style={styles.page}>
        <div style={styles.splash}>
          <div style={styles.splashLogo}>
            <WinstonLogo />
          </div>
          <h1 style={styles.splashTitle}>Meet Your Personal AI Companion</h1>
          <p style={styles.splashSubtitle}>
            See how Winston transforms every day — unlike anything Alexa, Siri, or Google can offer.
          </p>
          <div style={styles.personaCard}>
            <div style={styles.personaAvatar}>M</div>
            <div>
              <div style={styles.personaName}>Margaret</div>
              <div style={styles.personaDetail}>Retired teacher · Dallas, TX · Daughter Claire in Chicago</div>
            </div>
          </div>
          <button onClick={startDemo} style={styles.startBtn}>
            Watch the Demo
            <span style={{ marginLeft: 8 }}>▶</span>
          </button>
          <p style={styles.splashFooter}>~3 minutes · With real voice</p>
        </div>
      </div>
    );
  }

  // ── Reveal Screen ────────────────────────────────────────────────────────────

  if (showReveal) {
    return (
      <div style={styles.page}>
        <div style={styles.revealWrap}>
          <div style={styles.revealEmmaBadge}>
            <EmmaDot />
            <span style={styles.revealEmmaName}>Emma Peel</span>
          </div>

          <p style={styles.revealText}>{revealText || "…"}</p>

          {showCTA && (
            <div style={styles.ctaSection}>
              <div style={styles.ctaDivider} />

              {!emailSubmitted ? (
                <>
                  <p style={styles.ctaHeadline}>Create your companion.</p>
                  <p style={styles.ctaSubline}>
                    Enter your email to reserve your spot — and we'll set yours up personally.
                  </p>
                  <form onSubmit={handleEmailSubmit} style={styles.emailForm}>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      required
                      style={styles.emailInput}
                    />
                    <button
                      type="submit"
                      disabled={submitting}
                      style={styles.emailSubmitBtn}
                    >
                      {submitting ? "Saving…" : "Reserve my spot →"}
                    </button>
                  </form>
                  {emailError && <p style={styles.emailError}>{emailError}</p>}
                  <p style={styles.ctaAlready}>
                    Already have an account?{" "}
                    <a href={`${BASE}/`} style={styles.ctaLink}>
                      Sign in here
                    </a>
                  </p>
                </>
              ) : (
                <div style={styles.successSection}>
                  <div style={styles.successCheck}>✓</div>
                  <p style={styles.successTitle}>You're on the list.</p>
                  <p style={styles.successSubline}>
                    We'll be in touch personally to set up your companion.
                  </p>
                  <a href={`${BASE}/`} style={styles.createBtn}>
                    Create my companion now →
                  </a>
                </div>
              )}

              <div style={styles.compareRow}>
                <CompareTag label="Alexa" subtitle="Answers questions" />
                <CompareTag label="Siri" subtitle="Sets timers" />
                <CompareTag label="Google" subtitle="Searches the web" />
                <CompareTag label="Winston" subtitle="Knows you" highlight />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Main Demo View ───────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <WinstonLogo small />
        <SceneProgress current={currentScene} total={TOTAL_SCENES} />
        <button onClick={handleMuteToggle} style={styles.muteBtn} title={isMuted ? "Unmute" : "Mute"}>
          {isMuted ? "🔇" : "🔊"}
        </button>
      </div>

      {/* Chat area */}
      <div style={styles.chatArea}>
        {messages.map((msg) => (
          <ChatBubble key={msg.id} message={msg} />
        ))}

        {/* Insight card */}
        {insight && (
          <div
            style={{
              ...styles.insightCard,
              opacity: insightVisible ? 1 : 0,
              transform: insightVisible ? "translateY(0)" : "translateY(16px)",
              transition: "opacity 0.5s ease, transform 0.5s ease",
            }}
          >
            <div style={styles.insightIcon}>≠</div>
            <div>
              <div style={styles.insightMain}>{insight.main}</div>
              <div style={styles.insightDetail}>{insight.detail}</div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom bar */}
      <div style={styles.bottomBar}>
        <a href={`${BASE}/`} style={styles.skipLink}>
          Skip demo
        </a>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChatBubble({ message }: { message: ChatMessage }) {
  const isEmma = message.speaker === "emma";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isEmma ? "flex-start" : "flex-end",
        marginBottom: 16,
        animation: "fadeSlideUp 0.35s ease both",
      }}
    >
      {isEmma && (
        <div style={styles.emmaSpeakerLabel}>
          <EmmaDot />
          <span>Emma Peel</span>
        </div>
      )}
      {!isEmma && (
        <div style={styles.margaretSpeakerLabel}>Margaret</div>
      )}
      <div style={isEmma ? styles.emmaBubble : styles.margaretBubble}>
        {message.text}
      </div>
    </div>
  );
}

function SceneProgress({ current, total }: { current: number; total: number }) {
  return (
    <div style={styles.progressRow}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            ...styles.progressDot,
            background:
              i + 1 < current
                ? "#7c3aed"
                : i + 1 === current
                ? "#a78bfa"
                : "rgba(255,255,255,0.15)",
            transform: i + 1 === current ? "scale(1.3)" : "scale(1)",
          }}
        />
      ))}
    </div>
  );
}

function CompareTag({
  label,
  subtitle,
  highlight = false,
}: {
  label: string;
  subtitle: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ ...styles.compareTag, ...(highlight ? styles.compareTagHL : {}) }}>
      <div style={{ ...styles.compareTagLabel, ...(highlight ? { color: "#a78bfa" } : {}) }}>
        {label}
      </div>
      <div style={styles.compareTagSub}>{subtitle}</div>
    </div>
  );
}

function EmmaDot() {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "#818cf8",
        flexShrink: 0,
      }}
    />
  );
}

function WinstonLogo({ small = false }: { small?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: small ? 28 : 40,
          height: small ? 28 : 40,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontWeight: 700,
          fontSize: small ? 12 : 18,
          flexShrink: 0,
        }}
      >
        W
      </div>
      {!small && (
        <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 20, letterSpacing: "-0.5px" }}>
          Winston
        </span>
      )}
      {small && (
        <span style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 15 }}>Winston</span>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg, #0d0d1a 0%, #0a0a14 50%, #0d0d20 100%)",
    display: "flex",
    flexDirection: "column",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    color: "#e2e8f0",
    overflowX: "hidden",
  },

  // Splash
  splash: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    maxWidth: 560,
    margin: "0 auto",
    textAlign: "center",
  },
  splashLogo: { marginBottom: 32 },
  splashTitle: {
    fontSize: "clamp(1.6rem, 5vw, 2.4rem)",
    fontWeight: 700,
    letterSpacing: "-0.5px",
    marginBottom: 16,
    background: "linear-gradient(135deg, #c4b5fd, #818cf8)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  splashSubtitle: {
    fontSize: "1.05rem",
    color: "#94a3b8",
    lineHeight: 1.6,
    marginBottom: 32,
  },
  personaCard: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: "16px 24px",
    marginBottom: 40,
    textAlign: "left",
  },
  personaAvatar: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "linear-gradient(135deg, #d97706, #f59e0b)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 20,
    color: "#fff",
    flexShrink: 0,
  },
  personaName: { fontWeight: 600, fontSize: "1.05rem", marginBottom: 2 },
  personaDetail: { fontSize: "0.875rem", color: "#64748b" },
  startBtn: {
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    color: "#fff",
    border: "none",
    borderRadius: 14,
    padding: "16px 40px",
    fontSize: "1.1rem",
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 4,
    boxShadow: "0 8px 30px rgba(79,70,229,0.35)",
  },
  splashFooter: { marginTop: 16, fontSize: "0.8rem", color: "#475569" },

  // Top bar
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0,
  },
  progressRow: {
    display: "flex",
    gap: 8,
    alignItems: "center",
  },
  progressDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    transition: "all 0.4s ease",
  },
  muteBtn: {
    background: "none",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: "#94a3b8",
    cursor: "pointer",
    padding: "6px 10px",
    fontSize: "1rem",
  },

  // Chat
  chatArea: {
    flex: 1,
    padding: "24px 20px",
    maxWidth: 680,
    width: "100%",
    margin: "0 auto",
    overflowY: "auto",
  },
  emmaSpeakerLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: "0.75rem",
    color: "#818cf8",
    marginBottom: 4,
    fontWeight: 500,
    letterSpacing: "0.02em",
  },
  margaretSpeakerLabel: {
    fontSize: "0.75rem",
    color: "#f59e0b",
    marginBottom: 4,
    fontWeight: 500,
    letterSpacing: "0.02em",
  },
  emmaBubble: {
    background: "rgba(79, 70, 229, 0.15)",
    border: "1px solid rgba(99, 102, 241, 0.25)",
    borderRadius: "4px 18px 18px 18px",
    padding: "14px 18px",
    fontSize: "0.975rem",
    lineHeight: 1.65,
    color: "#e2e8f0",
    maxWidth: "85%",
    boxShadow: "0 2px 12px rgba(79,70,229,0.12)",
  },
  margaretBubble: {
    background: "rgba(251, 191, 36, 0.12)",
    border: "1px solid rgba(251, 191, 36, 0.2)",
    borderRadius: "18px 18px 4px 18px",
    padding: "12px 16px",
    fontSize: "0.95rem",
    lineHeight: 1.6,
    color: "#fde68a",
    maxWidth: "75%",
  },

  // Insight card
  insightCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    background: "rgba(255, 255, 255, 0.03)",
    border: "1px solid rgba(251, 113, 133, 0.2)",
    borderLeft: "3px solid #f43f5e",
    borderRadius: "0 12px 12px 0",
    padding: "14px 18px",
    marginTop: 8,
    marginBottom: 8,
  },
  insightIcon: {
    fontSize: "1.2rem",
    color: "#f43f5e",
    fontWeight: 700,
    flexShrink: 0,
    lineHeight: 1.5,
  },
  insightMain: {
    color: "#fda4af",
    fontWeight: 600,
    fontSize: "0.9rem",
    marginBottom: 4,
  },
  insightDetail: {
    color: "#94a3b8",
    fontSize: "0.85rem",
    lineHeight: 1.5,
  },

  // Bottom
  bottomBar: {
    padding: "12px 20px",
    display: "flex",
    justifyContent: "center",
    borderTop: "1px solid rgba(255,255,255,0.04)",
    flexShrink: 0,
  },
  skipLink: {
    color: "#475569",
    fontSize: "0.8rem",
    textDecoration: "none",
  },

  // Reveal
  revealWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "48px 24px 40px",
    maxWidth: 680,
    margin: "0 auto",
    width: "100%",
  },
  revealEmmaBadge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 32,
  },
  revealEmmaName: {
    color: "#818cf8",
    fontWeight: 600,
    fontSize: "0.9rem",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  revealText: {
    fontSize: "clamp(1.25rem, 3.5vw, 1.75rem)",
    lineHeight: 1.65,
    textAlign: "center",
    color: "#e2e8f0",
    fontWeight: 300,
    letterSpacing: "-0.01em",
    minHeight: 200,
    maxWidth: 600,
  },

  // CTA
  ctaSection: {
    width: "100%",
    maxWidth: 520,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  ctaDivider: {
    width: 60,
    height: 2,
    background: "linear-gradient(90deg, #4f46e5, #7c3aed)",
    borderRadius: 2,
    margin: "32px 0",
  },
  ctaHeadline: {
    fontSize: "1.6rem",
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 8,
    background: "linear-gradient(135deg, #c4b5fd, #818cf8)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  ctaSubline: {
    color: "#94a3b8",
    fontSize: "0.9rem",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 1.6,
  },
  emailForm: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    width: "100%",
    alignItems: "center",
  },
  emailInput: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 12,
    padding: "14px 20px",
    fontSize: "1rem",
    color: "#e2e8f0",
    width: "100%",
    maxWidth: 360,
    outline: "none",
  },
  emailSubmitBtn: {
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    color: "#fff",
    border: "none",
    borderRadius: 12,
    padding: "14px 32px",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    maxWidth: 360,
    boxShadow: "0 6px 24px rgba(79,70,229,0.35)",
  },
  emailError: { color: "#fca5a5", fontSize: "0.85rem", marginTop: 4 },
  ctaAlready: { marginTop: 16, fontSize: "0.85rem", color: "#64748b" },
  ctaLink: { color: "#818cf8", textDecoration: "none" },

  // Success
  successSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: 12,
  },
  successCheck: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: "rgba(79,70,229,0.2)",
    border: "1px solid rgba(99,102,241,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "1.5rem",
    color: "#a78bfa",
  },
  successTitle: {
    fontSize: "1.4rem",
    fontWeight: 700,
    color: "#e2e8f0",
  },
  successSubline: {
    color: "#94a3b8",
    fontSize: "0.9rem",
    lineHeight: 1.6,
  },
  createBtn: {
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    color: "#fff",
    textDecoration: "none",
    borderRadius: 12,
    padding: "14px 32px",
    fontSize: "1rem",
    fontWeight: 600,
    marginTop: 8,
    boxShadow: "0 6px 24px rgba(79,70,229,0.35)",
    display: "inline-block",
  },

  // Compare row
  compareRow: {
    display: "flex",
    gap: 12,
    marginTop: 40,
    flexWrap: "wrap" as const,
    justifyContent: "center",
  },
  compareTag: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "12px 20px",
    textAlign: "center",
    minWidth: 100,
  },
  compareTagHL: {
    background: "rgba(79,70,229,0.12)",
    border: "1px solid rgba(99,102,241,0.3)",
  },
  compareTagLabel: {
    fontWeight: 700,
    fontSize: "0.95rem",
    marginBottom: 4,
    color: "#94a3b8",
  },
  compareTagSub: {
    fontSize: "0.75rem",
    color: "#475569",
  },
};
