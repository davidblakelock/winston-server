import {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
} from "react";
import { Send, Mic, MicOff, Loader2, Play, Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");
const SESSION_KEY = "winston_session_token";

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem(SESSION_KEY);
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (token) base["Authorization"] = `Bearer ${token}`;
  return base;
}

interface Message {
  id: string;
  role: "assistant" | "user";
  content: string;
}

interface VoiceOption {
  id: string;
  name: string;
  description: string;
  accent: string;
  gender: string;
}

interface CollectedData {
  companionName?: string;
  name?: string;
  city?: string;
  wakeTime?: string;
  voiceId?: string;
  voiceName?: string;
  healthNotes?: string;
  wantsStoryArchive?: boolean;
  people?: Array<{ name: string; relationship: string; city?: string }>;
  places?: Array<{ name: string; address?: string }>;
  shows?: string[];
  restaurants?: string[];
  sportsTeams?: string[];
  music?: string[];
  interests?: string[];
}

interface SuggestedPerson {
  name: string;
  relationship: string;
  email?: string;
  phone?: string;
  resourceName?: string;
  confidence: "high" | "medium";
  source: "relation" | "family_group" | "same_name";
}

// ─── Voice recorder hook ────────────────────────────────────────────────────
type RecordingState = "idle" | "recording" | "transcribing";

function useVoiceRecorder(onTranscript: (text: string) => void) {
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopMonitoring = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    animFrameRef.current = null;
    silenceTimerRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    stopMonitoring();
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, [stopMonitoring]);

  const monitorSilence = useCallback(
    (analyser: AnalyserNode) => {
      const data = new Uint8Array(analyser.fftSize);
      const check = () => {
        analyser.getByteTimeDomainData(data);
        const amplitude = Math.max(...data.map((v) => Math.abs(v - 128)));
        if (amplitude < 10) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(stopRecording, 2200);
          }
        } else {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        }
        animFrameRef.current = requestAnimationFrame(check);
      };
      animFrameRef.current = requestAnimationFrame(check);
    },
    [stopRecording]
  );

  const startRecording = useCallback(async () => {
    if (recordingState !== "idle") { stopRecording(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopMonitoring();
        setRecordingState("transcribing");
        try {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          const form = new FormData();
          form.append("audio", blob, "recording.webm");
          const resp = await fetch(`${API}/api/transcribe`, { method: "POST", body: form });
          if (!resp.ok) throw new Error("Transcription failed");
          const { text } = await resp.json() as { text: string };
          if (text?.trim()) onTranscript(text.trim());
        } catch (err) {
          console.error("Transcription error:", err);
        } finally {
          setRecordingState("idle");
        }
      };

      recorder.start(100);
      setRecordingState("recording");
      monitorSilence(analyser);
    } catch {
      setRecordingState("idle");
    }
  }, [recordingState, stopRecording, stopMonitoring, monitorSilence, onTranscript]);

  useEffect(() => () => { stopMonitoring(); streamRef.current?.getTracks().forEach((t) => t.stop()); }, [stopMonitoring]);

  return { recordingState, startRecording, stopRecording };
}

// ─── Scene labels ────────────────────────────────────────────────────────────
// Scene 1: Welcome, Scene 2: Voice Selection, Scene 3: Companion Naming,
// Scene 4: About You, Scene 5: Your People, Scene 6: Wellbeing,
// Scene 7: Your Places, Scene 8: What You Love, Scene 9: First Briefing
const SCENE_LABELS = [
  "Welcome",
  "Your Voice",
  "Your Companion",
  "About You",
  "Your People",
  "Wellbeing",
  "Your Places",
  "What You Love",
  "First Briefing",
];

