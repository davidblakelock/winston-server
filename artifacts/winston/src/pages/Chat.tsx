import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from "react";
import { Send, Play, Loader2, Disc3, Mic, MicOff, MapPin, Mail, LogOut, Settings, X, Moon, Bell, BellOff, Clock, ChevronDown, ChevronUp, HelpCircle, Check, List } from "lucide-react";
import { useLocation } from "wouter";
import { useTextToSpeech } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useNotifications, isNotificationsSupported } from "@/hooks/useNotifications";
import { EmergencyOverlay } from "@/components/EmergencyOverlay";
import SettingsPanel from "@/components/SettingsPanel";
import { WeatherCard } from "@/components/WeatherCard";

const EMERGENCY_REGEX = /\b(ms\.?\s*peel\s+(i\s+(need|am|have|fell|can.t|cannot)|call\s+911|help\s+me)|call\s+911|i.ve\s+fallen|i\s+fell\s+(down|and)|i.m\s+not\s+(feeling|ok)|i\s+think\s+i.m\s+(having|going)|chest\s+pain|can.t\s+breathe|emergency|i\s+need\s+(help|an?\s+ambulance)|heart\s+attack|stroke|i.ve\s+been\s+(hurt|injured))\b/i;

// ─── Client-side navigation detection ────────────────────────────────────────
// We detect navigation intent HERE (in the click handler) so window.open() is
// called within the user-gesture context — browser popup blockers won't fire.

const NAV_PHRASE_REGEX = /\b(take\s+me\s+to|directions?\s+to|navigate\s+to|get\s+me\s+to|how\s+do\s+i\s+get\s+to|maps?\s+to|open\s+maps?\s+(for|to)|i\s+need\s+to\s+go\s+to|i\s+need\s+directions?\s+to|i\s+want\s+to\s+go\s+to|can\s+you\s+take\s+me\s+to|take\s+me|get\s+directions?\s+to|show\s+me\s+how\s+to\s+get\s+to)\b/i;

interface SavedPlace {
  name: string;
  address: string;
  keywords: string[];
}

const DEFAULT_PLACES: SavedPlace[] = [
  { name: "home", address: "6345 Diamond Head Circle Dallas Texas 75225", keywords: ["home", "my place", "my condo", "my house"] },
  { name: "Doctor Bonnet", address: "403 West Campbell Road Richardson Texas", keywords: ["doctor", "doc", "doctor bonnet", "bonnet", "physician", "my doctor", "the doctor"] },
  { name: "Moody YMCA", address: "6000 Preston Road Dallas Texas 75205", keywords: ["moody", "moody ymca", "moody y"] },
  { name: "Semones YMCA", address: "4332 Northaven Road Dallas Texas 75229", keywords: ["semones", "semones ymca", "semones y", "the gym", "gym", "the y", "ymca"] },
];

interface DetectedNav {
  url: string;
  name: string;
}

