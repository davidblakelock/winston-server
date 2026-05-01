import {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
} from "react";
import { Send, Mic, MicOff, Loader2, Play, Check, Square } from "lucide-react";
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
  newsTopics?: string[];
  pets?: Array<{ name: string; type: string; breed?: string; age?: number }>;
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

// ─── Main component ──────────────────────────────────────────────────────────
interface OnboardingProps {
  onComplete: (companionName?: string) => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  // "voiceSelect" = first screen; "conversation" = chat-based onboarding
  const [step, setStep] = useState<"voiceSelect" | "conversation">("voiceSelect");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [collectedData, setCollectedData] = useState<CollectedData>({});
  const [loading, setLoading] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [voiceAudioRef] = useState<{ current: HTMLAudioElement | null }>({ current: null });
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

  const playAudio = useCallback((base64: string, mimeType = "audio/mpeg") => {
    audioRef.current?.pause();
    const audio = new Audio(`data:${mimeType};base64,${base64}`);
    audioRef.current = audio;
    audio.play().catch(() => {});
  }, []);

  // Merge Claude's per-turn extracted data into the running accumulated collectedData
  const mergeExtracted = useCallback((extracted: Partial<CollectedData>) => {
    setCollectedData((prev) => {
      const next = { ...prev };
      if (extracted.name) next.name = extracted.name;
      if (extracted.city) next.city = extracted.city;
      if (extracted.companionName) next.companionName = extracted.companionName;
      if (extracted.voiceId) next.voiceId = extracted.voiceId;
      if (extracted.people?.length) next.people = [...(prev.people ?? []), ...extracted.people];
      if (extracted.sportsTeams?.length) next.sportsTeams = [...(prev.sportsTeams ?? []), ...extracted.sportsTeams];
      if (extracted.shows?.length) next.shows = [...(prev.shows ?? []), ...extracted.shows];
      if (extracted.restaurants?.length) next.restaurants = [...(prev.restaurants ?? []), ...extracted.restaurants];
      if (extracted.music?.length) next.music = [...(prev.music ?? []), ...extracted.music];
      if (extracted.interests?.length) next.interests = [...(prev.interests ?? []), ...extracted.interests];
      if (extracted.pets?.length) next.pets = [...(prev.pets ?? []), ...extracted.pets];
      return next;
    });
  }, []);

