import { useState, useRef, useCallback, useEffect } from "react";
import {
  X, Volume2, Play, Check, Loader2, User, Camera, Moon, Bell,
  Upload, Trash2, Music2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNotificationsSupported } from "@/hooks/useNotifications";

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
}: SettingsPanelProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState<string | null>(currentVoiceId);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);

  const [nameInput, setNameInput] = useState(currentCompanionName);
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [pendingAvatarDataUrl, setPendingAvatarDataUrl] = useState<string | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedVoiceId(currentVoiceId);
    setNameInput(currentCompanionName);
    setPendingAvatarDataUrl(null);
    setPhotoError(null);
    setNameSaved(false);
  }, [isOpen, currentVoiceId, currentCompanionName]);

  useEffect(() => {
    if (!isOpen || voices.length > 0) return;
    fetch(`${CHAT_BASE}/api/onboarding/voices`)
      .then((r) => r.json())
      .then((d: { voices?: Voice[] }) => { if (d.voices) setVoices(d.voices); })
      .catch(() => {});
  }, [isOpen, voices.length]);

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
                placeholder="e.g. Emma Peel, Alex, James Bond"
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

          {/* ── Section 3: Avatar ────────────────────────────────────── */}
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
              <h3 className="text-sm font-semibold text-foreground">Evening Wind-Down</h3>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Each evening at your chosen time, {currentCompanionName} will check in — asking about your day, capturing notes for tomorrow, and inviting a memory.
            </p>

            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-foreground">Enable evening wind-down</span>
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
              {settingsSaving ? "Saving…" : "Save wind-down settings"}
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

        </div>
      </div>
    </div>
  );
}
