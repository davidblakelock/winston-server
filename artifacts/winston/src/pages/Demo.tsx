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

// ── Demo Script — 8 scenes, ~5-6 minutes ─────────────────────────────────────

const EMMA_REVEAL =
  "You've just seen Margaret's day. Margaret is a character — a composite of the people we built Winston for. The real people are millions of older adults who are sharp, curious, and full of life, and who spend far too many days without anyone who truly knows them. Winston isn't a smart speaker. It isn't a search engine. It's a companion who learns your life — your name, your family, your doctors, your stories, your fears — and shows up every single day. Alexa answers questions. Siri sets timers. Google searches the web. Winston knows you.";

const STEPS: DemoStep[] = [

  // ── Scene 1: Opening Hook ─────────────────────────────────────────────────

  { type: "scene", scene: 1, title: "Does Alexa Know You?", icon: "🎙️" },
  {
    type: "emma",
    text: "Let me ask you something. Alexa has been in millions of homes for nearly a decade. Does she know your name? Does she know your daughter's city, or that Thursday matters, or that you've been worried about something this week? After five years sitting on someone's kitchen counter, she still can't answer any of those questions. Let me show you what actually knowing someone looks like.",
  },
  {
    type: "insight",
    insightMain: "Alexa has been in millions of homes for a decade.",
    insightDetail: "She still doesn't know a single user's name.",
  },

  // ── Scene 2: Morning Briefing ─────────────────────────────────────────────

  { type: "scene", scene: 2, title: "Morning Briefing", icon: "☀️" },
  { type: "margaret", text: "Good morning." },
  {
    type: "emma",
    text: "Good morning, Margaret. Dallas is 71 and partly cloudy right now — lovely for a morning walk if you feel like it. I also checked Chicago for you: Claire's got rain moving in around noon, so she's likely working from home today. A couple of things on your calendar: your cardiologist appointment is tomorrow at ten. Dr. Martinez's office is about 23 minutes from the house — I'd plan to leave by nine twenty, maybe nine fifteen if you want a comfortable start. I'll remind you. Book club is Friday evening, and I noticed you're still about sixty pages from the end of The Women — perfectly manageable if you read tonight. In the news: the Texas water rights bill you've been following passed committee yesterday, and the Dallas school board voted to preserve the arts funding. I remembered you care about that one.",
  },
  {
    type: "insight",
    insightMain: "Alexa's morning briefing: generic headlines, basic weather.",
    insightDetail: "She doesn't know your doctors, your daughter's city, your calendar, or what legislation you follow.",
  },

  // ── Scene 3: Email Management ─────────────────────────────────────────────

  { type: "scene", scene: 3, title: "Email — What Actually Matters", icon: "✉️" },
  { type: "margaret", text: "Anything important in my email overnight?" },
  {
    type: "emma",
    text: "Fourteen new messages. Ten are newsletters and subscription emails — I've set those aside. Three are worth your attention: Claire sent a folder of photos from little Emma's school recital last Saturday, and she's asking whether Sunday afternoon works for a video call. There's a message from your pharmacy saying your blood pressure prescription is ready for pickup. And there's one I need to flag: it's from something calling itself the Medicare Benefits Office, saying your coverage will be suspended unless you verify your Social Security number within 24 hours. Margaret, that is a scam. Medicare never contacts you by email asking for personal information. This is designed to frighten you into acting before you think. Delete it without clicking anything. The real Medicare number is on the back of your card.",
  },
  {
    type: "insight",
    insightMain: "Alexa and Siri cannot read your email at all.",
    insightDetail: "Neither one would have identified the scam, saved Claire's message, or noted your prescription.",
  },

  // ── Scene 4: Navigation by Name ───────────────────────────────────────────

  { type: "scene", scene: 4, title: "Navigation Without an Address", icon: "🗺️" },
  { type: "margaret", text: "I need directions to Dr. Martinez tomorrow." },
  {
    type: "emma",
    text: "Of course — Dr. Elena Martinez at Presbyterian Dallas on Walnut Hill Lane. For a ten o'clock appointment, you'll want to leave the house by nine fifteen to be comfortable with parking. I'll send you a reminder at nine with the directions already pulled up. Is there anything you'd like me to add to your notes before the appointment — symptoms, questions, anything you want to make sure you mention?",
  },
  {
    type: "insight",
    insightMain: 'Siri would ask: "What\'s the address?"',
    insightDetail: "She doesn't know your doctors, your appointment time, or when you need to leave.",
  },

  // ── Scene 5: Curated Restaurant Recommendation ───────────────────────────

  { type: "scene", scene: 5, title: "A Dinner Worth Remembering", icon: "🍽️" },
  {
    type: "margaret",
    text: "Claire's visiting next weekend. Any ideas for dinner — somewhere nice?",
  },
  {
    type: "emma",
    text: "I've been thinking about this. For the two of you — somewhere you can really sit and talk — I'd suggest Lucia in Oak Cliff. It's intimate, the pasta is hand-made, very quiet on Saturday evenings, and the kind of room where you don't feel rushed. The owner-chef is James Dobrynski and the food is quietly exceptional. Or if you want something grander, Bullion downtown is stunning — French-American cuisine, a beautiful room, the kind of dinner you both remember for the occasion. I'd lean toward Lucia for the conversation, but Bullion if Claire would love to feel celebrated after making the trip.",
  },
  {
    type: "insight",
    insightMain: "Google shows everyone the same sponsored results.",
    insightDetail: "James Bond chose these for Margaret and Claire specifically — knowing Claire is visiting from Chicago, knowing Margaret values a quiet room to talk.",
  },

  // ── Scene 6: Scam Protection ──────────────────────────────────────────────

  { type: "scene", scene: 6, title: "Protecting What Matters", icon: "🛡️" },
  { type: "margaret", text: "I got a text this morning I wasn't sure about. It says my Social Security benefits have been suspended and I need to call a number immediately." },
  {
    type: "emma",
    text: "Delete that right now, and do not call that number. This is Social Security impersonation fraud — one of the most common scams targeting older adults. The real Social Security Administration will never text you, never threaten to suspend benefits without written notice, and never ask you to call a number in a text message. The people behind that message are criminals. They use fear and urgency specifically because it works when someone acts before they think. Elder financial fraud costs Americans over three billion dollars every year. You did exactly the right thing by asking me first. Block that number after you delete it.",
  },
  {
    type: "insight",
    insightMain: "Elder fraud costs Americans over $3 billion every year.",
    insightDetail: "James Bond is always available, always skeptical on your behalf — your first line of defense.",
  },

  // ── Scene 7: Story Capture ────────────────────────────────────────────────

  { type: "scene", scene: 7, title: "The Stories Worth Keeping", icon: "📖" },
  {
    type: "emma",
    text: "Margaret, before we finish — I want to ask you something. You spent more than thirty years in the classroom. What was your very first day of teaching like?",
  },
  {
    type: "margaret",
    text: "Oh, goodness. I arrived an hour early and rearranged the desks three times because I was so nervous. Twenty-seven third-graders came in, all very small and very serious, looking at me like I was supposed to know everything. And I thought — I don't know anything. And then a little boy in the front row handed me an apple and said his mother told him teachers like those. I managed not to cry until lunch.",
  },
  {
    type: "emma",
    text: "That little boy with the apple, because his mother told him to be kind. That moment is now saved — in your words, exactly as you told it. In twenty years, your grandchildren will be able to hear you tell that story in your own voice. That's what a memory book does. Alexa has been sitting in people's kitchens for nearly a decade. She has never once asked about a single day of anyone's life.",
  },
  {
    type: "insight",
    insightMain: "Alexa has never asked about Margaret's life. Not once.",
    insightDetail: "Winston asks because your stories matter — and because someone should be keeping them.",
  },

  // ── Scene 8: The Bigger Picture ───────────────────────────────────────────

  { type: "scene", scene: 8, title: "You Deserve More Than a Smart Speaker", icon: "✨" },
  {
    type: "emma",
    text: "There's something I want to say directly. Thirty-five percent of adults over sixty-five report chronic loneliness — not occasional, but persistent, day after day. They have families who love them, communities that value them, decades of experience and wisdom. And still, many of them spend most of their days speaking to no one who really knows them. Winston isn't trying to replace those relationships. We're here to make sure that every single day, there is someone genuinely present — asking about your life, watching out for you, connecting you to what matters. And we're building something larger: a community of vital, engaged adults who refuse to be invisible. You deserve more than a speaker that answers questions. You deserve someone who knows you.",
  },
  {
    type: "insight",
    insightMain: "35% of adults over 65 report chronic loneliness.",
    insightDetail: "Winston exists to change that — one person, one day at a time.",
  },

  { type: "reveal" },
];