  const sendMessage = useCallback(
    async (text: string, currentHistory: Message[], voiceId: string | null) => {
      setLoading(true);
      try {
        const resp = await fetch(`${API}/api/onboarding/chat`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({
            userMessage: text,
            history: currentHistory.map((m) => ({ role: m.role, content: m.content })),
            voiceId: voiceId ?? undefined,
          }),
        });

        if (!resp.ok) throw new Error("Chat failed");

        const data = await resp.json() as {
          message: string;
          audioBase64?: string;
          mimeType?: string;
          extracted: Partial<CollectedData>;
          onboardingComplete: boolean;
        };

        const companionMsg: Message = {
          id: `companion-${Date.now()}`,
          role: "assistant",
          content: data.message,
        };

        setMessages((prev) => [...prev, companionMsg]);

        if (data.extracted) {
          mergeExtracted(data.extracted);
        }

        if (data.audioBase64) {
          playAudio(data.audioBase64, data.mimeType);
        }

        if (data.onboardingComplete) {
          setCollectedData((prev) => {
            setTimeout(() => onComplete(data.extracted?.companionName ?? prev.companionName ?? undefined), 3500);
            return prev;
          });
        }
      } catch (err) {
        console.error("Onboarding chat error:", err);
      } finally {
        setLoading(false);
      }
    },
    [onComplete, playAudio, mergeExtracted]
  );

  // Companion speaks first — only once conversation mode begins.
  // selectedVoice is already set from the voice selection screen.
  useEffect(() => {
    if (step !== "conversation") return;
    if (initialized.current) return;
    initialized.current = true;
    void sendMessage("", [], selectedVoice);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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
      void sendMessage(text, prev, selectedVoice);
      return [...prev, userMsg];
    });
  }, [input, loading, selectedVoice, sendMessage]);

  const handleTranscript = useCallback(
    (text: string) => {
      setInput(text);
      setTimeout(() => {
        const userMsg: Message = {
          id: `user-${Date.now()}`,
          role: "user",
          content: text,
        };
        setMessages((prev) => {
          void sendMessage(text, prev, selectedVoice);
          return [...prev, userMsg];
        });
        setInput("");
      }, 100);
    },
    [selectedVoice, sendMessage]
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

  // ── Voice preview — ElevenLabs first, browser TTS fallback ────────────────
  const previewVoice = useCallback(async (voiceId: string, voiceName?: string) => {
    if (previewingVoice === voiceId) {
      voiceAudioRef.current?.pause();
      window.speechSynthesis?.cancel();
      setPreviewingVoice(null);
      return;
    }
    // Stop any current preview
    voiceAudioRef.current?.pause();
    window.speechSynthesis?.cancel();
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

  // ── Tap a voice card on the selection screen: preview + mark as selected ──
  const handleVoiceCardTap = useCallback((voice: VoiceOption) => {
    setSelectedVoice(voice.id);
    void previewVoice(voice.id, voice.name);
  }, [previewVoice]);

  // ── Continue from voice selection → start conversation ───────────────────
  const handleContinueVoiceSelect = useCallback(() => {
    if (!selectedVoice) return;
    voiceAudioRef.current?.pause();
    window.speechSynthesis?.cancel();
    setPreviewingVoice(null);
    const voice = voices.find((v) => v.id === selectedVoice);
    // Pre-populate collectedData with voice so the first message is spoken in it
    setCollectedData({ voiceId: selectedVoice, voiceName: voice?.name });
    setStep("conversation");
  }, [selectedVoice, voices, voiceAudioRef]);

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

  // ── Voice selection screen ────────────────────────────────────────────────
  if (step === "voiceSelect") {
    return (
      <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
        {/* Header */}
        <div className="flex-shrink-0 pt-12 pb-6 px-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 mb-4">
            <span className="text-white font-bold text-xl">W</span>
          </div>
          <h1 className="text-2xl font-semibold text-zinc-100 tracking-tight">
            Choose a voice
          </h1>
          <p className="text-sm text-zinc-500 mt-2">
            Tap any card to hear a preview. Select the one that feels right.
          </p>
        </div>

        {/* Voice cards grid */}
        <div
          className="flex-1 overflow-y-auto px-4"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#27272a transparent" }}
        >
          <div className="max-w-md mx-auto grid grid-cols-2 gap-3 pb-4">
            {voices.map((voice) => {
              const isSelected = selectedVoice === voice.id;
              const isPreviewing = previewingVoice === voice.id;
              return (
                <button
                  key={voice.id}
                  onClick={() => handleVoiceCardTap(voice)}
                  className={`relative text-left rounded-2xl p-4 border transition-all duration-200 focus:outline-none ${
                    isSelected
                      ? "bg-indigo-950/60 border-indigo-500 ring-2 ring-indigo-500/40"
                      : "bg-zinc-900 border-zinc-800 hover:border-zinc-600 hover:bg-zinc-800/60"
                  }`}
                >
                  {/* Selected checkmark */}
                  {isSelected && (
                    <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}

                  {/* Playing pulse */}
                  {isPreviewing && (
                    <div className="absolute top-3 right-3 flex items-center gap-0.5">
                      {[0, 150, 300].map((delay) => (
                        <div
                          key={delay}
                          className="w-0.5 h-3 bg-indigo-400 rounded-full animate-bounce"
                          style={{ animationDelay: `${delay}ms` }}
                        />
                      ))}
                    </div>
                  )}

                  <div className="pr-6">
                    <div className="text-sm font-semibold text-zinc-100 leading-tight">
                      {voice.name}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1 leading-snug">
                      {voice.description}
                    </div>
                  </div>

                  {/* Play/stop indicator at bottom */}
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
        </div>

        {/* Error + Continue */}
        <div className="flex-shrink-0 px-4 pb-10 pt-4">
          <div className="max-w-md mx-auto space-y-3">
            {previewError && (
              <p className="text-xs text-amber-400/80 text-center">{previewError}</p>
            )}
            <Button
              onClick={handleContinueVoiceSelect}
              disabled={!selectedVoice}
              className="w-full h-12 text-base font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {selectedVoice
                ? `Continue with ${voices.find((v) => v.id === selectedVoice)?.name ?? "this voice"}`
                : "Select a voice to continue"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Conversation screen ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100">
      {/* ── Skip setup button ── */}
      {messages.length > 0 && (
        <div className="flex-shrink-0 flex justify-end px-6 pt-4">
          <button
            onClick={() => void handleSkip()}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors underline underline-offset-2"
          >
            Skip setup
          </button>
        </div>
      )}

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
