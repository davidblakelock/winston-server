import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  Plus,
  X,
  Loader2,
  Play,
  Square,
} from "lucide-react";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_KEY = "winston_session_token";

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(SESSION_KEY);
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base["Authorization"] = `Bearer ${token}`;
  return base;
}

// ─── Presets ─────────────────────────────────────────────────────────────────

const HOBBY_CHIPS = [
  "Cooking", "Reading", "Hiking", "Gaming", "Photography", "Fitness",
  "Travel", "Wine", "Yoga", "Golf", "Pickleball", "Cycling", "Running",
  "Fishing", "Woodworking", "Movies", "Gardening", "Art",
];

const MUSIC_CHIPS = [
  "Rock", "Pop", "Country", "Jazz", "Classical", "Hip-Hop",
  "R&B", "Electronic", "Folk", "Blues", "Indie", "Soul", "Reggae",
];

const CUISINE_OPTIONS = [
  "American", "Italian", "Mexican", "Chinese", "Japanese", "Indian",
  "Thai", "Mediterranean", "French", "BBQ", "Seafood", "Sushi",
  "Vietnamese", "Greek", "Other",
];

const RELATIONSHIP_OPTIONS = [
  "Spouse", "Partner", "Parent", "Child", "Sibling",
  "Friend", "Colleague", "Doctor", "Neighbor", "Other",
];

// ─── Types ────────────────────────────────────────────────────────────────────

type Step =
  | "google"
  | "voice"
  | "about"
  | "people"
  | "favorites"
  | "integrations"
  | "complete";

const STEP_ORDER: Step[] = [
  "google",
  "voice",
  "about",
  "people",
  "favorites",
  "integrations",
  "complete",
];

interface VoiceOption {
  id: string;
  name: string;
  description: string;
  accent: string;
  gender: string;
}

interface Person {
  name: string;
  relationship: string;
}

interface Restaurant {
  name: string;
  cuisine: string;
}

interface ServiceCard {
  serviceName: string;
  serviceType: string;
  displayName: string;
  isConnected: boolean;
  preferred: boolean;
}

interface FormData {
  name?: string;
  city?: string;
  photoUrl?: string;
  voiceId?: string;
  voiceName?: string;
  wakeTime?: string;
  hobbies?: string[];
  musicGenres?: string[];
  sportsTeams?: string[];
  people?: Person[];
  restaurants?: Restaurant[];
  shows?: string[];
  podcasts?: string[];
}

// ─── Small shared components (defined outside main component) ─────────────────

function Chip({
  label,
  selected,
  onToggle,
}: {
  label: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`px-3.5 py-1.5 rounded-full text-sm font-medium border transition-all duration-150 ${
        selected
          ? "bg-indigo-900/50 border-indigo-500 text-indigo-200 ring-1 ring-indigo-500/30"
          : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
      }`}
    >
      {label}
    </button>
  );
}

function AddInput({
  placeholder,
  onAdd,
}: {
  placeholder: string;
  onAdd: (v: string) => void;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    if (val.trim()) {
      onAdd(val.trim());
      setVal("");
    }
  };
  return (
    <div className="flex gap-2">
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
      />
      <button
        onClick={submit}
        disabled={!val.trim()}
        className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl text-sm font-semibold text-white transition-colors"
      >
        Add
      </button>
    </div>
  );
}

