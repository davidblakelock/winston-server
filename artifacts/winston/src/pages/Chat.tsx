import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from "react";
import { Send, Play, Loader2, Disc3, Mic, MicOff, MapPin, Mail, LogOut, Settings, X, Moon } from "lucide-react";
import { useSendMessage, useTextToSpeech } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioBase64?: string;
  mimeType?: string;
  isReminder?: boolean;
  navigationUrl?: string;
  isWinddown?: boolean;
}

interface ReminderEvent {
  id: number;
  userName: string;
  reminderText: string;
  speakText: string;
}

// ─── Browser TTS fallback ────────────────────────────────────────────────────

function useBrowserTTS() {
  const [speaking, setSpeaking] = useState(false);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.92;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.includes("Daniel") ||
          v.name.includes("Samantha") ||
          v.name.includes("Google UK") ||
          v.name.includes("Alex"))
    );
    if (preferred) utterance.voice = preferred;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => { setSpeaking(false); onEnd?.(); };
    utterance.onerror = () => { setSpeaking(false); onEnd?.(); };
    window.speechSynthesis.speak(utterance);
  }, []);

  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { speak, stop, speaking };
}

// ─── Voice recorder with silence detection ───────────────────────────────────

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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, [stopMonitoring]);

  const monitorSilence = useCallback(
    (analyser: AnalyserNode) => {
      const data = new Uint8Array(analyser.fftSize);
      const SILENCE_THRESHOLD = 10;
      const SILENCE_DURATION_MS = 2000;

      const check = () => {
        analyser.getByteTimeDomainData(data);
        const amplitude = Math.max(...data.map((v) => Math.abs(v - 128)));

        if (amplitude < SILENCE_THRESHOLD) {
          if (!silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              stopRecording();
            }, SILENCE_DURATION_MS);
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
    if (recordingState !== "idle") {
      stopRecording();
      return;
    }

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
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/ogg";

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

          const resp = await fetch("/api/transcribe", { method: "POST", body: form });
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
    } catch (err) {
      console.error("Microphone error:", err);
      setRecordingState("idle");
    }
  }, [recordingState, stopRecording, stopMonitoring, monitorSilence, onTranscript]);

  useEffect(() => {
    return () => {
      stopMonitoring();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopMonitoring]);

  return { recordingState, startRecording, stopRecording };
}

// ─── Google auth hook ────────────────────────────────────────────────────────

interface GoogleAuthStatus {
  connected: boolean;
  email: string | null;
  loading: boolean;
}

