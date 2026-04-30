import { useState, useRef, useCallback, useEffect } from "react";
import {
  X, Volume2, Play, Check, Loader2, User, Camera, Moon, Bell,
  Upload, Trash2, Music2, Mail, CheckCircle2, AlertCircle, Link2, MapPin,
  Users, GitMerge, RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNotificationsSupported } from "@/hooks/useNotifications";

interface ContactRow {
  id: number;
  name: string;
  detail: string;
  created_at: string;
}

interface DuplicateGroup {
  contacts: ContactRow[];
  suggestedMerge: {
    name: string;
    detail: string;
    keepId: number;
    discardIds: number[];
  };
}

interface Voice {
  id: string;
  name: string;
  description: string;
  accent: string;
  gender: string;
}

interface WinddownSettings {
  enabled: boolean;
  scheduledTime: string;
}

interface NotifHook {
  permission: "default" | "granted" | "denied" | "unsupported" | "unknown";
  isSubscribed: boolean;
  isLoading: boolean;
  resubscribe: () => Promise<boolean | void>;
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  baseUrl: string;

  currentVoiceId: string | null;
  onVoiceChange: (voiceId: string, voiceName: string, audio: { audioBase64: string; mimeType: string } | null) => void;

  currentCompanionName: string;
  onNameChange: (name: string, audio: { audioBase64: string; mimeType: string } | null) => void;

  currentAvatarBase64: string | null;
  googlePhotoUrl: string | undefined;
  userFullName: string | undefined;
  userName: string | undefined;
  onAvatarChange: (dataUrl: string | null) => void;

  winddownSettings: WinddownSettings;
  onWinddownChange: (s: WinddownSettings) => void;
  localTime: string;
  onLocalTimeChange: (t: string) => void;
  onWinddownSave: () => Promise<void>;
  settingsSaving: boolean;

  notif: NotifHook;

  googleConnected?: boolean;
  googleEmail?: string | null;
  onGoogleDisconnect: () => void;
  onGoogleConnect: () => void;
  onRefreshGoogleStatus?: () => Promise<void>;
}

const CHAT_BASE = (typeof import.meta !== "undefined" ? (import.meta.env.BASE_URL as string) : "/").replace(/\/$/, "");

function AvatarPreview({
  avatarBase64,
  googlePhotoUrl,
  fullName,
  size = 56,
}: {
  avatarBase64?: string | null;
  googlePhotoUrl?: string;
  fullName?: string;
  size?: number;
}) {
  const [googleFailed, setGoogleFailed] = useState(false);
  const initials = (() => {
    const name = fullName || "";
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return "?";
  })();

  const circleStyle: React.CSSProperties = {
    width: size, height: size, borderRadius: "50%", objectFit: "cover",
    border: "2px solid rgba(217,119,6,0.4)", flexShrink: 0,
  };

  if (avatarBase64) {
    return <img src={avatarBase64} alt="Profile" style={circleStyle} />;
  }
  if (googlePhotoUrl && !googleFailed) {
    return (
      <img src={googlePhotoUrl} alt="Profile" referrerPolicy="no-referrer"
        onError={() => setGoogleFailed(true)} style={circleStyle} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", display: "flex", alignItems: "center",
      justifyContent: "center", background: "linear-gradient(135deg, #d97706 0%, #b45309 100%)",
      border: "2px solid rgba(217,119,6,0.4)", flexShrink: 0,
    }}>
      <span style={{ color: "white", fontSize: size * 0.28, fontWeight: 700, letterSpacing: "-0.02em" }}>{initials}</span>
    </div>
  );
}