function Tag({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 pl-3 pr-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded-full text-xs text-zinc-300">
      {label}
      <button
        onClick={onRemove}
        className="w-4 h-4 rounded-full hover:bg-zinc-600 flex items-center justify-center transition-colors"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}

// ─── Shell layout (defined outside Onboarding to prevent remounting) ──────────

interface ShellProps {
  progress: number;
  canGoBack: boolean;
  onBack: () => void;
  saving?: boolean;
  title: string;
  subtitle?: string;
  onContinue: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  skipLabel?: string;
  onSkip?: () => void;
  children: ReactNode;
}

function Shell({
  progress,
  canGoBack,
  onBack,
  saving,
  title,
  subtitle,
  onContinue,
  continueLabel = "Continue",
  continueDisabled,
  skipLabel,
  onSkip,
  children,
}: ShellProps) {
  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      {/* Progress bar */}
      <div className="flex-shrink-0 h-0.5 bg-zinc-800/80">
        <div
          className="h-full bg-indigo-500 transition-all duration-500 ease-out"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Top nav */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 pt-4 pb-2">
        {canGoBack ? (
          <button
            onClick={onBack}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        ) : (
          <div className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-indigo-600 shadow-lg shadow-indigo-900/50">
            <span className="text-white font-bold text-sm">W</span>
          </div>
        )}
        {skipLabel && onSkip && (
          <button
            onClick={onSkip}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1"
          >
            {skipLabel}
          </button>
        )}
      </div>

      {/* Title */}
      <div className="flex-shrink-0 px-6 pt-2 pb-5">
        <h1 className="text-[26px] font-bold text-zinc-100 tracking-tight leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-zinc-500 mt-1.5 leading-relaxed">{subtitle}</p>
        )}
      </div>

      {/* Scrollable content */}
      <div
        className="flex-1 overflow-y-auto px-6 pb-4"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}
      >
        {children}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 px-6 pb-10 pt-3 bg-gradient-to-t from-zinc-950 via-zinc-950/95 to-transparent">
        <button
          onClick={onContinue}
          disabled={continueDisabled || saving}
          className="w-full h-12 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-35 disabled:cursor-not-allowed text-white font-semibold text-[15px] transition-all duration-150 flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/30"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            continueLabel
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface OnboardingProps {
  onComplete: (companionName?: string) => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("google");
  const [animDir, setAnimDir] = useState<"forward" | "back">("forward");
  const [animKey, setAnimKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState<FormData>({
    hobbies: [],
    musicGenres: [],
    sportsTeams: [],
    people: [],
    restaurants: [],
    shows: [],
    podcasts: [],
    wakeTime: "07:00",
  });

  // ── Google screen state ──────────────────────────────────────────────────
  const [nameInput, setNameInput] = useState("");
  const [cityInput, setCityInput] = useState("");

  // ── Voice screen state ───────────────────────────────────────────────────
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  // ── People screen state ──────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Person[]>([]);
  const [personName, setPersonName] = useState("");
  const [personRel, setPersonRel] = useState("Friend");

  // ── Favorites screen state ───────────────────────────────────────────────
  const [restName, setRestName] = useState("");
  const [restCuisine, setRestCuisine] = useState("American");

  // ── Integrations screen state ────────────────────────────────────────────
  const [integrations, setIntegrations] = useState<ServiceCard[]>([]);
  const [settingPreferred, setSettingPreferred] = useState<string | null>(null);

  const stepIndex = STEP_ORDER.indexOf(step);
  const progress = (stepIndex + 1) / STEP_ORDER.length;

  // ── Fetch session profile on mount ───────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/auth/session`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (d: {
          name?: string;
          picture?: string;
          [key: string]: unknown;
        } | null) => {
          if (d) {
            const name = (d.name as string | undefined) ?? "";
            const picture = (d.picture as string | undefined) ?? "";
            setNameInput(name);
            setForm((prev) => ({ ...prev, name, photoUrl: picture || undefined }));
          }
        }
      )
      .catch(() => {});

    fetch(`${API}/api/onboarding/voices`)
      .then((r) => r.json() as Promise<{ voices: VoiceOption[] }>)
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => {});
  }, []);

  // ── Fetch contacts when landing on people screen ─────────────────────────
  useEffect(() => {
    if (step !== "people") return;
    fetch(`${API}/api/onboarding/suggested-people`, {
      headers: getAuthHeaders(),
    })
      .then((r) => (r.ok ? r.json() : { suggestions: [] }))
      .then((d: { suggestions?: Person[] }) =>
        setContacts(d.suggestions ?? [])
      )
      .catch(() => {});
  }, [step]);

  // ── Fetch integrations when landing on integrations screen ───────────────
  useEffect(() => {
    if (step !== "integrations") return;
    fetch(`${API}/api/integrations`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : { integrations: [] }))
      .then((d: { integrations?: ServiceCard[] }) =>
        setIntegrations(d.integrations ?? [])
      )
      .catch(() => {});
  }, [step]);

  // ── Navigation ───────────────────────────────────────────────────────────
  const navigate = useCallback(
    (direction: "forward" | "back") => {
      const next =
        direction === "forward"
          ? STEP_ORDER[stepIndex + 1]
          : STEP_ORDER[stepIndex - 1];
      if (!next) return;
      setAnimDir(direction);
      setAnimKey((k) => k + 1);
      setStep(next);
    },
    [stepIndex]
  );

  const advance = useCallback(() => {
    if (step === "google") {
      setForm((prev) => ({
        ...prev,
        name: nameInput || prev.name,
        city: cityInput || prev.city,
      }));
    }
    navigate("forward");
  }, [step, nameInput, cityInput, navigate]);

  const back = useCallback(() => navigate("back"), [navigate]);

  const finish = useCallback(async () => {
    setSaving(true);
    try {
      const collectedData = {
        name: form.name || nameInput,
        city: form.city || cityInput,
        voiceId: form.voiceId,
        wakeTime: form.wakeTime,
        interests: [
          ...(form.hobbies ?? []),
          ...(form.podcasts?.map((p) => `podcast: ${p}`) ?? []),
        ],
        music: form.musicGenres,
        sportsTeams: form.sportsTeams,
        people: form.people,
        restaurants: (form.restaurants ?? []).map((r) =>
          r.cuisine ? `${r.name} (${r.cuisine})` : r.name
        ),
        shows: form.shows,
      };

      await fetch(`${API}/api/onboarding/complete`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ collectedData }),
      });

      setTimeout(() => onComplete(undefined), 800);
    } catch {
      onComplete(undefined);
    }
    setSaving(false);
  }, [form, nameInput, cityInput, onComplete]);

  // ── Voice preview ─────────────────────────────────────────────────────────
  const previewVoice = useCallback(
    async (voiceId: string) => {
      if (previewingVoice === voiceId) {
        previewAudio.current?.pause();
        setPreviewingVoice(null);
        return;
      }
      previewAudio.current?.pause();
      setPreviewingVoice(voiceId);
      try {
        const resp = await fetch(`${API}/api/onboarding/voice-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceId }),
        });
        if (!resp.ok) throw new Error("preview failed");
        const { audioBase64, mimeType } = (await resp.json()) as {
          audioBase64: string;
          mimeType: string;
        };
        const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
        previewAudio.current = audio;
        audio.onended = () => setPreviewingVoice(null);
        audio.play().catch(() => setPreviewingVoice(null));
      } catch {
        setPreviewingVoice(null);
      }
    },
    [previewingVoice]
  );

  // ── Chip toggle helper ────────────────────────────────────────────────────
  const toggleChip = useCallback(
    (field: "hobbies" | "musicGenres" | "sportsTeams", value: string) => {
      setForm((prev) => {
        const arr = prev[field] ?? [];
        return {
          ...prev,
          [field]: arr.includes(value)
            ? arr.filter((v) => v !== value)
            : [...arr, value],
        };
      });
    },
    []
  );

  // ── Set preferred integration ─────────────────────────────────────────────
  const setPreferred = useCallback(
    async (serviceName: string, serviceType: string) => {
      setSettingPreferred(serviceName);
      try {
        await fetch(`${API}/api/integrations/${serviceName}/set-preferred`, {
          method: "POST",
          headers: getAuthHeaders(),
        });
        setIntegrations((prev) =>
          prev.map((s) => ({
            ...s,
            preferred:
              s.serviceName === serviceName
                ? true
                : s.serviceType === serviceType
                  ? false
                  : s.preferred,
          }))
        );
      } catch {
        /* ignore */
      }
      setSettingPreferred(null);
    },
    []
  );

  // ── Animation class ───────────────────────────────────────────────────────
  const animClass =
    animDir === "forward"
      ? "animate-in fade-in slide-in-from-right-4 duration-300"
      : "animate-in fade-in slide-in-from-left-4 duration-300";

  const shellProps = {
    progress,
    canGoBack: stepIndex > 0,
    onBack: back,
    saving,
  };

  // ── SCREEN: Google Connect ─────────────────────────────────────────────────
  if (step === "google")
    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="Let's meet you"
          subtitle="Confirm your name and where you're based — we'll use this for weather, events, and briefings."
          onContinue={advance}
          continueDisabled={!nameInput.trim()}
        >
          {/* Profile row */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 mb-5">
            <div className="flex items-center gap-4 mb-5">
              {form.photoUrl ? (
                <img
                  src={form.photoUrl}
                  alt="Profile"
                  className="w-14 h-14 rounded-full object-cover border-2 border-indigo-600/40 flex-shrink-0"
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-indigo-950 border-2 border-indigo-700/40 flex items-center justify-center flex-shrink-0">
                  <span className="text-indigo-300 font-bold text-xl">
                    {(nameInput || "W")[0].toUpperCase()}
                  </span>
                </div>
              )}
              <div>
                <div className="text-[11px] text-indigo-400 font-semibold uppercase tracking-wider mb-0.5">
                  Connected via Google
                </div>
                <div className="text-base font-semibold text-zinc-100">
                  {nameInput || "Your account"}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-1.5 block">
                  Your name
                </label>
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Your name"
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>
          </div>

          {/* City */}
          <div>
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-1.5 block">
              Your city
            </label>
            <input
              value={cityInput}
              onChange={(e) => setCityInput(e.target.value)}
              placeholder="e.g. San Antonio, TX"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Used for weather, drive times, and local context in your morning briefings.
            </p>
          </div>
        </Shell>
      </div>
    );

  // ── SCREEN: Choose Voice ───────────────────────────────────────────────────
  if (step === "voice")
    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="Choose your companion's voice"
          subtitle="Tap any card to hear a preview. You can change this anytime."
          onContinue={advance}
          continueLabel={
            form.voiceId
              ? `Continue with ${voices.find((v) => v.id === form.voiceId)?.name ?? "this voice"}`
              : "Select a voice to continue"
          }
          continueDisabled={!form.voiceId}
          skipLabel="Skip"
          onSkip={advance}
        >
          <div className="grid grid-cols-2 gap-3 pb-2">
            {voices.map((voice) => {
              const isSelected = form.voiceId === voice.id;
              const isPreviewing = previewingVoice === voice.id;
              return (
                <button
                  key={voice.id}
                  onClick={() => {
                    setForm((prev) => ({
                      ...prev,
                      voiceId: voice.id,
                      voiceName: voice.name,
                    }));
                    void previewVoice(voice.id);
                  }}
                  className={`relative text-left rounded-2xl p-4 border transition-all duration-200 focus:outline-none ${
                    isSelected
                      ? "bg-indigo-950/60 border-indigo-500 ring-2 ring-indigo-500/30"
                      : "bg-zinc-900 border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/60"
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                  {isPreviewing && !isSelected && (
                    <div className="absolute top-3 right-3 flex items-center gap-0.5">
                      {[0, 150, 300].map((d) => (
                        <div
                          key={d}
                          className="w-0.5 h-3 bg-indigo-400 rounded-full animate-bounce"
                          style={{ animationDelay: `${d}ms` }}
                        />
                      ))}
                    </div>
                  )}
                  <div className="pr-6">
                    <div className="text-sm font-semibold text-zinc-100 leading-tight">
                      {voice.name}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5 leading-snug">
                      {voice.description}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5">
                    {isPreviewing ? (
                      <>
                        <Square className="w-3 h-3 text-indigo-400 fill-indigo-400" />
                        <span className="text-xs text-indigo-400">Playing…</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3 text-zinc-600" />
                        <span className="text-xs text-zinc-600">Preview</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Shell>
      </div>
    );

  // ── SCREEN: About You ──────────────────────────────────────────────────────
  if (step === "about")
    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="About you"
          subtitle="Winston uses this to personalize your briefings, conversation, and alerts."
          onContinue={advance}
        >
          {/* Wake time */}
          <div className="mb-7">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              What time do you usually wake up?
            </label>
            <input
              type="time"
              value={form.wakeTime ?? "07:00"}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, wakeTime: e.target.value }))
              }
              className="bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            <p className="text-xs text-zinc-600 mt-1.5">
              Briefings and morning alerts are timed around this.
            </p>
          </div>

          {/* Hobbies */}
          <div className="mb-7">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              Hobbies & interests
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {HOBBY_CHIPS.map((h) => (
                <Chip
                  key={h}
                  label={h}
                  selected={form.hobbies?.includes(h) ?? false}
                  onToggle={() => toggleChip("hobbies", h)}
                />
              ))}
            </div>
            <AddInput
              placeholder="Add another…"
              onAdd={(v) =>
                setForm((prev) => ({
                  ...prev,
                  hobbies: [...(prev.hobbies ?? []), v],
                }))
              }
            />
            {(form.hobbies?.filter((h) => !HOBBY_CHIPS.includes(h)) ?? [])
              .length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {form.hobbies
                  ?.filter((h) => !HOBBY_CHIPS.includes(h))
                  .map((h) => (
                    <Tag
                      key={h}
                      label={h}
                      onRemove={() =>
                        setForm((prev) => ({
                          ...prev,
                          hobbies: prev.hobbies?.filter((x) => x !== h),
                        }))
                      }
                    />
                  ))}
              </div>
            )}
          </div>

          {/* Music genres */}
          <div className="mb-7">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              Music genres
            </label>
            <div className="flex flex-wrap gap-2">
              {MUSIC_CHIPS.map((g) => (
                <Chip
                  key={g}
                  label={g}
                  selected={form.musicGenres?.includes(g) ?? false}
                  onToggle={() => toggleChip("musicGenres", g)}
                />
              ))}
            </div>
          </div>

          {/* Sports teams */}
          <div className="mb-2">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              Favorite sports teams
            </label>
            <AddInput
              placeholder="e.g. San Antonio Spurs…"
              onAdd={(v) =>
                setForm((prev) => ({
                  ...prev,
                  sportsTeams: [...(prev.sportsTeams ?? []), v],
                }))
              }
            />
            {(form.sportsTeams ?? []).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {form.sportsTeams?.map((t) => (
                  <Tag
                    key={t}
                    label={t}
                    onRemove={() =>
                      setForm((prev) => ({
                        ...prev,
                        sportsTeams: prev.sportsTeams?.filter((x) => x !== t),
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </Shell>
      </div>
    );

  // ── SCREEN: My People ──────────────────────────────────────────────────────
  if (step === "people") {
    const addPerson = () => {
      if (!personName.trim()) return;
      setForm((prev) => ({
        ...prev,
        people: [
          ...(prev.people ?? []),
          { name: personName.trim(), relationship: personRel },
        ],
      }));
      setPersonName("");
    };

    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="Your people"
          subtitle="Winston remembers birthdays, check-ins, and what matters about the people you care about."
          onContinue={advance}
          continueLabel={
            (form.people ?? []).length === 0
              ? "Continue without adding anyone"
              : `Continue with ${form.people!.length} person${form.people!.length > 1 ? "s" : ""}`
          }
          skipLabel="Skip for now"
          onSkip={advance}
        >
          {/* Add person form */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 mb-5">
            <p className="text-xs text-zinc-500 font-semibold uppercase tracking-wider mb-3">
              Add a person
            </p>
            <input
              value={personName}
              onChange={(e) => setPersonName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addPerson();
              }}
              placeholder="Name"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors mb-3"
            />
            <div className="flex flex-wrap gap-1.5 mb-3">
              {RELATIONSHIP_OPTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setPersonRel(r)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                    personRel === r
                      ? "bg-indigo-900/50 border-indigo-500 text-indigo-200"
                      : "bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <button
              onClick={addPerson}
              disabled={!personName.trim()}
              className="w-full h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add Person
            </button>
          </div>

          {/* Suggested from Google Contacts */}
          {contacts.length > 0 && (
            <div className="mb-5">
              <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2">
                Suggested from your contacts
              </p>
              <div className="space-y-2">
                {contacts.slice(0, 6).map((c) => {
                  const added = form.people?.some(
                    (p) => p.name.toLowerCase() === c.name.toLowerCase()
                  );
                  return (
                    <button
                      key={c.name}
                      onClick={() => {
                        if (!added) {
                          setForm((prev) => ({
                            ...prev,
                            people: [...(prev.people ?? []), c],
                          }));
                        }
                      }}
                      disabled={added}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left ${
                        added
                          ? "bg-indigo-950/20 border-indigo-800/50 cursor-default"
                          : "bg-zinc-900 border-zinc-800 hover:border-zinc-600 active:bg-zinc-800"
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium text-zinc-100">
                          {c.name}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {c.relationship}
                        </div>
                      </div>
                      {added ? (
                        <Check className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                      ) : (
                        <Plus className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Added people */}
          {(form.people ?? []).length > 0 && (
            <div>
              <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2">
                Added ({form.people?.length})
              </p>
              <div className="space-y-2">
                {form.people?.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-xl"
                  >
                    <div>
                      <div className="text-sm font-medium text-zinc-100">
                        {p.name}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {p.relationship}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          people: prev.people?.filter((_, j) => j !== i),
                        }))
                      }
                      className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-zinc-800 text-zinc-600 hover:text-zinc-300 transition-all"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Shell>
      </div>
    );
  }

  // ── SCREEN: Favorites ──────────────────────────────────────────────────────
  if (step === "favorites") {
    const addRestaurant = () => {
      if (!restName.trim()) return;
      setForm((prev) => ({
        ...prev,
        restaurants: [
          ...(prev.restaurants ?? []),
          { name: restName.trim(), cuisine: restCuisine },
        ],
      }));
      setRestName("");
    };

    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="Your favorites"
          subtitle="Winston references these in conversation, briefings, and recommendations."
          onContinue={advance}
        >
          {/* Restaurants */}
          <div className="mb-7">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              Favorite restaurants
            </label>
            <div className="flex gap-2 mb-2">
              <input
                value={restName}
                onChange={(e) => setRestName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addRestaurant();
                }}
                placeholder="Restaurant name"
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <select
                value={restCuisine}
                onChange={(e) => setRestCuisine(e.target.value)}
                className="bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                {CUISINE_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={addRestaurant}
              disabled={!restName.trim()}
              className="w-full h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed text-sm text-zinc-300 transition-colors flex items-center justify-center gap-2 border border-zinc-700 mb-3"
            >
              <Plus className="w-4 h-4" />
              Add Restaurant
            </button>
            {(form.restaurants ?? []).length > 0 && (
              <div className="space-y-2">
                {form.restaurants?.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-xl"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-zinc-100 truncate">
                        {r.name}
                      </span>
                      <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full flex-shrink-0">
                        {r.cuisine}
                      </span>
                    </div>
                    <button
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          restaurants: prev.restaurants?.filter(
                            (_, j) => j !== i
                          ),
                        }))
                      }
                      className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-zinc-700 text-zinc-600 hover:text-zinc-300 transition-all ml-2 flex-shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* TV Shows */}
          <div className="mb-7">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              TV shows & movies
            </label>
            <AddInput
              placeholder="e.g. Succession, The Bear…"
              onAdd={(v) =>
                setForm((prev) => ({
                  ...prev,
                  shows: [...(prev.shows ?? []), v],
                }))
              }
            />
            {(form.shows ?? []).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {form.shows?.map((s) => (
                  <Tag
                    key={s}
                    label={s}
                    onRemove={() =>
                      setForm((prev) => ({
                        ...prev,
                        shows: prev.shows?.filter((x) => x !== s),
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Podcasts */}
          <div className="mb-2">
            <label className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2 block">
              Podcasts{" "}
              <span className="normal-case text-zinc-600 font-normal">
                (optional)
              </span>
            </label>
            <AddInput
              placeholder="e.g. How I Built This…"
              onAdd={(v) =>
                setForm((prev) => ({
                  ...prev,
                  podcasts: [...(prev.podcasts ?? []), v],
                }))
              }
            />
            {(form.podcasts ?? []).length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {form.podcasts?.map((p) => (
                  <Tag
                    key={p}
                    label={p}
                    onRemove={() =>
                      setForm((prev) => ({
                        ...prev,
                        podcasts: prev.podcasts?.filter((x) => x !== p),
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </Shell>
      </div>
    );
  }

  // ── SCREEN: Integrations ───────────────────────────────────────────────────
  if (step === "integrations") {
    const grouped: Record<string, ServiceCard[]> = {};
    for (const s of integrations) {
      if (!grouped[s.serviceType]) grouped[s.serviceType] = [];
      grouped[s.serviceType].push(s);
    }

    const TYPE_ORDER = ["grocery", "health", "shopping"];
    const TYPE_LABELS: Record<string, string> = {
      grocery: "Grocery",
      health: "Health & Fitness",
      shopping: "Shopping",
    };

    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <Shell
          {...shellProps}
          title="Connect your apps"
          subtitle="Select your preferred apps for each category. Winston uses these for shopping lists and links."
          onContinue={advance}
          skipLabel="Skip for now"
          onSkip={advance}
        >
          {TYPE_ORDER.filter((t) => grouped[t]?.length).map((type) => (
            <div key={type} className="mb-6">
              <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider mb-2">
                {TYPE_LABELS[type] ?? type}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {grouped[type].map((svc) => (
                  <button
                    key={svc.serviceName}
                    onClick={() => void setPreferred(svc.serviceName, svc.serviceType)}
                    disabled={settingPreferred !== null}
                    className={`relative text-left rounded-2xl p-4 border transition-all duration-200 focus:outline-none ${
                      svc.preferred
                        ? "bg-indigo-950/50 border-indigo-500 ring-2 ring-indigo-500/25"
                        : "bg-zinc-900 border-zinc-800 hover:border-zinc-600 active:bg-zinc-800"
                    }`}
                  >
                    {svc.preferred && settingPreferred !== svc.serviceName && (
                      <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                        <Check className="w-3 h-3 text-white" />
                      </div>
                    )}
                    {settingPreferred === svc.serviceName && (
                      <div className="absolute top-3 right-3">
                        <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
                      </div>
                    )}
                    <div className="text-sm font-semibold text-zinc-100 pr-7 leading-tight">
                      {svc.displayName}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {svc.preferred ? "Preferred ✓" : "Tap to select"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {integrations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-zinc-600">
              <Loader2 className="w-5 h-5 animate-spin mb-2" />
              <span className="text-sm">Loading…</span>
            </div>
          )}
        </Shell>
      </div>
    );
  }

  // ── SCREEN: Complete ───────────────────────────────────────────────────────
  if (step === "complete") {
    const firstName = (form.name || nameInput || "").split(" ")[0] || "there";

    const summaryItems = [
      form.voiceName && `Companion voice: ${form.voiceName}`,
      form.wakeTime && `Wake time: ${form.wakeTime}`,
      (form.city || cityInput) && `Based in ${form.city || cityInput}`,
      (form.hobbies ?? []).length > 0 &&
        `${form.hobbies!.length} interest${form.hobbies!.length > 1 ? "s" : ""} captured`,
      (form.musicGenres ?? []).length > 0 &&
        `Music: ${form.musicGenres!.slice(0, 2).join(", ")}${form.musicGenres!.length > 2 ? "…" : ""}`,
      (form.people ?? []).length > 0 &&
        `${form.people!.length} person${form.people!.length > 1 ? "s" : ""} in your network`,
      (form.restaurants ?? []).length > 0 &&
        `${form.restaurants!.length} favorite restaurant${form.restaurants!.length > 1 ? "s" : ""}`,
      (form.shows ?? []).length > 0 &&
        `${form.shows!.length} show${form.shows!.length > 1 ? "s" : ""}`,
      integrations.some((s) => s.preferred && s.serviceType === "grocery") &&
        `Grocery: ${integrations.find((s) => s.preferred && s.serviceType === "grocery")?.displayName}`,
    ].filter(Boolean) as string[];

    return (
      <div key={`${step}-${animKey}`} className={animClass}>
        <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
          <div className="flex-shrink-0 h-0.5 bg-indigo-500" />

          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center overflow-y-auto py-8"
            style={{ scrollbarWidth: "none" }}
          >
            {/* Logo */}
            <div className="w-16 h-16 rounded-3xl bg-indigo-600 flex items-center justify-center mb-6 shadow-2xl shadow-indigo-900/60">
              <span className="text-white font-bold text-2xl">W</span>
            </div>

            <h1 className="text-[26px] font-bold text-zinc-100 mb-2 tracking-tight">
              You're all set, {firstName}!
            </h1>
            <p className="text-sm text-zinc-500 mb-7 leading-relaxed max-w-xs">
              Here's what Winston knows about you to get started:
            </p>

            {summaryItems.length > 0 && (
              <div className="w-full max-w-xs bg-zinc-900 border border-zinc-800 rounded-2xl p-4 mb-8 text-left">
                {summaryItems.map((item, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 ${
                      i > 0 ? "border-t border-zinc-800 mt-2.5 pt-2.5" : ""
                    }`}
                  >
                    <div className="w-5 h-5 rounded-full bg-indigo-900/50 border border-indigo-700/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-indigo-400" />
                    </div>
                    <span className="text-sm text-zinc-300 leading-snug">
                      {item}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-zinc-600 max-w-xs leading-relaxed">
              You can update any of this anytime from the settings panel.
            </p>
          </div>

          {/* CTA */}
          <div className="flex-shrink-0 px-6 pb-10 pt-3">
            <button
              onClick={() => void finish()}
              disabled={saving}
              className="w-full h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-40 text-white font-semibold text-[15px] transition-all flex items-center justify-center gap-2 shadow-xl shadow-indigo-900/40"
            >
              {saving ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                "Say good morning to Winston →"
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