function detectNav(text: string, places: SavedPlace[]): DetectedNav | null {
  if (!NAV_PHRASE_REGEX.test(text)) return null;
  const lower = text.toLowerCase();
  for (const place of places) {
    if (place.keywords.some((kw) => lower.includes(kw))) {
      return {
        url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place.address)}`,
        name: place.name,
      };
    }
  }
  return null;
}

function destinationFromUrl(url: string): string {
  try {
    return new URLSearchParams(new URL(url).search).get("destination") ?? "your destination";
  } catch {
    return "your destination";
  }
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  audioBase64?: string;
  mimeType?: string;
  isReminder?: boolean;
  navigationUrl?: string;
  navigationDestination?: string;
  isWinddown?: boolean;
  isMorningBriefing?: boolean;
}

// Detect morning briefing messages when loading from DB (flag is not persisted).
// Morning briefings always start with "Good morning" and contain temperature data.
function withMorningFlag(msg: Message): Message {
  if (msg.role === "assistant" && !msg.isMorningBriefing) {
    const lower = msg.content.toLowerCase();
    const isBriefing =
      (lower.startsWith("good morning") && msg.content.length > 400) ||
      lower.startsWith("your morning briefing isn't ready yet");
    if (isBriefing) return { ...msg, isMorningBriefing: true };
  }
  return msg;
}

interface ReminderEvent {
  id: number | string;
  userName: string;
  reminderText: string;
  speakText: string;
  isCalendarAlert?: boolean;
  askForAddress?: boolean;
  eventId?: string;
  eventSummary?: string;
}

interface UpcomingReminder {
  id: number;
  reminder_text: string;
  fire_at: string;
  status: string;
  recurring: string | null;
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

const CHAT_BASE = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

function useGoogleAuth(): [GoogleAuthStatus, () => Promise<void>] {
  const [status, setStatus] = useState<GoogleAuthStatus>({ connected: false, email: null, loading: true });

  const refresh = useCallback(async () => {
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/auth/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json() as { connected: boolean; email?: string };
      setStatus({ connected: data.connected, email: data.email ?? null, loading: false });
    } catch {
      setStatus({ connected: false, email: null, loading: false });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return [status, refresh];
}

// ─── User avatar ──────────────────────────────────────────────────────────────
// Priority: 1) custom base64 from DB  2) Google profile photo  3) initials

function UserAvatar({
  avatarBase64,
  googlePicture,
  fullName,
  userName,
}: {
  avatarBase64?: string | null;
  googlePicture?: string;
  fullName?: string;
  userName?: string;
}) {
  const [googleFailed, setGoogleFailed] = useState(false);

  const initials = (() => {
    const name = fullName || userName || "";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return "?";
  })();

  const circleStyle: React.CSSProperties = {
    width: 44, height: 44, borderRadius: "50%", objectFit: "cover",
    flexShrink: 0, border: "2px solid rgba(255,255,255,0.15)",
  };

  // Priority 1: custom avatar stored in DB as base64 data URL
  if (avatarBase64) {
    console.log("[AVATAR] Displaying custom base64 avatar");
    return (
      <img
        src={avatarBase64}
        alt="Profile"
        style={circleStyle}
        onError={() => console.warn("[AVATAR] Base64 avatar failed to render")}
      />
    );
  }

  // Priority 2: Google profile photo
  if (googlePicture && !googleFailed) {
    return (
      <img
        src={googlePicture}
        alt="Profile"
        referrerPolicy="no-referrer"
        onError={() => { console.warn("[AVATAR] Google photo failed, falling back to initials"); setGoogleFailed(true); }}
        onLoad={() => console.log("[AVATAR] Google photo loaded")}
        style={circleStyle}
      />
    );
  }

  // Priority 3: initials
  return (
    <div style={{
      width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
      border: "2px solid rgba(217,119,6,0.4)",
    }}>
      <span style={{ color: "white", fontSize: "14px", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.02em" }}>{initials}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

interface ChatProps {
  onSignOut?: () => void;
  companionName?: string | null;
  voiceId?: string | null;
  photoUrl?: string | null;
  avatarBase64?: string | null;
  userPicture?: string;
  userFullName?: string;
  userName?: string;
}

export default function Chat({ onSignOut, companionName: companionNameProp, voiceId: voiceIdProp, photoUrl: photoUrlProp, avatarBase64: avatarBase64Prop, userPicture, userFullName, userName }: ChatProps) {
  const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

  // Resolved name: prop → localStorage cache → null (fetched below)
  // Use || not ?? so empty string from DB falls through to localStorage cache
  const [resolvedCompanionName, setResolvedCompanionName] = useState<string | null>(
    () => companionNameProp || localStorage.getItem("winston_companion_name")
  );

  // Sync prop changes into resolved state — only when prop is non-empty
  useEffect(() => {
    if (companionNameProp) {
      setResolvedCompanionName(companionNameProp);
      localStorage.setItem("winston_companion_name", companionNameProp);
    }
  }, [companionNameProp]);

  // Self-fetch fallback: if neither prop nor cache provided the name, go get it
  useEffect(() => {
    if (resolvedCompanionName) return;
    const token = localStorage.getItem("winston_session_token") ?? "";
    fetch(`${baseUrl}/api/onboarding/status`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data: { profile?: { companionName?: string | null } | null }) => {
        const name = data.profile?.companionName;
        if (name) {
          setResolvedCompanionName(name);
          localStorage.setItem("winston_companion_name", name);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const companionNameFinal = resolvedCompanionName ?? null;
  const companionName = companionNameFinal || "your companion";

  // Keep browser tab title in sync with the companion's name
  useEffect(() => {
    document.title = companionNameFinal || "Winston";
    return () => { document.title = "Winston"; };
  }, [companionNameFinal]);

  // ── Voice ID — prop → localStorage → null ────────────────────────────────
  const [resolvedVoiceId, setResolvedVoiceId] = useState<string | null>(
    () => voiceIdProp ?? localStorage.getItem("winston_voice_id")
  );
  useEffect(() => { if (voiceIdProp) { setResolvedVoiceId(voiceIdProp); localStorage.setItem("winston_voice_id", voiceIdProp); } }, [voiceIdProp]);

  // ── Custom photo URL ──────────────────────────────────────────────────────
  const [customAvatarBase64, setCustomAvatarBase64] = useState<string | null>(avatarBase64Prop ?? null);
  useEffect(() => { setCustomAvatarBase64(avatarBase64Prop ?? null); }, [avatarBase64Prop]);

  // ── Play TTS audio from settings confirmation ─────────────────────────────
  const settingsAudioRef = useRef<HTMLAudioElement | null>(null);
  const playSettingsAudio = useCallback((audioBase64: string, mimeType: string) => {
    settingsAudioRef.current?.pause();
    const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
    settingsAudioRef.current = audio;
    void audio.play().catch(() => {});
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [pendingNotification, setPendingNotification] = useState<{
    type: "morning" | "reminder" | "concert-alert";
    text?: string;
    id?: number;
    companionMessage?: string;
  } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const type = params.get("notification");
    if (type === "morning") return { type: "morning" };
    if (type === "reminder") {
      const text = params.get("text");
      const rawId = params.get("reminderId");
      const id = rawId ? parseInt(rawId, 10) : undefined;
      return text ? { type: "reminder", text, id: id && !isNaN(id) ? id : undefined } : null;
    }
    return null;
  });
  const [input, setInput] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [, setLocation] = useLocation();
  const [upcomingReminders, setUpcomingReminders] = useState<UpcomingReminder[]>([]);
  const [showRemindersPanel, setShowRemindersPanel] = useState(false);
  const notif = useNotifications();
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(
    () => localStorage.getItem("notif-banner-dismissed") === "1"
  );
  const showNotifBanner =
    isNotificationsSupported() &&
    notif.permission === "default" &&
    !notifBannerDismissed;
  const [winddownSettings, setWinddownSettings] = useState<WinddownSettings>({
    enabled: true,
    scheduledTime: "21:00",
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [localTime, setLocalTime] = useState("21:00");
  const [showEmergency, setShowEmergency] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"online" | "reconnecting" | "offline">("online");
  const [navBannerVisible, setNavBannerVisible] = useState(false);
  const navBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const greetedRef = useRef(false);
  const savedPlacesRef = useRef<SavedPlace[]>(DEFAULT_PLACES);
  const ownedMessageIds = useRef<Set<string>>(new Set());
  const pendingSyncQueue = useRef<Array<{ id: string; role: "user" | "assistant"; content: string }>>([]);

  const ttsMutation = useTextToSpeech();
  const browserTTS = useBrowserTTS();
  const [googleAuth, refreshGoogleAuth] = useGoogleAuth();
  const [isStreaming, setIsStreaming] = useState(false);

  const triggerNavBanner = useCallback(() => {
    setNavBannerVisible(true);
    if (navBannerTimerRef.current) clearTimeout(navBannerTimerRef.current);
    navBannerTimerRef.current = setTimeout(() => setNavBannerVisible(false), 60_000);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isStreaming]);

  // ── Streaming chat — reads SSE from /api/chat and streams text into a message bubble ──
  const streamChat = useCallback(async (
    message: string,
    history: { role: string; content: string }[],
    targetMsgId: string,
    onComplete: (fullText: string, navigationUrl?: string, serverMsgId?: string) => void,
    onError: (errReply?: string) => void,
  ) => {
    const token = localStorage.getItem("winston_session_token");
    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    setIsStreaming(true);
    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message,
          history,
          deviceId: localStorage.getItem("winston_device_id"),
        }),
      });

      if (!response.ok || !response.body) {
        onError();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let fullText = "";
      let navUrl: string | undefined;
      let serverMsgId: string | undefined;
      let finished = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const trimmed = line.slice(6).trim();
          if (!trimmed) continue;
          let data: Record<string, unknown>;
          try { data = JSON.parse(trimmed); } catch { continue; }

          if (data.text) {
            fullText += data.text as string;
            setMessages((prev) =>
              prev.map((m) => m.id === targetMsgId ? { ...m, content: fullText } : m)
            );
          }
          if (data.done) {
            navUrl = data.navigationUrl as string | undefined;
            serverMsgId = data.messageId as string | undefined;
            finished = true;
            if (data.isMorningBriefing) {
              setMessages((prev) =>
                prev.map((m) => m.id === targetMsgId ? { ...m, isMorningBriefing: true } : m)
              );
            }
          }
          if (data.error) {
            const errReply = (data.reply as string) || "Something went wrong. Please try again.";
            onError(errReply);
            return;
          }
        }
      }

      if (finished || fullText) {
        onComplete(fullText, navUrl, serverMsgId);
      } else {
        onError();
      }
    } catch {
      onError();
    } finally {
      setIsStreaming(false);
    }
  }, []);

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
      console.log("[AUDIO] playElevenLabsAudio called — msgId:", messageId, "mimeType:", mimeType, "base64 length:", base64?.length ?? 0);
      audioRef.current?.pause();
      if (playingId === messageId) { console.log("[AUDIO] toggling off — same messageId, stopping"); setPlayingId(null); return; }
      console.log("[AUDIO] creating Audio object with data URI, mimeType:", mimeType);
      const audio = new Audio(`data:${mimeType};base64,${base64}`);
      audio.onended = () => { console.log("[AUDIO] audio.onended fired"); setPlayingId(null); };
      audio.onerror = (e) => {
        console.warn("[AUDIO] playElevenLabsAudio onerror:", e);
        setPlayingId(null);
      };
      audioRef.current = audio;
      console.log("[AUDIO] calling audio.play()");
      audio.play().then(() => {
        console.log("[AUDIO] audio.play() resolved — playback started");
      }).catch((err) => {
        console.warn("[AUDIO] play() blocked or failed:", err);
        setPlayingId(null);
      });
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
      console.log("[SPEAK] speakReply called, msgId:", messageId, "text:", text);
      ttsMutation.mutate(
        { data: { text } },
        {
          onSuccess: (ttsData) => {
            console.log("[SPEAK] TTS onSuccess — audioBase64 length:", ttsData?.audioBase64?.length ?? 0, "mimeType:", ttsData?.mimeType);
            if (!ttsData?.audioBase64) { console.warn("[SPEAK] onSuccess fired but audioBase64 is empty/null — no audio to play"); return; }
            setMessages((prev) =>
              prev.map((m) =>
                m.id === messageId
                  ? { ...m, audioBase64: ttsData.audioBase64, mimeType: ttsData.mimeType }
                  : m
              )
            );
            console.log("[SPEAK] calling playElevenLabsAudio for msgId:", messageId);
            playElevenLabsAudio(messageId, ttsData.audioBase64, ttsData.mimeType);
          },
          onError: (err) => {
            console.warn("[SPEAK] ElevenLabs TTS failed — no audio will play. Error:", err);
          },
        }
      );
    },
    [ttsMutation, playElevenLabsAudio]
  );

  const handlePlay = useCallback(
    (msg: Message) => {
      if (msg.audioBase64) playElevenLabsAudio(msg.id, msg.audioBase64, msg.mimeType);
      else speakReply(msg.id, msg.content);
    },
    [playElevenLabsAudio, speakReply]
  );

  // ── Session validity check (Bug 6) ───────────────────────────────────────
  // Check on startup if the session token is still valid. If it has expired,
  // clear credentials and redirect to login so the user re-authenticates cleanly.
  useEffect(() => {
    const token = localStorage.getItem("winston_session_token");
    if (!token) return;
    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) {
          // Session expired — clear credentials and redirect to login
          localStorage.removeItem("winston_session_token");
          localStorage.removeItem("winston_user_name");
          localStorage.removeItem("winston_companion_name");
          localStorage.removeItem("winston_user_picture");
          localStorage.removeItem("winston_voice_id");
          window.location.href = (import.meta.env.BASE_URL as string) || "/";
        }
      })
      .catch(() => {}); // network error — don't log out, just ignore
  }, []);

  // ── Keep-alive ping + connection status (Bug 1) ───────────────────────────
  // Pings /api/health every 5 minutes to keep the server connection warm and
  // detect if the app has gone stale. Retries every 30s if the server is down,
  // and shows a subtle reconnecting indicator in the header.
  useEffect(() => {
    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setInterval> | null = null;

    const ping = async (): Promise<boolean> => {
      try {
        const r = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
        return r.ok;
      } catch {
        return false;
      }
    };

    const startReconnecting = () => {
      setConnectionStatus("reconnecting");
      reconnectTimer = setInterval(async () => {
        const ok = await ping();
        if (ok) {
          setConnectionStatus("online");
          if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
        }
      }, 30_000);
    };

    // Single combined ping — checks connectivity AND logs health in one request
    const runPing = async () => {
      try {
        const r = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
        if (r.ok) {
          const data = await r.json() as { db: string; uptime: number; dbLatencyMs: number };
          console.log(`[HEALTH] db=${data.db} uptime=${data.uptime}s dbLatency=${data.dbLatencyMs}ms`);
          setConnectionStatus("online");
        } else {
          setConnectionStatus("reconnecting");
          startReconnecting();
        }
      } catch {
        setConnectionStatus("reconnecting");
        startReconnecting();
      }
    };

    // Ping once on mount, then every 5 minutes
    void runPing();
    keepAliveTimer = setInterval(() => { void runPing(); }, 5 * 60_000);

    return () => {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (reconnectTimer) clearInterval(reconnectTimer);
    };
  }, []);

  // ── Fetch saved navigation places from API ────────────────────────────────
  // Pre-loaded so detectNavUrl() works immediately when the user hits Send.
  useEffect(() => {
    const token = localStorage.getItem("winston_session_token");
    if (!token) return;
    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
    fetch(`${baseUrl}/api/navigation/places`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? (r.json() as Promise<{ places: SavedPlace[] }>) : null)
      .then((data) => { if (data?.places?.length) savedPlacesRef.current = data.places; })
      .catch(() => {});
  }, []);

  // ── Load message history from DB, then greet if no history ─────────────
  useEffect(() => {
    if (greetedRef.current) return;
    greetedRef.current = true;

    const token = localStorage.getItem("winston_session_token");
    if (!token) { setMessagesLoaded(true); return; }

    const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

    fetch(`${baseUrl}/api/messages?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ messages: Message[] }>) : { messages: [] }))
      .then((data) => {
        const existing = data.messages ?? [];
        setMessagesLoaded(true);

        if (existing.length > 0) {
          // Restore previous conversation — no greeting needed.
          // Re-apply morning briefing flag since it is not persisted in the DB.
          setMessages(existing.map(withMorningFlag));
          return;
        }

        // Fresh session — ask Emma to greet (streamed)
        const greetingId = `greeting-${Date.now()}`;
        setMessages([{ id: greetingId, role: "assistant", content: "…" }]);

        streamChat(
          "hello",
          [],
          greetingId,
          (reply) => {
            fetch(`${baseUrl}/api/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                messages: [{ role: "assistant", content: reply }],
                deviceId: localStorage.getItem("winston_device_id"),
              }),
            }).catch(() => {});
            setTimeout(() => speakReply(greetingId, reply), 400);
          },
          () => setMessages([]),
        );
      })
      .catch(() => {
        setMessagesLoaded(true);
        setMessages([]);
      });
  }, [speakReply, streamChat]);

  const submitText = useCallback(
    (text: string) => {
      if (!text.trim() || isStreaming) return;

      if (EMERGENCY_REGEX.test(text.trim())) {
        setShowEmergency(true);
      }

      // ── Navigation: detect & open HERE (user-gesture context) ──────────────
      // window.open() MUST be called synchronously in the click handler.
      // Calling it later (inside async callbacks) gets blocked by popup blockers.
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      const detectedNav = detectNav(text.trim(), savedPlacesRef.current);
      const immediateNavUrl = detectedNav?.url ?? null;
      if (detectedNav) {
        if (!isMobile) {
          // Desktop: open Maps in a new tab — Winston stays open in the original tab
          window.open(detectedNav.url, "_blank", "noopener,noreferrer");
        }
        // Both desktop and mobile: show the return banner
        triggerNavBanner();
      }

      const userMsg: Message = { id: Date.now().toString(), role: "user", content: text.trim() };
      const historyForApi = messages.slice(-30).map((m) => ({ role: m.role, content: m.content }));
      const assistantMsgId = (Date.now() + 1).toString();

      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantMsgId, role: "assistant", content: "…" },
      ]);
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      // Bug 5: Warm error + auto-retry. First failure shows a gentle message and
      // retries automatically once. Second failure shows a final message.
      let chatRetried = false;

      const onComplete = (reply: string, navUrl?: string, serverMsgId?: string) => {
        if (serverMsgId) ownedMessageIds.current.add(serverMsgId);
        speakReply(assistantMsgId, reply);
        const resolvedNavUrl = navUrl ?? immediateNavUrl ?? undefined;
        if (resolvedNavUrl) {
          const resolvedDest = detectedNav?.name ?? destinationFromUrl(resolvedNavUrl);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, navigationUrl: resolvedNavUrl, navigationDestination: resolvedDest } : m
            )
          );
        }
        const token = localStorage.getItem("winston_session_token");
        if (token) {
          const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
          fetch(`${baseUrl}/api/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              messages: [
                { role: "user", content: userMsg.content },
                { role: "assistant", content: reply },
              ],
              deviceId: localStorage.getItem("winston_device_id"),
            }),
          }).catch(() => {});
        }
      };

      const onError = (errReply?: string) => {
        if (errReply) {
          // Backend sent a specific error (e.g., Claude overload) — show it directly
          setMessages((prev) =>
            prev.map((m) => m.id === assistantMsgId ? { ...m, content: errReply } : m)
          );
          return;
        }
        if (!chatRetried) {
          // First failure: warm message + auto-retry in 2 seconds
          chatRetried = true;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: "I seem to be having a moment — give me just a second…" }
                : m
            )
          );
          setTimeout(() => {
            streamChat(userMsg.content, historyForApi, assistantMsgId, onComplete, onError);
          }, 2000);
        } else {
          // Second failure: final error message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: "I'm having some technical difficulties right now. Everything should be back to normal shortly." }
                : m
            )
          );
        }
      };

      streamChat(
        userMsg.content,
        historyForApi,
        assistantMsgId,
        onComplete,
        onError,
      );
    },
    [messages, isStreaming, streamChat, speakReply]
  );

  const { recordingState, startRecording } = useVoiceRecorder((transcript) => {
    submitText(transcript);
  });

  // Handle deep-link navigation from tapped push notifications
  useEffect(() => {
    if (!messagesLoaded || !pendingNotification) return;
    const notif = pendingNotification;
    setPendingNotification(null);
    // Clean up the URL so it doesn't re-trigger on refresh
    window.history.replaceState({}, "", window.location.pathname);

    if (notif.type === "morning") {
      // Auto-trigger "good morning" so the companion delivers the full briefing
      setTimeout(() => submitText("good morning"), 600);
    } else if (notif.type === "concert-alert" && notif.companionMessage) {
      // Display the companion's concert message and speak it
      const msgId = `concert-alert-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          role: "assistant" as const,
          content: notif.companionMessage!,
        },
      ]);
      speakReply(msgId, notif.companionMessage!);
    } else if (notif.type === "reminder" && notif.text) {
      // Dedup: if SSE or push already fired this reminder, don't show it twice
      if (notif.id != null && spokenReminderIds.current.has(notif.id)) {
        console.log("[REMINDER] pendingNotification: already shown via SSE/push — skipping id:", notif.id);
        return;
      }
      if (notif.id != null) {
        spokenReminderIds.current.add(notif.id);
        // Remove from the upcoming reminders pill — this path (notification tap → IDB →
        // pendingNotification) was the only one that forgot to clear the pill.
        setUpcomingReminders((prev) => prev.filter((r) => r.id !== notif.id));
      }
      const greeting = companionName ? `Hey — your reminder` : "Your reminder";
      const msgId = `notif-reminder-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          role: "assistant" as const,
          content: `${greeting}: ${notif.text}`,
          isReminder: true,
        },
      ]);
      speakReply(msgId, `${greeting}: ${notif.text}`);
    }
  }, [messagesLoaded, pendingNotification, submitText, speakReply, companionName]);

  // Listen for NOTIFICATION_TAP from the service worker.
  // Fired when David taps a push notification and the app is already open.
  // App.tsx has already called navigate('/') at this point.
  // We read the pending reminder/check-in from IDB here so Chat.tsx can
  // display and speak the message immediately without any extra steps.
  // spokenReminderIds guards against double-speak when REMINDER_PUSH already
  // handled a real reminder in the foreground.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== "NOTIFICATION_TAP") return;
      console.log("[CHAT] NOTIFICATION_TAP received — reading IDB for pending message");
      try {
        const req = indexedDB.open("winston-sw", 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("pending")) return;
          const tx = db.transaction("pending", "readwrite");
          const store = tx.objectStore("pending");
          const getReq = store.get("reminder");
          getReq.onsuccess = () => {
            const pending = getReq.result as { reminderText?: string; reminderId?: number; notificationType?: string; companionMessage?: string } | undefined;
            if (!pending) return;
            store.delete("reminder"); // consume so it never fires twice

            const notifType = pending.notificationType;
            const compMsg = pending.companionMessage;

            // Concert alert: display companion's crafted message
            if (notifType === "concert-alert" && compMsg) {
              console.log("[CHAT] NOTIFICATION_TAP: concert-alert from IDB");
              setPendingNotification((prev) => prev ?? { type: "concert-alert", companionMessage: compMsg });
              return;
            }

            // Reminder: use stored text
            const text = pending.reminderText;
            if (!text) return;
            const rid = typeof pending.reminderId === "number" ? pending.reminderId : null;
            // If this specific reminder was already spoken via REMINDER_PUSH, skip it
            if (rid != null && spokenReminderIds.current.has(rid)) {
              console.log("[CHAT] NOTIFICATION_TAP: reminderId", rid, "already spoken — skipping");
              return;
            }
            console.log("[CHAT] NOTIFICATION_TAP: setting pending notification from IDB — text:", text);
            setPendingNotification((prev) => prev ?? { type: "reminder", text, id: rid ?? undefined });
          };
        };
      } catch { /* IDB unavailable on this device */ }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  // spokenReminderIds is a ref — always current, no need in deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // IndexedDB fallback — reads any reminder the service worker stored before calling
  // clients.openWindow().  Runs once on mount; only sets pendingNotification if the
  // URL-param initialiser didn't already provide one (functional update pattern).
  useEffect(() => {
    try {
      const req = indexedDB.open("winston-sw", 1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("pending")) return;
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        const getReq = store.get("reminder");
        getReq.onsuccess = () => {
          const pending = getReq.result as { reminderText?: string; notificationType?: string; companionMessage?: string } | undefined;
          if (!pending) return;
          store.delete("reminder"); // consume immediately so it never fires twice

          // Concert alert stored from a previous notification tap
          if (pending.notificationType === "concert-alert" && pending.companionMessage) {
            setPendingNotification((prev) => prev ?? { type: "concert-alert", companionMessage: pending.companionMessage });
            return;
          }
          // Standard reminder
          if (pending.reminderText) {
            const text = pending.reminderText;
            // Only set if URL params didn't already give us a pendingNotification
            setPendingNotification((prev) => prev ?? { type: "reminder", text });
          }
        };
      };
    } catch { /* IDB unavailable in this browser — ignore */ }
  }, []);

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

  // ── Load upcoming (pending) reminders on mount ────────────────────────────
  useEffect(() => {
    fetch(`${CHAT_BASE}/api/reminders/list`)
      .then((r) => (r.ok ? (r.json() as Promise<UpcomingReminder[]>) : []))
      .then((data) => setUpcomingReminders(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

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

  // Tracks reminder IDs already spoken on this device so SSE and polling
  // never double-speak the same reminder within the same session.
  const spokenReminderIds = useRef<Set<number>>(new Set());

  const fireReminderAlert = useCallback(
    (event: ReminderEvent) => {
      console.log("FIRE: fireReminderAlert called for id", event.id);
      console.log("[REMINDER] fireReminderAlert called:", event);

      // Guard: skip if already spoken this session (e.g. both SSE and poll fired)
      const idKey = String(event.id);
      if (spokenReminderIds.current.has(idKey as unknown as number)) {
        console.log("[REMINDER] Already spoken this session, skipping:", event.id);
        return;
      }
      spokenReminderIds.current.add(idKey as unknown as number);

      // Remove from upcoming reminders panel since it's now firing
      setUpcomingReminders((prev) => prev.filter((r) => String(r.id) !== idKey));

      const msgId = `reminder-${event.id}-${Date.now()}`;

      let speakText: string;
      let displayContent: string;

      if (event.isCalendarAlert) {
        // Calendar alerts carry their own fully-formed message — use it directly
        speakText = event.speakText || event.reminderText;
        displayContent = event.reminderText;
      } else {
        speakText = `Your reminder: ${event.reminderText}.`;
        displayContent = `Your reminder: ${event.reminderText}`;
      }

      setMessages((prev) => [
        ...prev,
        { id: msgId, role: "assistant", content: displayContent, isReminder: true },
      ]);

      console.log("[REMINDER] Calling speakReply with:", speakText);
      speakReply(msgId, speakText);

      // Only acknowledge DB-backed reminders (numeric IDs)
      const numericId = typeof event.id === "number" ? event.id : parseInt(String(event.id), 10);
      if (!isNaN(numericId)) {
        console.log(`[ACKNOWLEDGE] Acknowledging id=${numericId}`);
        fetch(`${CHAT_BASE}/api/reminders/${numericId}/acknowledge`, { method: "POST" })
          .then(async (r) => {
            if (!r.ok) {
              const body = await r.text().catch(() => "");
              console.error(`[ACKNOWLEDGE] Server error for id=${numericId} status=${r.status}:`, body);
            } else {
              console.log(`[ACKNOWLEDGE] id=${numericId} acknowledged OK`);
            }
          })
          .catch((err) => console.error(`[ACKNOWLEDGE] Network error for id=${numericId}:`, err));
      }
    },
    [speakReply]
  );

  // Stable refs so the SSE effect never needs to re-run when callbacks change
  const fireReminderAlertRef = useRef(fireReminderAlert);
  const fireWinddownStartRef = useRef(fireWinddownStart);
  const speakReplyRef = useRef(speakReply);
  // notifResubscribeRef — used by the SSE reconnect path to re-register push
  // after a full server restart (session may have been cleared).
  const notifResubscribeRef = useRef<(() => Promise<boolean | void>) | null>(null);
  useEffect(() => { fireReminderAlertRef.current = fireReminderAlert; }, [fireReminderAlert]);
  useEffect(() => { fireWinddownStartRef.current = fireWinddownStart; }, [fireWinddownStart]);
  useEffect(() => { speakReplyRef.current = speakReply; }, [speakReply]);
  useEffect(() => {
    notifResubscribeRef.current = notif.isSubscribed ? null : notif.resubscribe ?? null;
  }, [notif.isSubscribed, notif.resubscribe]);

  // ── Fix 2: Service worker REMINDER_PUSH listener ───────────────────────────
  // When the service worker receives a push notification it posts REMINDER_PUSH
  // to every open Winston client.  This lets the foreground app speak the
  // reminder immediately without waiting for the SSE stream to reconnect.
  // spokenReminderIds guard inside fireReminderAlert prevents double-speaking
  // if SSE also delivers the event within the same session.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      const msg = event.data ?? {};
      if (msg.type !== "REMINDER_PUSH") return;
      const id = typeof msg.reminderId === "number"
        ? msg.reminderId
        : parseInt(String(msg.reminderId ?? ""), 10);
      if (isNaN(id)) {
        console.warn("[REMINDER] REMINDER_PUSH: invalid reminderId", msg.reminderId);
        return;
      }
      console.log("[REMINDER] REMINDER_PUSH from service worker — id:", id, "text:", msg.reminderText);
      fireReminderAlertRef.current({
        id,
        userName: msg.userName ?? "",
        reminderText: msg.reminderText ?? "",
        speakText: msg.speakText ?? msg.reminderText ?? "",
      });
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, []); // empty deps — fireReminderAlertRef is always current

  // ── Bug 4: Periodic session token validation + Google auth health check ───────
  // Runs every 20 minutes. If the session is invalid the page reloads to force
  // re-auth. Also refreshes the Google connection status so the header stays
  // accurate after overnight sleep.
  useEffect(() => {
    const checkSession = async () => {
      const token = localStorage.getItem("winston_session_token");
      if (!token) return;
      try {
        const res = await fetch(`${CHAT_BASE}/api/auth/session`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (res.status === 401) {
          console.warn("[AUTH] Session token invalid — clearing storage and reloading");
          localStorage.removeItem("winston_session_token");
          localStorage.removeItem("winston_user_name");
          window.location.reload();
          return;
        }
        // Also refresh Google auth status so the header/settings stay accurate
        await refreshGoogleAuth().catch(() => {});
      } catch { /* network unavailable — will retry in 20 minutes */ }
    };

    // Check once on mount (catches tokens invalidated while app was in background)
    void checkSession();
    const intervalId = setInterval(checkSession, 20 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [refreshGoogleAuth]);

  // ── SSE: real-time reminders + wind-down (primary delivery when app is open) ──
  // Uses CHAT_BASE for correct path under any Vite base, with exponential-backoff
  // reconnection so mobile devices auto-recover after SSE drops.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1_000;
    let destroyed = false;

    let hasConnectedOnce = false;

    // Include session token so the server can identify the user and route
    // user-scoped events (chat_sync, etc.). EventSource doesn't support custom
    // headers so the token is passed as a query param.
    const sseToken = localStorage.getItem("winston_session_token") ?? "";
    const sseUrl = `${CHAT_BASE}/api/reminders/stream${sseToken ? `?token=${encodeURIComponent(sseToken)}` : ""}`;

    const pollMissedReminders = async () => {
      try {
        const res = await fetch(`${CHAT_BASE}/api/reminders/due`, { cache: "no-store" });
        if (!res.ok) return;
        const due = await res.json() as Array<{ id: number; reminder_text: string }>;
        if (due.length > 0) console.log("[REMINDER] Reconnect poll found missed reminders:", due);
        for (const reminder of due) {
          if (spokenReminderIds.current.has(reminder.id)) continue;
          console.log("[REMINDER] Reconnect poll: firing missed reminder:", reminder);
          fireReminderAlertRef.current({
            id: reminder.id,
            userName: "",
            reminderText: reminder.reminder_text,
            speakText: reminder.reminder_text,
          });
        }
      } catch { /* network unavailable — silent */ }
    };

    const attach = (source: EventSource) => {
      source.addEventListener("reminder", (e) => {
        console.log("SSE: reminder event received", e.data);
        console.log("[REMINDER] SSE 'reminder' event received:", e.data);
        try {
          fireReminderAlertRef.current(JSON.parse(e.data) as ReminderEvent);
        } catch (err) {
          console.error("[REMINDER] Error in SSE reminder handler:", err);
        }
      });

      // Live sync: reminder created, deleted, fired, or completed on any device
      source.addEventListener("reminder_sync", (e) => {
        try { const d = JSON.parse(e.data); console.log("SSE: reminder_sync received — action:", d.action, "id:", d.id ?? d.reminder?.id ?? null, "readyState:", source.readyState); } catch { console.log("SSE: reminder_sync raw:", e.data); }
        console.log("SSE: connection state", source.readyState, "— reminder_sync action:", JSON.parse(e.data)?.action ?? e.data);
        try {
          const data = JSON.parse(e.data) as {
            action: "created" | "deleted" | "fired" | "completed";
            reminder?: UpcomingReminder;
            id?: number;
          };
          if (data.action === "created" && data.reminder) {
            setUpcomingReminders((prev) => {
              // Avoid duplicates
              if (prev.some((r) => r.id === data.reminder!.id)) return prev;
              return [...prev, data.reminder!].sort(
                (a, b) => new Date(a.fire_at).getTime() - new Date(b.fire_at).getTime()
              );
            });
          } else if (
            (data.action === "deleted" || data.action === "fired" || data.action === "completed") &&
            data.id != null
          ) {
            setUpcomingReminders((prev) => prev.filter((r) => r.id !== data.id));
          }
        } catch {}
      });

      source.addEventListener("winddown-start", (e) => {
        try {
          const data = JSON.parse(e.data) as { message: string };
          fireWinddownStartRef.current(data.message);
        } catch {}
      });

      // Chat message sync — another device sent a message; add it locally
      // so both screens show the same conversation without a page refresh.
      source.addEventListener("chat_sync", (e) => {
        try {
          const data = JSON.parse(e.data) as {
            role: string;
            content: string;
            messageId?: string;
            createdAt: string;
            senderDeviceId: string | null;
          };

          // Guard 1: skip messages sent from this device
          const myDeviceId = localStorage.getItem("winston_device_id");
          if (myDeviceId && data.senderDeviceId === myDeviceId) return;

          // Guard 2: skip if this device already streamed this response (messageId match)
          if (data.messageId && ownedMessageIds.current.has(data.messageId)) {
            console.log("[CHAT SYNC] Duplicate messageId — skipping:", data.messageId);
            return;
          }

          // Guard 2b: warn and skip if content is null or empty
          if (!data.content) {
            console.warn("[CHAT SYNC] Received message with null/empty content — skipping. role:", data.role, "messageId:", data.messageId ?? "n/a");
            return;
          }

          const msgId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          console.log("[CHAT SYNC] Received message from other device — role:", data.role, "chars:", data.content.length, "messageId:", data.messageId ?? "n/a");

          // Guard 3: if app is in background, queue for when it comes to foreground
          if (document.hidden) {
            pendingSyncQueue.current.push({ id: msgId, role: data.role as "user" | "assistant", content: data.content });
            console.log("[CHAT SYNC] App in background — queued:", msgId);
            return;
          }

          setMessages((prev) => {
            // Guard 4: content dedup as final fallback
            const recent = prev.slice(-10);
            if (recent.some((m) => m.role === data.role && m.content === data.content)) {
              console.log("[CHAT SYNC] Duplicate content — skipping:", data.content.slice(0, 60));
              return prev;
            }
            return [...prev, { id: msgId, role: data.role as "user" | "assistant", content: data.content }];
          });
        } catch (err) {
          console.error("[CHAT SYNC] Error handling chat_sync event:", err);
        }
      });

      // Speak sync — Rule 1: user-initiated conversation.
      // initiated_by = device that sent the message (user-initiated).
      // If initiated_by is truthy, this is a user-initiated response:
      //   - Originating device already spoke during streaming → suppress.
      //   - All other devices must NOT speak → suppress.
      // If initiated_by is null/undefined, this is system-initiated → speak on all devices.
      source.addEventListener("speak_sync", (e) => {
        try {
          const data = JSON.parse(e.data) as {
            text: string;
            messageId: string;
            initiated_by?: string | null;
          };

          if (data.initiated_by) {
            // User-initiated: suppress TTS on every device.
            // Originating device already spoke during streaming.
            // Other devices show text via chat_sync only.
            console.log("[SPEAK SYNC] User-initiated (initiated_by:", data.initiated_by, ") — suppressing TTS on all devices");
            return;
          }

          // initiated_by is null/undefined = system-initiated → speak on all devices.
          const msgId = `speak-sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          console.log("[SPEAK SYNC] System-initiated — speaking on all devices");
          speakReplyRef.current(msgId, data.text);
        } catch (err) {
          console.error("[SPEAK SYNC] Error:", err);
        }
      });

      // Proactive messages — Rule 3: system-initiated messages speak on ALL devices.
      // These include morning briefings pushed by server, conversation starters,
      // Dallas content alerts, concert alerts, and other ambient check-ins.
      source.addEventListener("proactive", (e) => {
        try {
          const data = JSON.parse(e.data) as {
            message: string;
            type?: string;
          };
          if (!data.message) return;
          const msgId = `proactive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          console.log("[PROACTIVE] System-initiated message — speaking on all devices, type:", data.type ?? "unknown");
          setMessages((prev) => {
            // Dedup: skip if identical content was just added
            const recent = prev.slice(-5);
            if (recent.some((m) => m.role === "assistant" && m.content === data.message)) return prev;
            return [...prev, { id: msgId, role: "assistant" as const, content: data.message }];
          });
          speakReplyRef.current(msgId, data.message);
        } catch (err) {
          console.error("[PROACTIVE] Error handling proactive event:", err);
        }
      });

      source.onopen = () => {
        backoffMs = 1_000; // reset backoff on successful connect
        console.log("SSE CONNECTED — readyState:", source.readyState);
        // ── Fix 9: restore ONLINE indicator and re-register push after recovery ──
        setConnectionStatus("online");
        if (hasConnectedOnce) {
          // SSE reconnected after a drop — immediately check for any reminders
          // that fired while the connection was down (screen lock, background tab, etc.)
          console.log("[REMINDER] SSE reconnected — polling for missed reminders");
          void pollMissedReminders();
          // NOTE: push re-registration is intentionally NOT done here.
          // The useNotifications mount check handles re-registration on every page load.
          // Calling resubscribe() from an SSE reconnect caused a race condition:
          // it ran forceRenew=true during the mount check's async window, unsubscribing
          // a valid browser subscription before the mount check could find it.
        }
        hasConnectedOnce = true;
      };

      source.onerror = (e) => {
        // Log the error — on mobile Chrome this often fires for QUIC protocol
        // errors or ECONNRESET which look identical to normal reconnects.
        const errType = (e as Event & { type?: string })?.type ?? "unknown";
        console.log(`SSE ERROR: ${errType} — readyState: ${source.readyState}`);
        source.close();
        if (destroyed) return;

        // ── Fix 9: show RECONNECTING and probe health to detect full server restart ──
        setConnectionStatus("reconnecting");

        const baseUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
        const scheduleReconnect = (delay: number) => {
          reconnectTimer = setTimeout(() => {
            if (destroyed) return;
            console.log(`SSE RECONNECTING after ${delay}ms — creating new EventSource`);
            es = new EventSource(sseUrl);
            attach(es);
          }, delay);
        };

        // Probe health: if server is fully down, wait 5 s before retrying so we
        // don't hammer a restarting server with instant reconnect attempts.
        const delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, 30_000);
        void fetch(`${baseUrl}/api/health`, { cache: "no-store" })
          .then((r) => {
            if (r.ok) {
              // Server is up — SSE just dropped (network blip / QUIC error)
              console.log(`SSE health OK — reconnecting in ${delay}ms`);
              scheduleReconnect(delay);
            } else {
              // Server returned an error — wait 5 s then retry
              console.log("SSE health returned error — waiting 5 s before reconnect");
              scheduleReconnect(5_000);
            }
          })
          .catch(() => {
            // Server unreachable (restarting or network loss) — wait 5 s then retry
            console.log("SSE health unreachable — server may be restarting, waiting 5 s");
            scheduleReconnect(5_000);
          });
      };
    };

    es = new EventSource(sseUrl);
    attach(es);

    // When app comes to foreground: fetch latest messages from server to catch up
    // on any conversation that happened on another device while this one was backgrounded.
    // This handles both the SSE queue case and the SSE-disconnected case (common on mobile).
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;

      const tok = localStorage.getItem("winston_session_token") ?? "";
      const bUrl = (import.meta.env.BASE_URL as string).replace(/\/$/, "");
      console.log("[CATCH UP] App foregrounded — fetching latest messages from server");

      fetch(`${bUrl}/api/messages?limit=100`, {
        cache: "no-store",
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ messages: Message[] }>) : null))
        .then((data) => {
          if (!data?.messages?.length) return;
          const serverMessages = data.messages;
          setMessages((prev) => {
            // Build a set of existing content fingerprints to detect duplicates
            const existing = new Set(prev.map((m) => `${m.role}:${m.content}`));
            const toAdd = serverMessages.filter(
              (m) => !existing.has(`${m.role}:${m.content}`)
            );
            if (toAdd.length === 0) {
              console.log("[CATCH UP] Already up to date — no new messages");
              return prev;
            }
            console.log("[CATCH UP] Merging", toAdd.length, "new message(s) from server");
            // Merge: preserve local messages then append any server messages not already present
            // Server messages are authoritative for ordering; rebuild from server list
            const serverIds = new Set(serverMessages.map((m) => `${m.role}:${m.content}`));
            const localOnly = prev.filter(
              (m) => !serverIds.has(`${m.role}:${m.content}`) && m.id.startsWith("local-")
            );
            // Re-apply morning briefing flag — not persisted in the DB
            return [...serverMessages.map(withMorningFlag), ...localOnly];
          });

          // Also drain any SSE queued messages that arrived during backgrounding
          const pending = pendingSyncQueue.current.splice(0);
          if (pending.length > 0) {
            console.log("[CATCH UP] Discarding", pending.length, "SSE queued message(s) — server fetch supersedes them");
          }
        })
        .catch((err) => {
          console.warn("[CATCH UP] Fetch failed, falling back to SSE queue:", err);
          // Fallback: drain SSE queue if server fetch fails
          const pending = pendingSyncQueue.current.splice(0);
          if (pending.length > 0) {
            console.log("[CATCH UP] Applying", pending.length, "queued SSE message(s) as fallback");
            setMessages((prev) => {
              let updated = [...prev];
              for (const msg of pending) {
                const recent = updated.slice(-10);
                if (!recent.some((m) => m.role === msg.role && m.content === msg.content)) {
                  updated = [...updated, msg];
                }
              }
              return updated;
            });
          }
        });
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []); // empty deps — created once, refs always stay current

  // ── Polling fallback: checks /api/reminders/due every 20 s ───────────────────
  // Critical on mobile where SSE drops silently (QUIC errors, screen lock, etc).
  // Uses spokenReminderIds to skip reminders already handled by SSE.
  // Starts after 5 s (not 15) so the first poll catches reminders that fired
  // while the SSE connection was being established.
  useEffect(() => {
    const poll = async () => {
      const token = localStorage.getItem("winston_session_token") ?? "";
      console.log("[REMINDER] Polling fallback — checking /api/reminders/due");
      try {
        const res = await fetch(`${CHAT_BASE}/api/reminders/due`, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) {
          console.warn("[REMINDER] Poll: non-OK response:", res.status);
          return;
        }
        const due = await res.json() as Array<{ id: number; reminder_text: string }>;
        console.log(`[REMINDER] Poll: ${due.length} due reminder(s) found`);
        for (const reminder of due) {
          if (spokenReminderIds.current.has(reminder.id)) {
            console.log("[REMINDER] Poll: already spoken, skipping id:", reminder.id);
            continue;
          }
          console.log("[REMINDER] Poll: firing missed reminder via fallback:", reminder);
          fireReminderAlertRef.current({
            id: reminder.id,
            userName: "",
            reminderText: reminder.reminder_text,
            speakText: reminder.reminder_text,
          });
        }
      } catch (err) {
        console.warn("[REMINDER] Poll: network error —", err);
      }
    };

    // First poll after 10 s (give SSE a chance to connect and fire first)
    const initial = setTimeout(poll, 10_000);
    // Then every 60 s — SSE is the real-time path; polling is only a fallback
    const interval = setInterval(poll, 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []); // empty deps — refs and fetch are stable

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

  const googleBtnClass = "flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground bg-card border border-border hover:border-primary/30 rounded-full px-3 py-1.5 transition-all duration-200";
  const googleBtnIcon = (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
  const isMobileDevice = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  // ── Google disconnect (Bug 6) ───────────────────────────────────────────────
  const handleGoogleDisconnect = useCallback(async () => {
    const token = localStorage.getItem("winston_session_token") ?? "";
    try {
      await fetch(`${CHAT_BASE}/api/auth/google/disconnect`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch { /* ignore network errors */ }
    await refreshGoogleAuth();
  }, [refreshGoogleAuth]);

  // ── Google connect from settings (reuse popup logic) ────────────────────────
  const handleGoogleConnect = useCallback(() => {
    if (isMobileDevice) {
      window.location.href = `${CHAT_BASE}/api/auth/google`;
      return;
    }
    const popup = window.open(`${CHAT_BASE}/api/auth/google`, "google-oauth", "width=520,height=640,left=200,top=100,resizable=yes,scrollbars=yes");
    if (!popup) { window.location.href = `${CHAT_BASE}/api/auth/google`; return; }
    const onMessage = async (e: MessageEvent) => {
      if (e.data === "google-connected") {
        window.removeEventListener("message", onMessage);
        clearInterval(poll);
        await refreshGoogleAuth();
        setMessages((prev) => [...prev, { id: `google-connected-${Date.now()}`, role: "assistant" as const, content: "Google connected — I now have access to your Gmail and Calendar. Say good morning and I'll give you a full briefing." }]);
      } else if (e.data === "google-auth-error") {
        window.removeEventListener("message", onMessage);
        clearInterval(poll);
      }
    };
    window.addEventListener("message", onMessage);
    const poll = setInterval(() => {
      if (popup.closed) { clearInterval(poll); window.removeEventListener("message", onMessage); void refreshGoogleAuth(); }
    }, 1000);
  }, [isMobileDevice, refreshGoogleAuth]);

  const connectGoogleBtn = isMobileDevice ? (
    <a href="/api/auth/google" className={googleBtnClass}>
      {googleBtnIcon}
      Connect Google
    </a>
  ) : (
    <button
      type="button"
      onClick={() => {
        const popup = window.open("/api/auth/google", "google-oauth", "width=520,height=640,left=200,top=100,resizable=yes,scrollbars=yes");
        if (!popup) { window.location.href = "/api/auth/google"; return; }
        const onMessage = async (e: MessageEvent) => {
          if (e.data === "google-connected") {
            window.removeEventListener("message", onMessage);
            clearInterval(poll);
            await refreshGoogleAuth();
            setMessages((prev) => [...prev, { id: `google-connected-${Date.now()}`, role: "assistant" as const, content: "Google connected — I now have access to your Gmail and Calendar. Say good morning and I'll give you a full briefing." }]);
          } else if (e.data === "google-auth-error") {
            window.removeEventListener("message", onMessage);
            clearInterval(poll);
            setMessages((prev) => [...prev, { id: `auth-error-${Date.now()}`, role: "assistant" as const, content: "Google sign-in didn't complete. Want to try again?" }]);
          }
        };
        window.addEventListener("message", onMessage);
        const poll = setInterval(() => {
          if (popup.closed) { clearInterval(poll); window.removeEventListener("message", onMessage); void refreshGoogleAuth(); }
        }, 1000);
      }}
      className={googleBtnClass}
    >
      {googleBtnIcon}
      Connect Google
    </button>
  );

  return (
    <>
    {/* ── "Return to Winston" sticky banner — shown for 60 s after navigation ─ */}
    {navBannerVisible && (
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          setNavBannerVisible(false);
        }}
        onKeyDown={(e) => e.key === "Enter" && scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-3 cursor-pointer select-none animate-in slide-in-from-top-2 duration-300"
        style={{ background: "linear-gradient(90deg, #92400e 0%, #78350f 60%, #92400e 100%)", borderBottom: "1px solid rgba(217,119,6,0.4)", boxShadow: "0 2px 12px rgba(0,0,0,0.4)" }}
      >
        <ChevronDown className="h-4 w-4 text-amber-200 flex-shrink-0" />
        <span className="text-sm font-semibold text-amber-50 tracking-wide">Tap here to return to Winston</span>
        <ChevronDown className="h-4 w-4 text-amber-200 flex-shrink-0" />
      </div>
    )}
    <div className="flex flex-col h-[100dvh] max-w-4xl mx-auto overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/5 py-3 px-4 sm:px-6 flex items-center justify-between bg-background/80 backdrop-blur-sm z-10 sticky top-0">
        {/* Left — user identity: profile photo + companion name */}
        <div className="flex items-center gap-3 min-w-0">
          {/* User profile photo — base64 DB photo first, Google photo second, initials fallback */}
          <UserAvatar
            avatarBase64={customAvatarBase64}
            googlePicture={userPicture}
            fullName={userFullName}
            userName={userName}
          />
          <div className="min-w-0">
            <h1 className="text-xl font-serif font-medium text-foreground tracking-wide truncate">{companionName}</h1>
            {connectionStatus === "reconnecting" ? (
              <p className="text-xs text-amber-400/80 font-medium tracking-widest uppercase flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                Reconnecting…
              </p>
            ) : (
              <p className="hidden sm:block text-xs text-muted-foreground font-medium tracking-widest uppercase">Always Here</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">

        {/* Google auth badge */}
        {googleAuth.connected ? (
            <div className="flex items-center gap-1.5 text-xs text-green-400/80 bg-green-950/30 border border-green-500/20 rounded-full px-3 py-1.5">
              <Mail className="h-3 w-3" />
              <span className="hidden sm:inline">{googleAuth.email}</span>
              <span className="sm:hidden">Gmail</span>
            </div>
          ) : connectGoogleBtn
        }

        {/* Notification bell — green=registered, red=not registered */}
        {isNotificationsSupported() && (
          <div className="relative">
            <button
              onClick={() => {
                if (notif.permission === "granted" && notif.isSubscribed) {
                  void notif.unsubscribe();
                } else if (notif.permission === "granted" && !notif.isSubscribed) {
                  void notif.resubscribe();
                } else if (notif.permission !== "denied") {
                  void notif.requestPermission();
                }
              }}
              className={`transition-colors p-1.5 rounded-full border ${
                notif.isSubscribed
                  ? "text-green-400 border-green-500/30 bg-green-950/30 hover:bg-green-950/50"
                  : notif.permission === "denied"
                  ? "text-muted-foreground/40 border-white/10 cursor-not-allowed"
                  : "text-red-400 border-red-500/30 bg-red-950/30 hover:bg-red-950/50"
              }`}
              title={
                notif.isSubscribed
                  ? "Notifications on — tap to disable"
                  : notif.permission === "denied"
                  ? "Notifications blocked — reset in browser settings"
                  : "Notifications not registered — tap to enable"
              }
              disabled={notif.isLoading || notif.permission === "denied"}
            >
              {notif.isLoading
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : notif.isSubscribed
                ? <Bell className="h-4 w-4" />
                : <BellOff className="h-4 w-4" />}
            </button>
            {/* Red dot badge when not subscribed */}
            {!notif.isSubscribed && !notif.isLoading && notif.permission !== "denied" && (
              <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 border border-background animate-pulse" />
            )}
          </div>
        )}

        {/* Upcoming reminders pill */}
        {upcomingReminders.length > 0 && (
          <div className="relative">
            <button
              onClick={() => setShowRemindersPanel((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-full border transition-colors
                border-amber-500/30 bg-amber-950/30 text-amber-400/90 hover:bg-amber-950/50 hover:border-amber-500/50"
              title="Upcoming reminders"
            >
              <Clock className="h-3 w-3 flex-shrink-0" />
              <span>{upcomingReminders.length}</span>
              {showRemindersPanel
                ? <ChevronUp className="h-3 w-3 flex-shrink-0" />
                : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
            </button>

            {/* Dropdown panel */}
            {showRemindersPanel && (
              <>
                {/* invisible backdrop to close on outside-click */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowRemindersPanel(false)}
                />
              <div className="absolute right-0 top-full mt-2 w-72 bg-card border border-white/10 rounded-2xl shadow-xl z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5">
                  <p className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
                    Upcoming Reminders
                  </p>
                </div>
                <ul className="max-h-64 overflow-y-auto divide-y divide-white/5">
                  {upcomingReminders.map((r) => {
                    const when = new Date(r.fire_at);
                    const now = new Date();
                    const diffMs = when.getTime() - now.getTime();
                    const diffMin = Math.round(diffMs / 60_000);
                    const diffHr = Math.round(diffMs / 3_600_000);
                    const isPastDue = diffMs < 0;
                    let timeLabel: string;
                    if (isPastDue)        timeLabel = "Past due";
                    else if (diffMin < 60) timeLabel = `in ${diffMin}m`;
                    else if (diffHr < 24)  timeLabel = `in ${diffHr}h`;
                    else                   timeLabel = when.toLocaleDateString("en-US", { month: "short", day: "numeric" });

                    const dismiss = async () => {
                      setUpcomingReminders((prev) => prev.filter((x) => x.id !== r.id));
                      await fetch(`${CHAT_BASE}/api/reminders/${r.id}/complete`, { method: "POST" });
                    };
                    return (
                      <li
                        key={r.id}
                        className={`px-4 py-2.5 flex items-start justify-between gap-3 hover:bg-white/5 transition-colors ${isPastDue ? "bg-amber-950/20" : ""}`}
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground truncate">{r.reminder_text}</p>
                          <p className={`text-xs mt-0.5 flex items-center gap-1 ${isPastDue ? "text-amber-400/80" : "text-muted-foreground"}`}>
                            {r.recurring && <span className="text-primary/60">↻</span>}
                            {timeLabel}
                            {/* Past-due gets an inline dismiss link */}
                            {isPastDue && (
                              <button
                                onClick={dismiss}
                                className="ml-1 underline underline-offset-2 text-amber-400/70 hover:text-amber-300 transition-colors"
                              >
                                Dismiss
                              </button>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                          {/* Mark done (✓) */}
                          <button
                            onClick={dismiss}
                            className={`transition-colors ${isPastDue ? "text-amber-400 hover:text-amber-300" : "text-muted-foreground/40 hover:text-green-400"}`}
                            title="Mark done"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          {/* Delete entirely */}
                          <button
                            onClick={async () => {
                              setUpcomingReminders((prev) => prev.filter((x) => x.id !== r.id));
                              await fetch(`${CHAT_BASE}/api/reminders/${r.id}`, { method: "DELETE" });
                            }}
                            className="text-muted-foreground/40 hover:text-red-400 transition-colors"
                            title="Delete reminder"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
              </>
            )}
          </div>
        )}

        {/* Lists */}
        <button
          onClick={() => setLocation("/lists")}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-white/10 border border-white/10 hover:border-white/20"
          title="Lists"
        >
          <List className="h-4 w-4" />
        </button>

        {/* Help button */}
        <button
          onClick={() => window.open("/guide.html", "_blank", "noopener,noreferrer")}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-white/10 border border-white/10 hover:border-white/20"
          title="User guide"
        >
          <HelpCircle className="h-4 w-4" />
        </button>

        {/* Settings gear */}
        <button
          onClick={() => { setShowSettings(true); setShowRemindersPanel(false); }}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-white/10 border border-white/10 hover:border-white/20"
          title="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>

        {/* Sign out */}
        {onSignOut && (
          <button
            onClick={onSignOut}
            className="text-muted-foreground/40 hover:text-red-400/70 transition-colors p-1.5 rounded-full hover:bg-red-950/20 border border-white/10 hover:border-red-500/20"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        )}
        </div>
      </header>

      {/* Notification permission banner */}
      {showNotifBanner && (
        <div className="flex-shrink-0 bg-primary/10 border-b border-primary/20 px-4 py-3 flex items-start gap-3 animate-in slide-in-from-top duration-300">
          <Bell className="h-4 w-4 text-primary/70 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground/90 leading-snug">
              <span className="font-medium text-primary/90">{companionName}:</span>{" "}
              May I send you reminders and updates throughout the day? I promise to only reach out when it matters — medications, reminders you've set, evening check-ins.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => void notif.requestPermission().then(() => {
                setNotifBannerDismissed(true);
                localStorage.setItem("notif-banner-dismissed", "1");
              })}
              disabled={notif.isLoading}
              className="text-xs font-medium text-primary hover:text-primary/80 transition-colors bg-primary/15 hover:bg-primary/25 px-3 py-1.5 rounded-full border border-primary/30 whitespace-nowrap"
            >
              {notif.isLoading ? "…" : "Yes, please"}
            </button>
            <button
              onClick={() => {
                setNotifBannerDismissed(true);
                localStorage.setItem("notif-banner-dismissed", "1");
              }}
              className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Wind-down settings modal */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        baseUrl={baseUrl}
        currentVoiceId={resolvedVoiceId}
        onVoiceChange={(voiceId, voiceName, audio) => {
          setResolvedVoiceId(voiceId);
          localStorage.setItem("winston_voice_id", voiceId);
          if (audio) playSettingsAudio(audio.audioBase64, audio.mimeType);
        }}
        currentCompanionName={companionName}
        onNameChange={(name, audio) => {
          setResolvedCompanionName(name);
          localStorage.setItem("winston_companion_name", name);
          if (audio) playSettingsAudio(audio.audioBase64, audio.mimeType);
        }}
        currentAvatarBase64={customAvatarBase64}
        googlePhotoUrl={userPicture}
        userFullName={userFullName}
        userName={userName}
        onAvatarChange={(dataUrl) => setCustomAvatarBase64(dataUrl)}
        winddownSettings={winddownSettings}
        onWinddownChange={setWinddownSettings}
        localTime={localTime}
        onLocalTimeChange={setLocalTime}
        onWinddownSave={saveWinddownSettings}
        settingsSaving={settingsSaving}
        notif={notif}
        googleConnected={googleAuth.connected}
        googleEmail={googleAuth.email}
        onGoogleDisconnect={() => void handleGoogleDisconnect()}
        onGoogleConnect={handleGoogleConnect}
      />

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
              {msg.isMorningBriefing && <WeatherCard />}
              <div className="whitespace-pre-wrap font-sans">{msg.content}</div>

              {/* Navigation card — shown for messages that triggered directions */}
              {msg.role === "assistant" && msg.navigationUrl && (
                <div className="mt-3 rounded-xl overflow-hidden border border-amber-700/40" style={{ background: "linear-gradient(135deg, rgba(120,53,15,0.35) 0%, rgba(146,64,14,0.25) 100%)" }}>
                  <div className="px-3.5 pt-3 pb-1 flex items-center gap-2">
                    <MapPin className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
                    <span className="text-[11px] font-semibold tracking-widest uppercase text-amber-400/90">Navigation</span>
                  </div>
                  {msg.navigationDestination && (
                    <p className="px-3.5 pb-2 text-sm font-medium text-amber-100/90">{msg.navigationDestination}</p>
                  )}
                  <button
                    onClick={() => {
                      window.open(msg.navigationUrl!, "_blank", "noopener,noreferrer");
                      triggerNavBanner();
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 font-semibold text-sm text-white transition-colors hover:brightness-110 active:brightness-90"
                    style={{ background: "linear-gradient(90deg, #b45309 0%, #92400e 100%)" }}
                  >
                    <MapPin className="h-4 w-4" />
                    Open in Google Maps
                  </button>
                </div>
              )}

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
                </div>
              )}
            </div>
          </div>
        ))}

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
              disabled={isTranscribing || isStreaming}
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
              disabled={!input.trim() || isStreaming}
              size="icon"
              className="h-11 w-11 rounded-xl shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-300 shadow-md shadow-primary/20 mb-0.5 mr-0.5"
              data-testid="button-send"
            >
              {isStreaming ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5 ml-0.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>

    {showEmergency && <EmergencyOverlay onDismiss={() => setShowEmergency(false)} />}

    {/* Legal footer */}
    <div style={{
      position: "fixed",
      bottom: "6px",
      left: 0,
      right: 0,
      textAlign: "center",
      zIndex: 10,
      pointerEvents: "none",
    }}>
      <span style={{ fontSize: "0.62rem", color: "#2a2a42", pointerEvents: "auto" }}>
        <a
          href="/api/terms"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2a2a42", textDecoration: "none" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#4f46e5")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#2a2a42")}
        >
          Terms of Service
        </a>
        {" · "}
        <a
          href="/api/privacy"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2a2a42", textDecoration: "none" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "#4f46e5")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "#2a2a42")}
        >
          Privacy Policy
        </a>
      </span>
    </div>
    </>
  );
}