export default function SettingsPanel({
  isOpen,
  onClose,
  baseUrl,
  currentVoiceId,
  onVoiceChange,
  currentCompanionName,
  onNameChange,
  currentAvatarBase64,
  googlePhotoUrl,
  userFullName,
  userName,
  onAvatarChange,
  winddownSettings,
  onWinddownChange,
  localTime,
  onLocalTimeChange,
  onWinddownSave,
  settingsSaving,
  notif,
  onGoogleDisconnect,
  onGoogleConnect,
}: SettingsPanelProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(currentVoiceId);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);

  const [nameInput, setNameInput] = useState(currentCompanionName);
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [homeAddressInput, setHomeAddressInput] = useState("");
  const [savingHomeAddress, setSavingHomeAddress] = useState(false);
  const [homeAddressSaved, setHomeAddressSaved] = useState(false);
  const [homeAddressError, setHomeAddressError] = useState<string | null>(null);

  const [pendingAvatarDataUrl, setPendingAvatarDataUrl] = useState<string | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [providers, setProviders] = useState<{ google: boolean; microsoft: boolean; apple: boolean }>({ google: true, microsoft: false, apple: false });

  const [googleConnecting, setGoogleConnecting] = useState(false);
  // Self-contained Google status — fetched directly, never trusts parent prop
  const [googleStatus, setGoogleStatus] = useState<{ connected: boolean; email: string | null; loading: boolean }>({ connected: false, email: null, loading: true });
  const [garminConnected, setGarminConnected] = useState(false);
  const [garminEmail, setGarminEmail] = useState<string | null>(null);
  const [garminLastSync, setGarminLastSync] = useState<string | null>(null);
  const [garminFormEmail, setGarminFormEmail] = useState("");
  const [garminFormPassword, setGarminFormPassword] = useState("");
  const [garminConnecting, setGarminConnecting] = useState(false);
  const [garminError, setGarminError] = useState<string | null>(null);

  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const [loadingDuplicates, setLoadingDuplicates] = useState(false);
  const [mergingId, setMergingId] = useState<number | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergedIds, setMergedIds] = useState<Set<number>>(new Set());

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchGoogleStatus = useCallback(async () => {
    setGoogleStatus({ connected: false, email: null, loading: true });
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : { "x-api-key": "winston-native-2026" };
      const res = await fetch(`${CHAT_BASE}/api/auth/status`, { headers });
      const data = await res.json() as { connected: boolean; email?: string };
      setGoogleStatus({ connected: data.connected, email: data.email ?? null, loading: false });
    } catch {
      setGoogleStatus({ connected: false, email: null, loading: false });
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedVoiceId(currentVoiceId);
    setNameInput(currentCompanionName);
    setPendingAvatarDataUrl(null);
    setPhotoError(null);
    setNameSaved(false);
    setGoogleConnecting(false);
    // Always fetch Google status fresh from the server when the panel opens
    void fetchGoogleStatus();
  }, [isOpen, currentVoiceId, currentCompanionName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch Google status when window regains focus (handles popup OAuth flow completing)
  useEffect(() => {
    if (!isOpen) return;
    const onFocus = () => { void fetchGoogleStatus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void fetchGoogleStatus();
    });
    return () => { window.removeEventListener("focus", onFocus); };
  }, [isOpen, fetchGoogleStatus]);

  useEffect(() => {
    if (!isOpen) return;
    fetch(`${CHAT_BASE}/api/settings/home-address`)
      .then((r) => r.json())
      .then((d: { homeAddress?: string | null }) => {
        if (d.homeAddress) { setHomeAddressInput(d.homeAddress); }
      })
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || voices.length > 0) return;
    fetch(`${CHAT_BASE}/api/onboarding/voices`)
      .then((r) => r.json())
      .then((d: { voices?: Voice[] }) => { if (d.voices) setVoices(d.voices); })
      .catch(() => {});
  }, [isOpen, voices.length]);

  useEffect(() => {
    if (!isOpen) return;
    fetch(`${CHAT_BASE}/api/auth/providers`)
      .then((r) => r.json())
      .then((d: { google?: boolean; microsoft?: boolean; apple?: boolean }) => {
        setProviders({ google: d.google ?? true, microsoft: d.microsoft ?? false, apple: d.apple ?? false });
      })
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const token = localStorage.getItem("winston_session_token") ?? "";
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : { "x-api-key": "winston-native-2026" };
    fetch(`${CHAT_BASE}/api/garmin/status`, { headers })
      .then((r) => r.json())
      .then((d: { connected?: boolean; garminEmail?: string; lastSync?: string | null }) => {
        setGarminConnected(d.connected ?? false);
        setGarminEmail(d.garminEmail ?? null);
        setGarminLastSync(d.lastSync ?? null);
      })
      .catch(() => {});
  }, [isOpen]);

  const handleGarminConnect = useCallback(async () => {
    if (!garminFormEmail || !garminFormPassword) return;
    setGarminConnecting(true);
    setGarminError(null);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : { "x-api-key": "winston-native-2026" }),
      };
      const res = await fetch(`${CHAT_BASE}/api/garmin/connect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: garminFormEmail, password: garminFormPassword }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setGarminError(data.error ?? "Connection failed — check your credentials");
      } else {
        setGarminConnected(true);
        setGarminEmail(garminFormEmail);
        setGarminFormEmail("");
        setGarminFormPassword("");
      }
    } catch {
      setGarminError("Connection failed — please try again");
    } finally {
      setGarminConnecting(false);
    }
  }, [garminFormEmail, garminFormPassword]);

  const handleGarminDisconnect = useCallback(async () => {
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : { "x-api-key": "winston-native-2026" };
      await fetch(`${CHAT_BASE}/api/garmin/disconnect`, { method: "POST", headers });
      setGarminConnected(false);
      setGarminEmail(null);
      setGarminLastSync(null);
    } catch { /* silent */ }
  }, []);

  const stopAudio = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.src = "";
    setPlayingVoiceId(null);
  }, []);

  const playVoicePreview = useCallback(async (voiceId: string) => {
    if (playingVoiceId === voiceId) { stopAudio(); return; }
    stopAudio();
    setPlayingVoiceId(voiceId);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/onboarding/voice-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ voiceId }),
      });
      const data = (await res.json()) as { audioBase64?: string; mimeType?: string };
      if (!data.audioBase64) { setPlayingVoiceId(null); return; }
      const audio = new Audio(`data:${data.mimeType ?? "audio/mpeg"};base64,${data.audioBase64}`);
      audioRef.current = audio;
      audio.onended = () => setPlayingVoiceId(null);
      audio.onerror = () => setPlayingVoiceId(null);
      void audio.play();
    } catch {
      setPlayingVoiceId(null);
    }
  }, [playingVoiceId, stopAudio]);

  const saveVoice = useCallback(async () => {
    if (!selectedVoiceId || selectedVoiceId === currentVoiceId) return;
    setSavingVoice(true);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/settings/voice`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ voiceId: selectedVoiceId }),
      });
      const data = (await res.json()) as { ok?: boolean; voiceId?: string; voiceName?: string; audio?: { audioBase64: string; mimeType: string } | null };
      if (data.ok) {
        onVoiceChange(selectedVoiceId, data.voiceName ?? "", data.audio ?? null);
        stopAudio();
      }
    } finally {
      setSavingVoice(false);
    }
  }, [selectedVoiceId, currentVoiceId, onVoiceChange, stopAudio]);

  const saveName = useCallback(async () => {
    const name = nameInput.trim();
    if (!name || name === currentCompanionName) return;
    setSavingName(true);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/settings/name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ companionName: name }),
      });
      const data = (await res.json()) as { ok?: boolean; companionName?: string; audio?: { audioBase64: string; mimeType: string } | null };
      if (data.ok) {
        onNameChange(name, data.audio ?? null);
        setNameSaved(true);
        setTimeout(() => setNameSaved(false), 2000);
      }
    } finally {
      setSavingName(false);
    }
  }, [nameInput, currentCompanionName, onNameChange]);

  const saveHomeAddress = useCallback(async () => {
    const addr = homeAddressInput.trim();
    if (!addr) return;
    setSavingHomeAddress(true);
    setHomeAddressError(null);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/settings/home-address`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ homeAddress: addr }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (data.ok) {
        setHomeAddressSaved(true);
        setTimeout(() => setHomeAddressSaved(false), 2500);
      } else {
        setHomeAddressError(data.error ?? "Failed to save");
      }
    } catch {
      setHomeAddressError("Network error — please try again");
    } finally {
      setSavingHomeAddress(false);
    }
  }, [homeAddressInput]);

  const loadDuplicates = useCallback(async () => {
    setLoadingDuplicates(true);
    setMergeError(null);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/contacts/duplicates`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = (await res.json()) as { duplicates?: DuplicateGroup[]; error?: string };
      setDuplicates(data.duplicates ?? []);
    } catch {
      setMergeError("Failed to load contacts");
    } finally {
      setLoadingDuplicates(false);
    }
  }, []);

  const mergeDuplicate = useCallback(async (group: DuplicateGroup) => {
    setMergingId(group.suggestedMerge.keepId);
    setMergeError(null);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const res = await fetch(`${CHAT_BASE}/api/contacts/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          keepId: group.suggestedMerge.keepId,
          discardIds: group.suggestedMerge.discardIds,
          mergedName: group.suggestedMerge.name,
          mergedDetail: group.suggestedMerge.detail,
        }),
      });
      if (res.ok) {
        const allIds = new Set([group.suggestedMerge.keepId, ...group.suggestedMerge.discardIds]);
        setMergedIds((prev) => new Set([...prev, ...allIds]));
        setDuplicates((prev) => prev.filter((g) => g.suggestedMerge.keepId !== group.suggestedMerge.keepId));
      } else {
        setMergeError("Merge failed — please try again");
      }
    } catch {
      setMergeError("Network error");
    } finally {
      setMergingId(null);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadDuplicates();
  }, [isOpen, loadDuplicates]);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    console.log("[PHOTO] Step 1 — file selected:", file ? `${file.name} (${file.size} bytes, type="${file.type}")` : "none");
    if (!file) return;
    setPhotoError(null);
    setPendingAvatarDataUrl(null);

    const MAX_BYTES = 2 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      console.warn("[PHOTO] Step 1 FAIL — file too large:", file.size, "bytes (limit 2 MB)");
      setPhotoError("Image too large — please choose a photo under 2 MB.");
      return;
    }

    console.log("[PHOTO] Step 2 — reading file with FileReader…");
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      if (!result || !result.startsWith("data:")) {
        console.error("[PHOTO] Step 2 FAIL — unexpected data URL format:", result?.slice(0, 40));
        setPhotoError("Could not read the file. Please try another image.");
        return;
      }
      console.log("[PHOTO] Step 2 OK — data URL length:", result.length, "prefix:", result.slice(0, 30));
      setPendingAvatarDataUrl(result);
    };
    reader.onerror = (ev) => {
      console.error("[PHOTO] Step 2 FAIL — FileReader error:", ev);
      setPhotoError("Could not read the file. Please try another image.");
    };
    reader.readAsDataURL(file);
  }, []);

  const savePhoto = useCallback(async () => {
    if (!pendingAvatarDataUrl) { console.warn("[PHOTO] savePhoto called but no pending data URL"); return; }
    setSavingPhoto(true);
    setPhotoError(null);
    try {
      const token = localStorage.getItem("winston_session_token") ?? "";
      const url = `${CHAT_BASE}/api/profile/avatar`;
      console.log("[PHOTO] Step 3 — POST to:", url, "| data URL length:", pendingAvatarDataUrl.length, "| token prefix:", token.slice(0, 8) || "MISSING");

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ avatarDataUrl: pendingAvatarDataUrl }),
      });

      console.log("[PHOTO] Step 4 — HTTP status:", res.status);

      let data: { ok?: boolean; error?: string } = {};
      try {
        data = (await res.json()) as typeof data;
        console.log("[PHOTO] Step 4 — response body:", JSON.stringify(data));
      } catch (jsonErr) {
        console.error("[PHOTO] Step 4 FAIL — JSON parse error:", jsonErr);
        setPhotoError(res.status === 413 ? "Image too large (server rejected). Use a photo under 2 MB." : "Upload failed. Please try again.");
        return;
      }

      if (data.ok) {
        console.log("[PHOTO] Step 5 OK — avatar saved to DB");
        onAvatarChange(pendingAvatarDataUrl);
        setPendingAvatarDataUrl(null);
      } else {
        console.warn("[PHOTO] Step 5 FAIL — server error:", data.error);
        setPhotoError(data.error ?? "Upload failed. Please try again.");
      }
    } catch (err) {
      console.error("[PHOTO] Step 3–5 network error:", err);
      setPhotoError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSavingPhoto(false);
    }
  }, [pendingAvatarDataUrl, onAvatarChange]);

  const removeCustomPhoto = useCallback(async () => {
    const token = localStorage.getItem("winston_session_token") ?? "";
    console.log("[PHOTO] Remove — DELETE /api/profile/avatar");
    await fetch(`${CHAT_BASE}/api/profile/avatar`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    console.log("[PHOTO] Remove — done");
    onAvatarChange(null);
    setPendingAvatarDataUrl(null);
  }, [onAvatarChange]);

  if (!isOpen) return null;

  const voiceChanged = selectedVoiceId && selectedVoiceId !== currentVoiceId;
  const nameChanged = nameInput.trim() && nameInput.trim() !== currentCompanionName;
  const displayAvatarBase64 = pendingAvatarDataUrl ?? currentAvatarBase64;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-end bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) { stopAudio(); onClose(); } }}
    >
      <div className="h-full w-full max-w-md bg-[#0d0f1a] border-l border-white/10 flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/10 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Settings</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Personalise your experience</p>
          </div>
          <button
            onClick={() => { stopAudio(); onClose(); }}
            className="text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1.5 rounded-full hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-8">

          {/* ── Section 1: Companion Voice ────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <Music2 className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Companion Voice</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Click play to hear a sample, then select the voice that feels right.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {voices.map((voice) => {
                const isSelected = selectedVoiceId === voice.id;
                const isPlaying = playingVoiceId === voice.id;
                return (
                  <button
                    key={voice.id}
                    onClick={() => setSelectedVoiceId(voice.id)}
                    className={`relative flex items-start gap-2.5 p-3 rounded-xl border text-left transition-all duration-150 ${
                      isSelected
                        ? "border-primary/60 bg-primary/10 shadow-[0_0_0_1px_rgba(217,119,6,0.3)]"
                        : "border-white/8 bg-white/3 hover:border-white/15 hover:bg-white/6"
                    }`}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); void playVoicePreview(voice.id); }}
                      className={`mt-0.5 flex-shrink-0 p-1 rounded-full transition-colors ${
                        isPlaying ? "bg-primary/30 text-primary" : "bg-white/10 text-muted-foreground hover:bg-white/20"
                      }`}
                    >
                      {isPlaying ? <Volume2 className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground leading-tight">{voice.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{voice.accent}</p>
                    </div>
                    {isSelected && (
                      <div className="absolute top-2 right-2 w-3.5 h-3.5 rounded-full bg-primary/80 flex items-center justify-center">
                        <Check className="h-2 w-2 text-white" strokeWidth={3} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {voices.length === 0 && (
              <div className="flex items-center justify-center py-6 text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />Loading voices…
              </div>
            )}
            {voiceChanged && (
              <Button
                className="w-full mt-3 h-9 text-sm"
                onClick={() => void saveVoice()}
                disabled={savingVoice}
              >
                {savingVoice ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {savingVoice ? "Saving…" : "Apply voice"}
              </Button>
            )}
          </section>

          <div className="border-t border-white/8" />

          {/* ── Section 2: Companion Name ────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <User className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Companion Name</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Give your companion any name you like. They'll respond to it immediately.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => { setNameInput(e.target.value); setNameSaved(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }}
                placeholder="e.g. Alex, Jordan, Aria"
                className="flex-1 bg-input border border-border rounded-xl px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <Button
                onClick={() => void saveName()}
                disabled={savingName || !nameChanged}
                className="px-4 h-10 text-sm flex-shrink-0"
              >
                {savingName ? <Loader2 className="h-4 w-4 animate-spin" /> : nameSaved ? <Check className="h-4 w-4" /> : "Save"}
              </Button>
            </div>
            {nameSaved && (
              <p className="text-xs text-green-400/80 mt-2 flex items-center gap-1">
                <Check className="h-3 w-3" />Name updated — listen for the response
              </p>
            )}
          </section>

          <div className="border-t border-white/8" />

          {/* ── Section 3: Home Address ───────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <MapPin className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Home Address</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Required for departure alerts. When you have a calendar appointment,
              Winston calculates real-time drive time and notifies you when to leave.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={homeAddressInput}
                onChange={(e) => { setHomeAddressInput(e.target.value); setHomeAddressSaved(false); setHomeAddressError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void saveHomeAddress(); }}
                placeholder="e.g. 123 Main St, Dallas, TX 75201"
                className="flex-1 bg-input border border-border rounded-xl px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <Button
                onClick={() => void saveHomeAddress()}
                disabled={savingHomeAddress || !homeAddressInput.trim()}
                className="px-4 h-10 text-sm flex-shrink-0"
              >
                {savingHomeAddress ? <Loader2 className="h-4 w-4 animate-spin" /> : homeAddressSaved ? <Check className="h-4 w-4" /> : "Save"}
              </Button>
            </div>
            {homeAddressSaved && (
              <p className="text-xs text-green-400/80 mt-2 flex items-center gap-1">
                <Check className="h-3 w-3" />Address saved — departure alerts are now active
              </p>
            )}
            {homeAddressError && (
              <p className="text-xs text-red-400/80 mt-2">{homeAddressError}</p>
            )}
          </section>

          <div className="border-t border-white/8" />

          {/* ── Section 3b: Contact Deduplication ───────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-primary/15">
                  <Users className="h-3.5 w-3.5 text-primary" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Contact Duplicates</h3>
              </div>
              <button
                onClick={() => void loadDuplicates()}
                disabled={loadingDuplicates}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
                title="Refresh"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingDuplicates ? "animate-spin" : ""}`} />
              </button>
            </div>

            {loadingDuplicates && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Scanning contacts…
              </div>
            )}

            {!loadingDuplicates && duplicates.length === 0 && (
              <p className="text-xs text-muted-foreground/70 leading-relaxed">
                No duplicate contacts found. Winston automatically scans your saved people for similar names and helps you combine them.
              </p>
            )}

            {!loadingDuplicates && duplicates.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground/70 mb-2">
                  {duplicates.length} duplicate {duplicates.length === 1 ? "pair" : "groups"} found. Review and merge each one.
                </p>
                {duplicates.map((group) => (
                  <div
                    key={group.suggestedMerge.keepId}
                    className="rounded-xl border border-white/8 bg-white/3 p-3 space-y-2.5"
                  >
                    <div className="space-y-1.5">
                      {group.contacts.map((c) => (
                        <div key={c.id} className="flex gap-2">
                          <span className={`text-xs font-medium min-w-0 truncate ${c.id === group.suggestedMerge.keepId ? "text-foreground" : "text-muted-foreground"}`}>
                            {c.name}
                          </span>
                          {c.id === group.suggestedMerge.keepId && (
                            <span className="text-[10px] text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded-full flex-shrink-0">keep</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="text-[11px] text-muted-foreground/60 leading-relaxed bg-black/20 rounded-lg p-2 font-mono">
                      {group.suggestedMerge.detail || "No details to merge"}
                    </div>
                    <Button
                      onClick={() => void mergeDuplicate(group)}
                      disabled={mergingId === group.suggestedMerge.keepId}
                      size="sm"
                      className="w-full h-8 text-xs gap-1.5"
                    >
                      {mergingId === group.suggestedMerge.keepId
                        ? <><Loader2 className="h-3 w-3 animate-spin" />Merging…</>
                        : <><GitMerge className="h-3 w-3" />Merge into {group.suggestedMerge.name}</>
                      }
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {mergeError && (
              <p className="text-xs text-red-400/80 mt-2">{mergeError}</p>
            )}
            {mergedIds.size > 0 && duplicates.length === 0 && (
              <p className="text-xs text-green-400/80 mt-2 flex items-center gap-1">
                <Check className="h-3 w-3" />All duplicates merged
              </p>
            )}
          </section>

          <div className="border-t border-white/8" />

          {/* ── Section 4: Avatar ────────────────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <Camera className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Your Avatar</h3>
            </div>

            <div className="flex items-start gap-4 mb-4">
              <AvatarPreview
                avatarBase64={displayAvatarBase64}
                googlePhotoUrl={googlePhotoUrl}
                fullName={userFullName}
                size={64}
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                  {currentAvatarBase64
                    ? "Custom photo active — shown in the header."
                    : googlePhotoUrl
                    ? "Using your Google profile photo. Upload a custom photo to override it."
                    : "Upload any photo — a portrait, a favourite image, anything you like. (Max 2 MB)"}
                </p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-white/15 bg-white/5 text-foreground/80 hover:bg-white/10 hover:border-white/25 transition-colors"
                  >
                    <Upload className="h-3 w-3" />
                    {currentAvatarBase64 ? "Replace photo" : "Upload photo"}
                  </button>
                  {currentAvatarBase64 && (
                    <button
                      onClick={() => void removeCustomPhoto()}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-red-500/20 bg-red-950/20 text-red-400/80 hover:bg-red-950/40 hover:border-red-500/30 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFileSelect}
            />

            {pendingAvatarDataUrl && (
              <div className="mt-3 p-3 bg-white/5 border border-white/10 rounded-xl">
                <p className="text-xs text-muted-foreground mb-2">Preview — looks good?</p>
                <div className="flex items-center gap-3">
                  <img
                    src={pendingAvatarDataUrl}
                    alt="Preview"
                    style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover", border: "2px solid rgba(217,119,6,0.4)" }}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="h-8 text-xs px-3"
                      onClick={() => void savePhoto()}
                      disabled={savingPhoto}
                    >
                      {savingPhoto ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save photo"}
                    </Button>
                    <button
                      onClick={() => setPendingAvatarDataUrl(null)}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {photoError && <p className="text-xs text-red-400/80 mt-2">{photoError}</p>}
              </div>
            )}
            {photoError && !pendingAvatarDataUrl && (
              <p className="text-xs text-red-400/80 mt-2">{photoError}</p>
            )}
          </section>

          <div className="border-t border-white/8" />

          {/* ── Section 4: Evening Wind-Down ─────────────────────────── */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <Moon className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Evening Check-In</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Each evening at your chosen time, {currentCompanionName} will check in — asking about your day, capturing notes for tomorrow, and inviting a memory.
            </p>

            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-foreground">Enable evening check-in</span>
              <button
                onClick={() => onWinddownChange({ ...winddownSettings, enabled: !winddownSettings.enabled })}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${winddownSettings.enabled ? "bg-primary" : "bg-white/10"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${winddownSettings.enabled ? "translate-x-5" : "translate-x-0"}`} />
              </button>
            </div>

            <div className="mb-4">
              <label className="text-xs text-muted-foreground block mb-2">Start time (Central Time)</label>
              <input
                type="time"
                value={localTime}
                onChange={(e) => onLocalTimeChange(e.target.value)}
                disabled={!winddownSettings.enabled}
                className="w-full bg-input border border-border rounded-xl px-4 py-3 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-40 transition-opacity"
              />
            </div>

            <Button
              className="w-full h-9 text-sm"
              onClick={() => void onWinddownSave()}
              disabled={settingsSaving}
            >
              {settingsSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {settingsSaving ? "Saving…" : "Save check-in settings"}
            </Button>
          </section>

          {/* ── Section 5: Notifications ─────────────────────────────── */}
          {isNotificationsSupported() && (
            <>
              <div className="border-t border-white/8" />
              <section className="pb-4">
                <div className="flex items-center gap-2 mb-4">
                  <div className="p-1.5 rounded-lg bg-primary/15">
                    <Bell className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">Push Notifications</h3>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 pr-4">
                    <p className="text-sm text-foreground">
                      {notif.permission === "denied"
                        ? "Blocked in browser"
                        : notif.isSubscribed
                        ? "Active"
                        : "Not registered"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {notif.permission === "denied"
                        ? "Reset in your browser settings to re-enable"
                        : notif.isSubscribed
                        ? `${currentCompanionName} can reach you for reminders and updates`
                        : "Tap to allow reminders, alerts, and morning briefings"}
                    </p>
                  </div>
                  <button
                    onClick={() => void notif.resubscribe()}
                    disabled={notif.isLoading || notif.permission === "denied"}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-full border transition-colors whitespace-nowrap border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {notif.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
                    {notif.isSubscribed ? "Re-register" : "Enable"}
                  </button>
                </div>
              </section>
            </>
          )}

          {/* ── Section 6: Connected Services ───────────────────────── */}
          <div className="border-t border-white/8" />
          <section className="pb-4">
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 rounded-lg bg-primary/15">
                <Link2 className="h-3.5 w-3.5 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Connected Services</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Connect services to give {currentCompanionName} access to your calendar, email, and contacts for morning briefings and scheduling.
            </p>

            <div className="space-y-3">

              {/* Google */}
              <div className="rounded-xl border border-white/8 bg-white/3 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Mail className="h-3.5 w-3.5 text-white/70" />
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium">Google</p>
                      <p className="text-xs text-muted-foreground">Gmail &amp; Calendar</p>
                    </div>
                  </div>
                  {googleStatus.loading ? (
                    <span className="text-xs text-muted-foreground/40 font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10 flex items-center gap-1">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />Checking…
                    </span>
                  ) : googleStatus.connected ? (
                    <span className="text-xs text-green-400 font-medium px-2 py-0.5 rounded-full bg-green-400/10 border border-green-400/20">Connected</span>
                  ) : (
                    <span className="text-xs text-muted-foreground/60 font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10">Not connected</span>
                  )}
                </div>
                {!googleStatus.loading && googleStatus.connected ? (
                  <div className="space-y-2">
                    {googleStatus.email && (
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3 text-green-400 flex-shrink-0" />
                        <p className="text-xs text-muted-foreground truncate">{googleStatus.email}</p>
                      </div>
                    )}
                    <button
                      onClick={async () => {
                        onGoogleDisconnect();
                        await fetchGoogleStatus();
                      }}
                      className="w-full text-xs font-medium px-3 py-2 rounded-lg border border-red-500/20 bg-red-950/20 text-red-400/80 hover:bg-red-950/40 hover:border-red-500/30 transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : !googleStatus.loading ? (
                  <Button
                    className="w-full h-8 text-xs"
                    disabled={googleConnecting}
                    onClick={() => {
                      setGoogleConnecting(true);
                      onGoogleConnect();

                      // Reset the spinner when the popup closes or postMessage arrives.
                      // Without this the button stays stuck in "Opening Google…" forever.
                      const safetyTimer = setTimeout(() => {
                        setGoogleConnecting(false);
                        void fetchGoogleStatus();
                      }, 30_000);

                      const onMsg = (e: MessageEvent) => {
                        if (e.data === "google-connected" || e.data === "google-auth-error") {
                          clearTimeout(safetyTimer);
                          window.removeEventListener("message", onMsg);
                          setGoogleConnecting(false);
                          void fetchGoogleStatus();
                        }
                      };
                      window.addEventListener("message", onMsg);
                    }}
                  >
                    {googleConnecting ? (
                      <><Loader2 className="h-3 w-3 animate-spin mr-1.5" />Opening Google…</>
                    ) : (
                      "Connect Gmail \u0026 Calendar"
                    )}
                  </Button>
                ) : null}
              </div>

              {/* Microsoft */}
              <div className={`rounded-xl border p-4 transition-colors ${providers.microsoft ? "border-white/8 bg-white/3" : "border-white/5 bg-white/2 opacity-50"}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 21 21" className="h-3.5 w-3.5" fill="none">
                        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium">Microsoft</p>
                      <p className="text-xs text-muted-foreground">Outlook Calendar &amp; Mail</p>
                    </div>
                  </div>
                  {providers.microsoft ? (
                    <span className="text-xs text-muted-foreground/60 font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10">Not connected</span>
                  ) : (
                    <span className="text-xs text-muted-foreground/40 font-medium px-2 py-0.5 rounded-full bg-white/3 border border-white/8">Coming soon</span>
                  )}
                </div>
                {providers.microsoft ? (
                  <Button
                    className="w-full h-8 text-xs"
                    onClick={() => { window.location.href = `${CHAT_BASE}/api/auth/microsoft`; }}
                  >
                    Connect Microsoft
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground/50">Configure Microsoft OAuth credentials to enable.</p>
                )}
              </div>

              {/* Apple */}
              <div className={`rounded-xl border p-4 transition-colors ${providers.apple ? "border-white/8 bg-white/3" : "border-white/5 bg-white/2 opacity-50"}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-white/70">
                        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium">Apple</p>
                      <p className="text-xs text-muted-foreground">Sign In with Apple</p>
                    </div>
                  </div>
                  {providers.apple ? (
                    <span className="text-xs text-muted-foreground/60 font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10">Not connected</span>
                  ) : (
                    <span className="text-xs text-muted-foreground/40 font-medium px-2 py-0.5 rounded-full bg-white/3 border border-white/8">Coming soon</span>
                  )}
                </div>
                {providers.apple ? (
                  <Button
                    className="w-full h-8 text-xs"
                    onClick={() => { window.location.href = `${CHAT_BASE}/api/auth/apple`; }}
                  >
                    Sign In with Apple
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground/50">Configure Apple Developer credentials to enable.</p>
                )}
              </div>

              {/* Garmin */}
              <div className="rounded-xl border border-white/8 bg-white/3 p-4 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-[#007DC5]/20 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-[#007DC5]" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-foreground font-medium">Garmin Connect</p>
                      <p className="text-xs text-muted-foreground">Sleep, steps, heart rate & workouts</p>
                    </div>
                  </div>
                  {garminConnected ? (
                    <span className="text-xs text-green-400 font-medium px-2 py-0.5 rounded-full bg-green-400/10 border border-green-400/20">Connected</span>
                  ) : (
                    <span className="text-xs text-muted-foreground/60 font-medium px-2 py-0.5 rounded-full bg-white/5 border border-white/10">Not connected</span>
                  )}
                </div>

                {garminConnected ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Connected as <span className="text-foreground/80">{garminEmail}</span>
                      {garminLastSync ? ` · Last synced ${new Date(garminLastSync).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : " · Syncing daily at 6 AM"}
                    </p>
                    <Button
                      variant="outline"
                      className="w-full h-8 text-xs text-red-400 border-red-400/20 hover:bg-red-400/10"
                      onClick={handleGarminDisconnect}
                    >
                      Disconnect Garmin
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground mb-2">
                      Enter your Garmin Connect credentials to share health data with {currentCompanionName}.
                    </p>
                    <input
                      type="email"
                      placeholder="Garmin Connect email"
                      value={garminFormEmail}
                      onChange={(e) => setGarminFormEmail(e.target.value)}
                      className="w-full h-8 px-3 text-xs rounded-lg bg-white/5 border border-white/10 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-white/20"
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={garminFormPassword}
                      onChange={(e) => setGarminFormPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleGarminConnect(); }}
                      className="w-full h-8 px-3 text-xs rounded-lg bg-white/5 border border-white/10 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-white/20"
                    />
                    {garminError && (
                      <p className="text-xs text-red-400">{garminError}</p>
                    )}
                    <Button
                      className="w-full h-8 text-xs"
                      onClick={handleGarminConnect}
                      disabled={garminConnecting || !garminFormEmail || !garminFormPassword}
                    >
                      {garminConnecting ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
                      {garminConnecting ? "Connecting…" : "Connect Garmin"}
                    </Button>
                  </div>
                )}
              </div>

            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