// ─── Main component ──────────────────────────────────────────────────────────
interface OnboardingProps {
  onComplete: (companionName?: string) => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [scene, setScene] = useState(1);
  const [collectedData, setCollectedData] = useState<CollectedData>({});
  const [loading, setLoading] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voiceAudioRef] = useState<{ current: HTMLAudioElement | null }>({ current: null });
  // ── Scene 5 people suggestions from Google Contacts ──
  const [suggestedPeople, setSuggestedPeople] = useState<SuggestedPerson[]>([]);
  const [dismissedIdxs, setDismissedIdxs] = useState<Set<number>>(new Set());
  const [confirmedIdxs, setConfirmedIdxs] = useState<Set<number>>(new Set());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editedRelationships, setEditedRelationships] = useState<Record<number, string>>({});
  const suggestFetchedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const initialized = useRef(false);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Load voice options
  useEffect(() => {
    fetch(`${API}/api/onboarding/voices`)
      .then((r) => r.json() as Promise<{ voices: VoiceOption[] }>)
      .then((d) => setVoices(d.voices ?? []))
      .catch(() => {});
  }, []);

  // Scene 5: fetch Google Contacts family suggestions
  useEffect(() => {
    if (scene === 5 && !suggestFetchedRef.current) {
      suggestFetchedRef.current = true;
      fetch(`${API}/api/onboarding/suggested-people`, { headers: getAuthHeaders() })
        .then((r) => r.json() as Promise<{ suggestions: SuggestedPerson[] }>)
        .then((d) => { if (d.suggestions?.length > 0) setSuggestedPeople(d.suggestions); })
        .catch(() => {});
    }
  }, [scene]);

  const playAudio = useCallback((base64: string, mimeType = "audio/mpeg") => {
    audioRef.current?.pause();
    const audio = new Audio(`data:${mimeType};base64,${base64}`);
    audioRef.current = audio;
    audio.play().catch(() => {});
  }, []);

  const sendMessage = useCallback(
    async (text: string, currentHistory: Message[], currentScene: number, currentData: CollectedData) => {
      setLoading(true);
      try {
        const resp = await fetch(`${API}/api/onboarding/chat`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            message: text,
            history: currentHistory.map((m) => ({ role: m.role, content: m.content })),
            scene: currentScene,
            collectedData: currentData,
          }),
        });

        if (!resp.ok) throw new Error("Chat failed");

        const data = await resp.json() as {
          reply: string;
          audioBase64?: string;
          mimeType?: string;
          scene: number;
          collectedData: CollectedData;
          isComplete: boolean;
        };

        const emmaMsg: Message = {
          id: `emma-${Date.now()}`,
          role: "assistant",
          content: data.reply,
        };

        setMessages((prev) => [...prev, emmaMsg]);
        setScene(data.scene);
        setCollectedData(data.collectedData);

        if (data.audioBase64) {
          playAudio(data.audioBase64, data.mimeType);
        }

        if (data.isComplete) {
          setTimeout(() => onComplete(data.collectedData?.companionName ?? undefined), 3500);
        }
      } catch (err) {
        console.error("Onboarding chat error:", err);
      } finally {
        setLoading(false);
      }
    },
    [onComplete, playAudio]
  );

  // Emma speaks first on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void sendMessage("", [], 1, {});
  }, [sendMessage]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
    };

    setMessages((prev) => {
      const newHistory = [...prev, userMsg];
      void sendMessage(text, prev, scene, collectedData);
      return newHistory;
    });
  }, [input, loading, scene, collectedData, sendMessage]);

  const handleTranscript = useCallback(
    (text: string) => {
      setInput(text);
      setTimeout(async () => {
        const userMsg: Message = {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
        };
        setMessages((prev) => {
          const newHistory = [...prev, userMsg];
          void sendMessage(text, prev, scene, collectedData);
          return newHistory;
        });
        setInput("");
      }, 100);
    },
    [scene, collectedData, sendMessage]
  );

  const { recordingState, startRecording } = useVoiceRecorder(handleTranscript);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  // Voice preview — tries ElevenLabs first, falls back to browser TTS
  const previewVoice = useCallback(async (voiceId: string, voiceName?: string) => {
    if (previewingVoice === voiceId) {
      voiceAudioRef.current?.pause();
      window.speechSynthesis?.cancel();
      setPreviewingVoice(null);
      return;
    }
    setPreviewError(null);
    setPreviewingVoice(voiceId);
    const PREVIEW_TEXT = "Hello — I've been looking forward to meeting you.";
    try {
      const resp = await fetch(`${API}/api/onboarding/voice-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId }),
      });
      if (!resp.ok) throw new Error("ElevenLabs preview unavailable");
      const { audioBase64, mimeType } = await resp.json() as { audioBase64: string; mimeType: string };
      const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
      voiceAudioRef.current = audio;
      audio.onended = () => setPreviewingVoice(null);
      audio.play().catch(() => setPreviewingVoice(null));
    } catch {
      // Fall back to browser speech synthesis so the user hears something
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(PREVIEW_TEXT);
        utter.onend = () => setPreviewingVoice(null);
        utter.onerror = () => {
          setPreviewingVoice(null);
          setPreviewError(`Preview unavailable for ${voiceName ?? "this voice"}`);
        };
        window.speechSynthesis.speak(utter);
      } else {
        setPreviewingVoice(null);
        setPreviewError("Voice preview is currently unavailable");
      }
    }
  }, [previewingVoice, voiceAudioRef]);

  const selectVoice = useCallback(
    (voice: VoiceOption) => {
      setSelectedVoice(voice.id);
      voiceAudioRef.current?.pause();
      window.speechSynthesis?.cancel();
      setPreviewingVoice(null);
      setPreviewError(null);

      const updatedData = { ...collectedData, voiceId: voice.id, voiceName: voice.name };
      setCollectedData(updatedData);

      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: `I'll go with ${voice.name} — ${voice.description}.`,
      };
      setMessages((prev) => {
        const newHistory = [...prev, userMsg];
        void sendMessage(userMsg.content, prev, scene, updatedData);
        return newHistory;
      });
    },
    [collectedData, scene, sendMessage, voiceAudioRef]
  );

  const handleConfirmSuggestion = useCallback(
    (idx: number) => {
      const person = suggestedPeople[idx];
      if (!person) return;
      const relationship = editedRelationships[idx] ?? person.relationship;
      setCollectedData((prev) => ({
        ...prev,
        people: [...(prev.people ?? []), { name: person.name, relationship }],
      }));
      setConfirmedIdxs((prev) => new Set([...prev, idx]));
      setEditingIdx(null);
    },
    [suggestedPeople, editedRelationships]
  );

  const handleDismissSuggestion = useCallback((idx: number) => {
    setDismissedIdxs((prev) => new Set([...prev, idx]));
    if (editingIdx === idx) setEditingIdx(null);
  }, [editingIdx]);

  const handleEditSuggestion = useCallback((idx: number, currentRelationship: string) => {
    setEditingIdx(idx);
    setEditedRelationships((prev) => ({ ...prev, [idx]: currentRelationship }));
  }, []);

  const handleSkip = useCallback(async () => {
    try {
      await fetch(`${API}/api/onboarding/complete`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ collectedData }),
      });
      onComplete(collectedData.companionName ?? undefined);
    } catch {
      onComplete(collectedData.companionName ?? undefined);
    }
  }, [collectedData, onComplete]);

  const isRecording = recordingState === "recording";
  const isTranscribing = recordingState === "transcribing";
  const showVoiceCards = scene === 2 && voices.length > 0 && !selectedVoice;

  // Scene 5: visible suggestion cards (not dismissed)
  const visibleSuggestions = suggestedPeople
    .map((p, i) => ({ ...p, idx: i }))
    .filter((p) => !dismissedIdxs.has(p.idx));
  const showSuggestionCards = scene === 5 && visibleSuggestions.length > 0;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      {/* ── Scene progress bar ── */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3">
        <div className="max-w-xl mx-auto">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-indigo-400 tracking-wide uppercase">
              {SCENE_LABELS[scene - 1]}
            </span>
            <div className="flex items-center gap-3">
              {messages.length > 0 && (
                <button
                  onClick={() => void handleSkip()}
                  className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline underline-offset-2"
                >
                  Skip setup
                </button>
              )}
              <span className="text-xs text-zinc-600">{scene} / 9</span>
            </div>
          </div>
          <div className="flex gap-1">
            {SCENE_LABELS.map((_, i) => (
              <div
                key={i}
                className={`h-0.5 flex-1 rounded-full transition-all duration-500 ${
                  i < scene
                    ? "bg-indigo-500"
                    : i === scene - 1
                    ? "bg-indigo-400"
                    : "bg-zinc-800"
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── Chat messages ── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
        style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}
      >
        <div className="max-w-xl mx-auto space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
            >
              {msg.role === "assistant" && (
                <Avatar className="h-8 w-8 flex-shrink-0 mt-0.5 bg-indigo-900 border border-indigo-700/50">
                  <AvatarFallback className="text-xs font-semibold text-indigo-300 bg-transparent">
                    {collectedData.companionName
                      ? collectedData.companionName.trim().split(/\s+/).map((w) => w[0].toUpperCase()).join("").slice(0, 2)
                      : "W"}
                  </AvatarFallback>
                </Avatar>
              )}
              <div
                className={`rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed ${
                  msg.role === "assistant"
                    ? "bg-zinc-800 text-zinc-100 rounded-tl-sm border border-zinc-700/50"
                    : "bg-indigo-600 text-white rounded-tr-sm"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex gap-3">
              <Avatar className="h-8 w-8 flex-shrink-0 mt-0.5 bg-indigo-900 border border-indigo-700/50">
                <AvatarFallback className="text-xs font-semibold text-indigo-300 bg-transparent">
                  {collectedData.companionName
                    ? collectedData.companionName.trim().split(/\s+/).map((w) => w[0].toUpperCase()).join("").slice(0, 2)
                    : "W"}
                </AvatarFallback>
              </Avatar>
              <div className="bg-zinc-800 border border-zinc-700/50 rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex gap-1 items-center h-4">
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Voice selection cards (Scene 7) ── */}
      {showVoiceCards && (
        <div className="flex-shrink-0 px-4 pb-2">
          <div className="max-w-xl mx-auto grid grid-cols-2 gap-2">
            {voices.map((voice, i) => (
              <div
                key={voice.id}
                className="bg-zinc-800 border border-zinc-700/50 rounded-xl p-3 flex flex-col gap-2"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-sm font-semibold text-zinc-100">
                      {i + 1}. {voice.name}
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">{voice.description}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 h-7 text-xs text-zinc-300 hover:text-white hover:bg-zinc-700 border border-zinc-600"
                    onClick={() => void previewVoice(voice.id, voice.name)}
                    disabled={previewingVoice !== null && previewingVoice !== voice.id}
                  >
                    {previewingVoice === voice.id ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3 mr-1" />
                    )}
                    {previewingVoice === voice.id ? "Playing…" : "Preview"}
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 h-7 text-xs bg-indigo-600 hover:bg-indigo-500 text-white"
                    onClick={() => selectVoice(voice)}
                  >
                    <Check className="w-3 h-3 mr-1" />
                    Choose
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {previewError && (
            <p className="text-xs text-amber-400/80 text-center mt-1 px-2">{previewError}</p>
          )}
        </div>
      )}

      {/* ── Scene 5: People suggestions from Google Contacts ── */}
      {showSuggestionCards && (
        <div className="flex-shrink-0 px-4 pb-2">
          <div className="max-w-xl mx-auto">
            <div className="flex items-center justify-between mb-2 px-1">
              <p className="text-xs text-zinc-500 font-medium">
                From your Google Contacts
              </p>
              <button
                onClick={() => setDismissedIdxs(new Set(suggestedPeople.map((_, i) => i)))}
                className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline underline-offset-2"
              >
                Skip all
              </button>
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1" style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}>
              {visibleSuggestions.map((person) => {
                const isConfirmed = confirmedIdxs.has(person.idx);
                const isEditing = editingIdx === person.idx;
                const displayRelationship = editedRelationships[person.idx] ?? person.relationship;
                const initial = person.name.trim()[0]?.toUpperCase() ?? "?";

                return (
                  <div
                    key={person.idx}
                    className={`rounded-xl border px-3 py-2.5 transition-all duration-200 ${
                      isConfirmed
                        ? "bg-emerald-950/30 border-emerald-800/40"
                        : "bg-zinc-800/70 border-zinc-700/50"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-semibold ${
                        isConfirmed ? "bg-emerald-800/60 text-emerald-200" : "bg-zinc-700 text-zinc-300"
                      }`}>
                        {isConfirmed ? <Check className="w-4 h-4" /> : initial}
                      </div>

                      {/* Name + relationship */}
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate ${isConfirmed ? "text-emerald-300" : "text-zinc-100"}`}>
                          {person.name}
                        </div>
                        {isEditing ? (
                          <input
                            className="mt-0.5 text-xs bg-zinc-700 text-zinc-100 rounded px-2 py-0.5 border border-indigo-600 w-full max-w-[160px] focus:outline-none"
                            value={displayRelationship}
                            autoFocus
                            onChange={(e) =>
                              setEditedRelationships((prev) => ({ ...prev, [person.idx]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleConfirmSuggestion(person.idx);
                              if (e.key === "Escape") setEditingIdx(null);
                            }}
                            placeholder="e.g. daughter, spouse…"
                          />
                        ) : (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={`text-xs px-1.5 py-0.5 rounded-full border ${
                              isConfirmed
                                ? "text-emerald-400 bg-emerald-950/50 border-emerald-800/50"
                                : "text-indigo-300 bg-indigo-950/50 border-indigo-800/50"
                            }`}>
                              {displayRelationship}
                            </span>
                            {person.source === "same_name" && !isConfirmed && (
                              <span className="text-[10px] text-zinc-600">same name</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      {!isConfirmed && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleEditSuggestion(person.idx, displayRelationship)}
                            title="Edit relationship"
                            className="h-6 w-6 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleConfirmSuggestion(person.idx)}
                            title="Add this person"
                            className="h-6 w-6 rounded-lg flex items-center justify-center text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/50 transition-colors"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDismissSuggestion(person.idx)}
                            title="Remove suggestion"
                            className="h-6 w-6 rounded-lg flex items-center justify-center text-zinc-600 hover:text-zinc-400 hover:bg-zinc-700 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Input area ── */}
      <div className="flex-shrink-0 px-4 pb-6 pt-2">
        <div className="max-w-xl mx-auto">
          <div className="flex gap-2 items-end bg-zinc-800 border border-zinc-700/50 rounded-2xl px-4 py-3">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                recordingState === "recording"
                  ? "Listening…"
                  : recordingState === "transcribing"
                  ? "Transcribing…"
                  : "Say something…"
              }
              rows={1}
              className="flex-1 min-h-0 max-h-32 bg-transparent border-0 p-0 text-sm text-zinc-100 placeholder:text-zinc-600 resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
              style={{ fieldSizing: "content" } as React.CSSProperties}
              disabled={loading || isRecording || isTranscribing}
            />
            <div className="flex gap-2 items-center flex-shrink-0">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void startRecording()}
                disabled={loading || isTranscribing}
                className={`h-8 w-8 rounded-xl transition-colors ${
                  isRecording
                    ? "text-red-400 hover:text-red-300 bg-red-950/50"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700"
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isRecording ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon"
                onClick={() => void handleSend()}
                disabled={!input.trim() || loading}
                className="h-8 w-8 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <p className="text-center text-xs text-zinc-700 mt-2">
            Press Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}