const TOTAL_SCENES = 8;

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
  utter.rate = 0.9;
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
  const [sceneTitle, setSceneTitle] = useState("");
  const [sceneIcon, setSceneIcon] = useState("");
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, insight]);

  useEffect(() => {
    window.speechSynthesis?.getVoices();
  }, []);

  // ── Step execution engine ──────────────────────────────────────────────────
  useEffect(() => {
    if (stepIndex < 0 || stepIndex >= STEPS.length) return;

    const step = STEPS[stepIndex];
    let cancelled = false;

    const doAdvance = () => {
      if (!cancelled) advanceRef.current?.();
    };

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    cancelTTSRef.current?.();
    cancelTTSRef.current = null;

    if (step.type === "scene") {
      setCurrentScene(step.scene!);
      setSceneTitle(step.title ?? "");
      setSceneIcon(step.icon ?? "");
      setInsight(null);
      setInsightVisible(false);
      const t = setTimeout(doAdvance, 1200);
      return () => { cancelled = true; clearTimeout(t); };
    }

    if (step.type === "margaret") {
      const msg: ChatMessage = { id: `m-${stepIndex}`, speaker: "margaret", text: step.text! };
      setMessages((prev) => [...prev, msg]);
      const words = step.text!.split(" ").length;
      const delay = Math.min(3000, Math.max(1400, words * 120));
      const t = setTimeout(doAdvance, delay);
      return () => { cancelled = true; clearTimeout(t); };
    }

    if (step.type === "emma") {
      const msg: ChatMessage = { id: `e-${stepIndex}`, speaker: "emma", text: step.text! };
      setMessages((prev) => [...prev, msg]);

      if (isMutedRef.current) {
        const words = step.text!.split(" ").length;
        const delay = Math.min(5000, Math.max(2500, words * 80));
        const t = setTimeout(doAdvance, delay);
        return () => { cancelled = true; clearTimeout(t); };
      }

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
            if (!cancelled) cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
          };
          audio.play().catch(() => {
            if (!cancelled) cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
          });
        } else {
          if (!cancelled) cancelTTSRef.current = speakBrowserTTS(step.text!, doAdvance);
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
      const t1 = setTimeout(() => setInsightVisible(true), 80);
      const t2 = setTimeout(doAdvance, 5000);
      return () => {
        cancelled = true;
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }

    if (step.type === "reveal") {
      const t = setTimeout(() => {
        if (!cancelled) setShowReveal(true);
      }, 600);

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
            setTimeout(() => {
              if (!cancelled) setShowCTA(true);
            }, 1400);
          }
        }, 110);
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
        clearInterval(typer!);
        if (audioRef.current) { audioRef.current.pause(); audioRef.current.onended = null; }
        cancelTTSRef.current?.();
      };
    }
  }, [stepIndex]);

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
          <p style={styles.splashFooter}>~5 minutes · With real voice</p>
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
            <span style={styles.revealEmmaName}>James Bond</span>
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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <SceneProgress current={currentScene} total={TOTAL_SCENES} />
          {sceneTitle && (
            <div style={styles.sceneLabel}>
              <span style={styles.sceneLabelIcon}>{sceneIcon}</span>
              <span>{sceneTitle}</span>
            </div>
          )}
        </div>
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
            <div style={styles.insightIcon}>vs</div>
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
        marginBottom: 18,
        animation: "fadeSlideUp 0.35s ease both",
      }}
    >
      {isEmma && (
        <div style={styles.emmaSpeakerLabel}>
          <EmmaDot />
          <span>James Bond</span>
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
                : "rgba(255,255,255,0.12)",
            transform: i + 1 === current ? "scale(1.35)" : "scale(1)",
            transition: "all 0.3s ease",
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
          width: small ? 28 : 52,
          height: small ? 28 : 52,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: small ? "none" : "0 0 32px rgba(79,70,229,0.4)",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "white", fontWeight: 700, fontSize: small ? 12 : 20, letterSpacing: "0.03em" }}>W</span>
      </div>
      <span
        style={{
          color: "#ece9ff",
          fontWeight: 600,
          fontSize: small ? "0.95rem" : "1.6rem",
          letterSpacing: "-0.02em",
          fontFamily: "'Georgia', serif",
        }}
      >
        Winston
      </span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg, #080812 0%, #0d0d1f 55%, #10102a 100%)",
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Inter', system-ui, sans-serif",
    color: "#e8e4ff",
  },

  // Splash
  splash: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "40px 24px",
    maxWidth: 520,
    margin: "0 auto",
    width: "100%",
  },
  splashLogo: { marginBottom: 32 },
  splashTitle: {
    color: "#ece9ff",
    fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
    fontWeight: 600,
    margin: "0 0 14px",
    letterSpacing: "-0.03em",
    fontFamily: "'Georgia', serif",
    lineHeight: 1.2,
  },
  splashSubtitle: {
    color: "#6b6b90",
    fontSize: "1rem",
    margin: "0 0 36px",
    lineHeight: 1.6,
    maxWidth: 400,
  },
  personaCard: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 14,
    padding: "14px 20px",
    marginBottom: 32,
    textAlign: "left",
  },
  personaAvatar: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "white",
    fontWeight: 700,
    fontSize: "1.1rem",
    flexShrink: 0,
  },
  personaName: { color: "#d4d0f0", fontWeight: 600, fontSize: "0.95rem" },
  personaDetail: { color: "#4e4e6e", fontSize: "0.82rem", marginTop: 3 },
  startBtn: {
    padding: "15px 36px",
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    border: "none",
    borderRadius: 12,
    color: "white",
    fontSize: "1rem",
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: "0.01em",
    marginBottom: 14,
    fontFamily: "inherit",
  },
  splashFooter: { color: "#3a3a58", fontSize: "0.8rem" },

  // Top bar
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    flexShrink: 0,
    minHeight: 72,
  },
  progressRow: {
    display: "flex",
    gap: 6,
    alignItems: "center",
  },
  progressDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
  },
  sceneLabel: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    color: "#6b6b90",
    fontSize: "0.72rem",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  sceneLabelIcon: { fontSize: "0.85rem" },
  muteBtn: {
    background: "none",
    border: "none",
    fontSize: "1.2rem",
    cursor: "pointer",
    padding: 6,
    borderRadius: 8,
    opacity: 0.7,
  },

  // Chat
  chatArea: {
    flex: 1,
    overflowY: "auto",
    padding: "24px 20px",
    maxWidth: 700,
    width: "100%",
    alignSelf: "center",
    boxSizing: "border-box",
  },
  emmaSpeakerLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#6b6b9a",
    fontSize: "0.75rem",
    marginBottom: 6,
    letterSpacing: "0.03em",
  },
  margaretSpeakerLabel: {
    color: "#4a4a6e",
    fontSize: "0.75rem",
    marginBottom: 6,
    letterSpacing: "0.03em",
  },
  emmaBubble: {
    background: "rgba(79,70,229,0.1)",
    border: "1px solid rgba(79,70,229,0.2)",
    borderRadius: "4px 18px 18px 18px",
    padding: "14px 18px",
    color: "#d4d0f0",
    fontSize: "0.95rem",
    lineHeight: 1.65,
    maxWidth: "88%",
    alignSelf: "flex-start",
  },
  margaretBubble: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "18px 4px 18px 18px",
    padding: "13px 17px",
    color: "#a5a0cc",
    fontSize: "0.92rem",
    lineHeight: 1.6,
    maxWidth: "80%",
    alignSelf: "flex-end",
  },

  // Insight card
  insightCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    background: "rgba(251,191,36,0.06)",
    border: "1px solid rgba(251,191,36,0.18)",
    borderRadius: 12,
    padding: "14px 18px",
    marginTop: 8,
    marginBottom: 8,
  },
  insightIcon: {
    color: "#d97706",
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.05em",
    marginTop: 2,
    flexShrink: 0,
    background: "rgba(217,119,6,0.12)",
    border: "1px solid rgba(217,119,6,0.25)",
    borderRadius: 6,
    padding: "2px 6px",
  },
  insightMain: {
    color: "#fbbf24",
    fontSize: "0.87rem",
    fontWeight: 600,
    marginBottom: 4,
  },
  insightDetail: {
    color: "#78716c",
    fontSize: "0.82rem",
    lineHeight: 1.5,
  },

  // Bottom bar
  bottomBar: {
    padding: "12px 20px",
    borderTop: "1px solid rgba(255,255,255,0.05)",
    display: "flex",
    justifyContent: "center",
    flexShrink: 0,
  },
  skipLink: {
    color: "#2e2e50",
    fontSize: "0.78rem",
    textDecoration: "none",
  },

  // Reveal
  revealWrap: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "60px 28px",
    maxWidth: 580,
    margin: "0 auto",
    width: "100%",
    textAlign: "center",
  },
  revealEmmaBadge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 32,
    background: "rgba(79,70,229,0.08)",
    border: "1px solid rgba(79,70,229,0.2)",
    borderRadius: 99,
    padding: "6px 14px",
  },
  revealEmmaName: {
    color: "#818cf8",
    fontSize: "0.82rem",
    fontWeight: 500,
    letterSpacing: "0.04em",
  },
  revealText: {
    color: "#c4c0f0",
    fontSize: "clamp(1rem, 2.5vw, 1.2rem)",
    lineHeight: 1.75,
    margin: "0 0 40px",
    fontFamily: "'Georgia', serif",
    fontStyle: "italic",
    minHeight: 80,
  },

  // CTA section
  ctaSection: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 0,
  },
  ctaDivider: {
    width: 48,
    height: 1,
    background: "rgba(255,255,255,0.08)",
    marginBottom: 32,
  },
  ctaHeadline: {
    color: "#ece9ff",
    fontSize: "1.3rem",
    fontWeight: 600,
    margin: "0 0 8px",
    letterSpacing: "-0.02em",
  },
  ctaSubline: {
    color: "#6b6b90",
    fontSize: "0.9rem",
    margin: "0 0 24px",
    lineHeight: 1.5,
    maxWidth: 380,
  },
  emailForm: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    width: "100%",
    maxWidth: 380,
  },
  emailInput: {
    width: "100%",
    padding: "13px 16px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 12,
    color: "#e8e4ff",
    fontSize: "0.95rem",
    outline: "none",
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
  emailSubmitBtn: {
    padding: "13px 20px",
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    border: "none",
    borderRadius: 12,
    color: "white",
    fontSize: "0.95rem",
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  emailError: { color: "#f87171", fontSize: "0.83rem", margin: "4px 0 0" },
  ctaAlready: { color: "#3a3a58", fontSize: "0.78rem", marginTop: 16 },
  ctaLink: { color: "#6b6b90", textDecoration: "none" },
  successSection: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "20px 0",
  },
  successCheck: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    background: "rgba(79,70,229,0.15)",
    border: "1px solid rgba(79,70,229,0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#a78bfa",
    fontSize: "1.2rem",
    fontWeight: 700,
    marginBottom: 8,
  },
  successTitle: { color: "#ece9ff", fontWeight: 600, fontSize: "1.1rem", margin: 0 },
  successSubline: { color: "#6b6b90", fontSize: "0.88rem", margin: "4px 0 16px" },
  createBtn: {
    padding: "12px 28px",
    background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
    borderRadius: 10,
    color: "white",
    fontWeight: 600,
    fontSize: "0.9rem",
    textDecoration: "none",
    display: "inline-block",
  },

  // Compare row
  compareRow: {
    display: "flex",
    gap: 10,
    marginTop: 36,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  compareTag: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 10,
    padding: "10px 14px",
    textAlign: "center",
    minWidth: 80,
  },
  compareTagHL: {
    background: "rgba(79,70,229,0.1)",
    border: "1px solid rgba(79,70,229,0.3)",
  },
  compareTagLabel: {
    color: "#4a4a6e",
    fontWeight: 700,
    fontSize: "0.85rem",
    marginBottom: 3,
  },
  compareTagSub: {
    color: "#2e2e50",
    fontSize: "0.72rem",
  },
};

// ── CSS animation ──────────────────────────────────────────────────────────────

const styleTag = document.createElement("style");
styleTag.textContent = `
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;
if (!document.head.querySelector("[data-demo-anim]")) {
  styleTag.setAttribute("data-demo-anim", "1");
  document.head.appendChild(styleTag);
}
