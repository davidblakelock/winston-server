import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from "react";
import { Send, Play, Loader2, Disc3 } from "lucide-react";
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
}

interface ReminderEvent {
  id: number;
  userName: string;
  reminderText: string;
  speakText: string;
}

function useBrowserTTS() {
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
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
          v.name.includes("Alex") ||
          v.name.includes("Male"))
    );
    if (preferred) utterance.voice = preferred;

    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      setSpeaking(false);
      onEnd?.();
    };
    utterance.onerror = () => {
      setSpeaking(false);
      onEnd?.();
    };

    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, []);

  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { speak, stop, speaking };
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hello, David. What's on your mind?",
    },
  ]);
  const [input, setInput] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendMessageMutation = useSendMessage();
  const ttsMutation = useTextToSpeech();
  const browserTTS = useBrowserTTS();

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

  const playElevenLabsAudio = useCallback(
    (messageId: string, base64: string, mimeType = "audio/mpeg") => {
      audioRef.current?.pause();
      if (playingId === messageId) {
        setPlayingId(null);
        return;
      }
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
      if (playingId === messageId && browserTTS.speaking) {
        browserTTS.stop();
        setPlayingId(null);
        return;
      }
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
          onError: () => {
            playBrowserTTS(messageId, text);
          },
        }
      );
    },
    [ttsMutation, playElevenLabsAudio, playBrowserTTS]
  );

  const handlePlay = useCallback(
    (msg: Message) => {
      if (msg.audioBase64) {
        playElevenLabsAudio(msg.id, msg.audioBase64, msg.mimeType);
      } else {
        playBrowserTTS(msg.id, msg.content);
      }
    },
    [playElevenLabsAudio, playBrowserTTS]
  );

  const fireReminderAlert = useCallback(
    (event: ReminderEvent) => {
      const msgId = `reminder-${event.id}-${Date.now()}`;
      const displayContent = `Hey David — your reminder: ${event.reminderText}`;

      const reminderMsg: Message = {
        id: msgId,
        role: "assistant",
        content: displayContent,
        isReminder: true,
      };

      setMessages((prev) => [...prev, reminderMsg]);
      speakReply(msgId, event.speakText);
    },
    [speakReply]
  );

  useEffect(() => {
    const es = new EventSource("/api/reminders/stream");

    es.addEventListener("reminder", (e) => {
      try {
        const data = JSON.parse(e.data) as ReminderEvent;
        fireReminderAlert(data);
      } catch {
      }
    });

    es.onerror = () => {
      setTimeout(() => {}, 3000);
    };

    return () => {
      es.close();
    };
  }, [fireReminderAlert]);

  const submitMessage = () => {
    if (!input.trim() || sendMessageMutation.isPending) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    const historyForApi = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    sendMessageMutation.mutate(
      { data: { message: userMsg.content, history: historyForApi } },
      {
        onSuccess: (data) => {
          const assistantMsgId = (Date.now() + 1).toString();
          const assistantMsg: Message = {
            id: assistantMsgId,
            role: "assistant",
            content: data.reply,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          speakReply(assistantMsgId, data.reply);
        },
      }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  return (
    <div className="flex flex-col h-[100dvh] max-w-4xl mx-auto overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/5 py-4 px-6 flex items-center justify-center gap-4 bg-background/80 backdrop-blur-sm z-10 sticky top-0">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 border border-primary/20 bg-card">
            <AvatarFallback className="bg-card text-primary font-serif font-medium text-lg">EP</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-xl font-serif font-medium text-foreground tracking-wide">Emma Peel</h1>
            <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase">Always Here</p>
          </div>
        </div>
      </header>

      {/* Chat Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 sm:p-6 pb-24 sm:pb-32 space-y-8"
      >
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
                  : "bg-card border border-white/5 text-card-foreground rounded-bl-sm"
              }`}
            >
              {msg.isReminder && (
                <p className="text-[11px] font-semibold tracking-widest uppercase text-primary/70 mb-2">
                  Reminder
                </p>
              )}
              <div className="whitespace-pre-wrap font-sans">{msg.content}</div>

              {msg.role === "assistant" && (
                <div className="mt-4 pt-3 border-t border-white/5 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 rounded-full transition-colors ${
                      playingId === msg.id
                        ? "bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary"
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

        {sendMessageMutation.isPending && (
          <div className="flex flex-col items-start animate-in fade-in">
            <div className="max-w-[85%] rounded-2xl p-5 bg-card border border-white/5 rounded-bl-sm flex items-center gap-1.5 h-[60px]">
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]"></div>
              <div className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce"></div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 p-4 sm:p-6 bg-gradient-to-t from-background via-background to-transparent pt-12 absolute bottom-0 w-full max-w-4xl">
        <div className="relative group">
          <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-primary/10 via-primary/5 to-transparent blur opacity-50 group-focus-within:opacity-100 transition-opacity duration-500"></div>
          <div className="relative flex items-end gap-3 bg-input border border-border rounded-2xl p-2 sm:p-3 shadow-lg focus-within:ring-1 focus-within:ring-primary/30 transition-all duration-300">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Share your thoughts..."
              className="min-h-[44px] max-h-[200px] border-0 focus-visible:ring-0 resize-none bg-transparent py-3 px-3 text-[15px] placeholder:text-muted-foreground/60 scrollbar-none font-sans"
              rows={1}
              data-testid="input-message"
            />
            <Button
              onClick={submitMessage}
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