function useGoogleAuth(): [GoogleAuthStatus, () => Promise<void>] {
  const [status, setStatus] = useState<GoogleAuthStatus>({ connected: false, email: null, loading: true });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status");
      const data = await res.json() as { connected: boolean; email?: string };
      setStatus({ connected: data.connected, email: data.email ?? null, loading: false });
    } catch {
      setStatus({ connected: false, email: null, loading: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return [status, refresh];
}

// ─── Main component ───────────────────────────────────────────────────────────

interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([
    { id: "welcome", role: "assistant", content: "Hello, David. What's on your mind?" },
  ]);
  const [input, setInput] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [winddownSettings, setWinddownSettings] = useState<WinddownSettings>({
    enabled: true,
    scheduledTime: "21:00",
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [localTime, setLocalTime] = useState("21:00");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendMessageMutation = useSendMessage();
  const ttsMutation = useTextToSpeech();
  const browserTTS = useBrowserTTS();
  const [googleAuth, refreshGoogleAuth] = useGoogleAuth();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, sendMessageMutation.isPending]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      window.speechSynthesis.cancel();
    };
  }, []);

  // ── Memory auto-save: save on page close and every 6 user turns ──
  const lastSavedCountRef = useRef(0);

  const saveMemory = useCallback((msgs: Message[]) => {
    const history = msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => m.id !== "welcome")
      .map((m) => ({ role: m.role, content: m.content }));
    if (history.length < 4) return;
    const blob = new Blob([JSON.stringify({ history })], { type: "application/json" });
    navigator.sendBeacon("/api/memory/save", blob);
  }, []);

  // Save on page unload
  useEffect(() => {
    const handleUnload = () => saveMemory(messages);
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [messages, saveMemory]);

  // Auto-save checkpoint every 6 user messages
  useEffect(() => {
    const userCount = messages.filter((m) => m.role === "user").length;
    if (userCount > 0 && userCount % 6 === 0 && userCount !== lastSavedCountRef.current) {
      lastSavedCountRef.current = userCount;
      saveMemory(messages);
    }
  }, [messages, saveMemory]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "google") {
      window.history.replaceState({}, "", "/");
      void refreshGoogleAuth();
      setMessages((prev) => [
        ...prev,
        {
          id: `google-connected-${Date.now()}`,
          role: "assistant",
          content: "Google connected — I now have access to your Gmail and Calendar. Say good morning and I'll give you a full briefing.",
        },
      ]);
    }
    if (params.get("auth") === "error") {
      window.history.replaceState({}, "", "/");
      setMessages((prev) => [
        ...prev,
        { id: `auth-error-${Date.now()}`, role: "assistant", content: "Google sign-in didn't complete. Want to try again?" },
      ]);
    }
  }, [refreshGoogleAuth]);

  const playElevenLabsAudio = useCallback(
    (messageId: string, base64: string, mimeType = "audio/mpeg") => {
      audioRef.current?.pause();
      if (playingId === messageId) { setPlayingId(null); return; }
      const audio = new Audio(`data:${mimeType};base64,${base64}`);
      audio.onended = () => setPlayingId(null);
      audio.onerror = () => setPlayingId(null);
      audioRef.current = audio;
      audio.play().catch(() => setPlayingId(null));
      setPlayingId(messageId);
    },
    [playingId]
  );

  const playBrowserTTS = useCallback(
    (messageId: string, text: string) => {
      if (playingId === messageId && browserTTS.speaking) { browserTTS.stop(); setPlayingId(null); return; }
      audioRef.current?.pause();
      setPlayingId(messageId);
      browserTTS.speak(text, () => setPlayingId(null));
    },
    [playingId, browserTTS]
  );

  const speakReply = useCallback(
    (messageId: string, text: string) => {
      ttsMutation.mutate(
        { data: { text } },
        {
          onSuccess: (ttsData) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, audioBase64: ttsData.audioBase64, mimeType: ttsData.mimeType }
                  : m
              )
            );
            playElevenLabsAudio(messageId, ttsData.audioBase64, ttsData.mimeType);
          },
          onError: () => playBrowserTTS(messageId, text),
        }
      );
    },
    [ttsMutation, playElevenLabsAudio, playBrowserTTS]
  );

  const handlePlay = useCallback(
    (msg: Message) => {
      if (msg.audioBase64) playElevenLabsAudio(msg.id, msg.audioBase64, msg.mimeType);
      else playBrowserTTS(msg.id, msg.content);
    },
    [playElevenLabsAudio, playBrowserTTS]
  );

  const submitText = useCallback(
    (text: string) => {
      if (!text.trim() || sendMessageMutation.isPending) return;

      const userMsg: Message = { id: Date.now().toString(), role: "user", content: text.trim() };
      const historyForApi = messages.map((m) => ({ role: m.role, content: m.content }));

      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      sendMessageMutation.mutate(
        { data: { message: userMsg.content, history: historyForApi } },
        {
          onSuccess: (data) => {
            const assistantMsgId = (Date.now() + 1).toString();
            setMessages((prev) => [
              ...prev,
              {
                id: assistantMsgId,
                role: "assistant",
                content: data.reply,
                navigationUrl: data.navigationUrl,
              },
            ]);
            speakReply(assistantMsgId, data.reply);
            if (data.navigationUrl) {
              window.open(data.navigationUrl, "_blank", "noopener,noreferrer");
            }
          },
        }
      );
    },
    [messages, sendMessageMutation, speakReply]
  );

  const { recordingState, startRecording } = useVoiceRecorder((transcript) => {
    submitText(transcript);
  });

  const fireReminderAlert = useCallback(
    (event: ReminderEvent) => {
      const msgId = `reminder-${event.id}-${Date.now()}`;
      const displayContent = `Hey David — your reminder: ${event.reminderText}`;
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: displayContent, isReminder: true },
      ]);
      speakReply(msgId, event.speakText);
    },
    [speakReply]
  );

  // ── Fetch wind-down settings on mount ──
  useEffect(() => {
    fetch("/api/winddown/settings")
      .then((r) => r.json())
      .then((data: WinddownSettings) => {
        setWinddownSettings(data);
        setLocalTime(data.scheduledTime);
      })
      .catch(() => {});
  }, []);

  // ── Save wind-down settings ──
  const saveWinddownSettings = useCallback(async () => {
    setSettingsSaving(true);
    try {
      const res = await fetch("/api/winddown/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: winddownSettings.enabled, scheduledTime: localTime }),
      });
      const data = await res.json() as WinddownSettings;
      setWinddownSettings(data);
      setLocalTime(data.scheduledTime);
      setShowSettings(false);
    } catch {}
    setSettingsSaving(false);
  }, [winddownSettings.enabled, localTime]);

  // ── SSE: reminders + wind-down start ──
  const fireWinddownStart = useCallback(
    (message: string) => {
      const msgId = `winddown-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: message, isWinddown: true },
      ]);
      speakReply(msgId, message);
    },
    [speakReply]
  );

  useEffect(() => {
    const es = new EventSource("/api/reminders/stream");
    es.addEventListener("reminder", (e) => {
      try { fireReminderAlert(JSON.parse(e.data) as ReminderEvent); } catch {}
    });
    es.addEventListener("winddown-start", (e) => {
      try {
        const data = JSON.parse(e.data) as { message: string };
        fireWinddownStart(data.message);
      } catch {}
    });
    return () => es.close();
  }, [fireReminderAlert, fireWinddownStart]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitText(input); }
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const isRecording = recordingState === "recording";
  const isTranscribing = recordingState === "transcribing";

  return (
    <div className="flex flex-col h-[100dvh] max-w-4xl mx-auto overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/5 py-3 px-4 sm:px-6 flex items-center justify-between bg-background/80 backdrop-blur-sm z-10 sticky top-0">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 border border-primary/20 bg-card">
            <AvatarFallback className="bg-card text-primary font-serif font-medium text-lg">EP</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-xl font-serif font-medium text-foreground tracking-wide">Emma Peel</h1>
            <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase">Always Here</p>
          </div>
        </div>

        <div className="flex items-center gap-2">

        {/* Google auth badge */}
        {!googleAuth.loading && (
          googleAuth.connected ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs text-green-400/80 bg-green-950/30 border border-green-500/20 rounded-full px-3 py-1.5">
                <Mail className="h-3 w-3" />
                <span className="hidden sm:inline">{googleAuth.email}</span>
                <span className="sm:hidden">Gmail</span>
              </div>
              <button
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST" });
                  void refreshGoogleAuth();
                }}
                className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1"
                title="Disconnect Google"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                const popup = window.open(
                  "/api/auth/google",
                  "google-oauth",
                  "width=520,height=640,left=200,top=100,resizable=yes,scrollbars=yes"
                );
                if (!popup) return;

                const onMessage = async (e: MessageEvent) => {
                  if (e.data === "google-connected") {
                    window.removeEventListener("message", onMessage);
                    clearInterval(poll);
                    await refreshGoogleAuth();
                    setMessages((prev) => [
                      ...prev,
                      { id: `google-connected-${Date.now()}`, role: "assistant" as const, content: "Google connected — I now have access to your Gmail and Calendar. Say good morning and I'll give you a full briefing." },
                    ]);
                  } else if (e.data === "google-auth-error") {
                    window.removeEventListener("message", onMessage);
                    clearInterval(poll);
                    setMessages((prev) => [
                      ...prev,
                      { id: `auth-error-${Date.now()}`, role: "assistant" as const, content: "Google sign-in didn't complete. Want to try again?" },
                    ]);
                  }
                };
                window.addEventListener("message", onMessage);

                const poll = setInterval(() => {
                  if (popup.closed) {
                    clearInterval(poll);
                    window.removeEventListener("message", onMessage);
                    void refreshGoogleAuth();
                  }
                }, 1000);
              }}
              className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground bg-card border border-border hover:border-primary/30 rounded-full px-3 py-1.5 transition-all duration-200"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Connect Google
            </button>
          )
        )}

        {/* Settings gear */}
        <button
          onClick={() => setShowSettings(true)}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-white/10 border border-white/10 hover:border-white/20"
          title="Evening wind-down settings"
        >
          <Settings className="h-4 w-4" />
        </button>
        </div>
      </header>

      {/* Wind-down settings modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-card border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Moon className="h-4 w-4 text-primary/70" />
                <h2 className="text-base font-medium text-foreground">Evening Wind-Down</h2>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
              Each evening at your chosen time, Emma will check in — asking about your day, capturing any notes for tomorrow, and inviting a memory for Olivia's book.
            </p>

            {/* Enable toggle */}
            <div className="flex items-center justify-between mb-5">
              <span className="text-sm text-foreground">Enable evening wind-down</span>
              <button
                onClick={() => setWinddownSettings((s) => ({ ...s, enabled: !s.enabled }))}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
                  winddownSettings.enabled ? "bg-primary" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    winddownSettings.enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Time picker */}
            <div className="mb-6">
              <label className="text-sm text-foreground block mb-2">Start time (Central Time)</label>
              <input
                type="time"
                value={localTime}
                onChange={(e) => setLocalTime(e.target.value)}
                disabled={!winddownSettings.enabled}
                className="w-full bg-input border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-40 transition-opacity"
              />
            </div>

            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowSettings(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={() => void saveWinddownSettings()}
                disabled={settingsSaving}
              >
                {settingsSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-6 pb-24 sm:pb-32 space-y-8">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
            data-testid={`message-${msg.role}`}
          >
            <div
              className={`max-w-[85%] sm:max-w-[75%] rounded-2xl p-4 sm:p-5 shadow-sm text-[15px] leading-relaxed transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${
                msg.role === "user"
                  ? "bg-secondary text-secondary-foreground rounded-br-sm"
                  : msg.isReminder
                  ? "bg-primary/10 border border-primary/30 text-card-foreground rounded-bl-sm"
                  : msg.isWinddown
                  ? "bg-indigo-950/40 border border-indigo-500/20 text-card-foreground rounded-bl-sm"
                  : msg.navigationUrl
                  ? "bg-blue-950/40 border border-blue-500/20 text-card-foreground rounded-bl-sm"
                  : "bg-card border border-white/5 text-card-foreground rounded-bl-sm"
              }`}
            >
              {msg.isReminder && (
                <p className="text-[11px] font-semibold tracking-widest uppercase text-primary/70 mb-2">Reminder</p>
              )}
              {msg.isWinddown && (
                <p className="text-[11px] font-semibold tracking-widest uppercase text-indigo-400/70 mb-2 flex items-center gap-1.5">
                  <Moon className="h-3 w-3" />
                  Evening Wind-Down
                </p>
              )}
              {msg.navigationUrl && (
                <p className="text-[11px] font-semibold tracking-widest uppercase text-blue-400/80 mb-2 flex items-center gap-1.5">
                  <MapPin className="h-3 w-3" />
                  Navigation
                </p>
              )}
              <div className="whitespace-pre-wrap font-sans">{msg.content}</div>

              {msg.role === "assistant" && (
                <div className="mt-4 pt-3 border-t border-white/5 flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 rounded-full transition-colors ${
                      playingId === msg.id
                        ? "bg-primary/20 text-primary hover:bg-primary/30"
                        : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                    }`}
                    onClick={() => handlePlay(msg)}
                    data-testid={`button-play-audio-${msg.id}`}
                  >
                    {playingId === msg.id ? (
                      <Disc3 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 fill-current ml-0.5" />
                    )}
                  </Button>
                  <span className="text-xs text-muted-foreground/70 font-medium">
                    {playingId === msg.id ? "Playing..." : "Listen"}
                  </span>
                  {msg.navigationUrl && (
                    <a
                      href={msg.navigationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      Open in Maps
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {sendMessageMutation.isPending && (
          <div className="flex flex-col items-start animate-in fade-in">
            <div className="max-w-[85%] rounded-2xl p-5 bg-card border border-white/5 rounded-bl-sm flex items-center gap-1.5 h-[60px]">
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce" />
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 p-4 sm:p-6 bg-gradient-to-t from-background via-background to-transparent pt-12 absolute bottom-0 w-full max-w-4xl">
        {/* Recording indicator banner */}
        {(isRecording || isTranscribing) && (
          <div className="mb-3 flex items-center justify-center gap-2 animate-in fade-in">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                isRecording ? "bg-red-500 animate-pulse" : "bg-amber-400"
              }`}
            />
            <span className="text-xs font-medium text-muted-foreground tracking-wide">
              {isRecording ? "Listening…" : "Transcribing…"}
            </span>
          </div>
        )}

        <div className="relative group">
          <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent blur opacity-50 group-focus-within:opacity-100 transition-opacity duration-500" />
          <div className="relative flex items-end gap-2 bg-input border border-border rounded-2xl p-2 sm:p-3 shadow-lg focus-within:ring-1 focus-within:ring-primary/30 transition-all duration-300">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={isRecording ? "Listening…" : "Share your thoughts..."}
              className="min-h-[44px] max-h-[200px] border-0 focus-visible:ring-0 resize-none bg-transparent py-3 px-3 text-[15px] placeholder:text-muted-foreground/60 scrollbar-none font-sans"
              rows={1}
              data-testid="input-message"
            />

            {/* Microphone button */}
            <Button
              type="button"
              onClick={startRecording}
              disabled={isTranscribing || sendMessageMutation.isPending}
              size="icon"
              className={`h-11 w-11 rounded-xl shrink-0 mb-0.5 transition-all duration-300 ${
                isRecording
                  ? "bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/40 animate-pulse"
                  : isTranscribing
                  ? "bg-amber-500/20 text-amber-400"
                  : "bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-card/80"
              }`}
              aria-label={isRecording ? "Stop recording" : "Start voice input"}
              data-testid="button-mic"
            >
              {isTranscribing ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : isRecording ? (
                <MicOff className="h-5 w-5" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </Button>

            {/* Send button */}
            <Button
              onClick={() => submitText(input)}
              disabled={!input.trim() || sendMessageMutation.isPending}
              size="icon"
              className="h-11 w-11 rounded-xl shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-300 shadow-md shadow-primary/20 mb-0.5 mr-0.5"
              data-testid="button-send"
            >
              {sendMessageMutation.isPending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5 ml-0.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
