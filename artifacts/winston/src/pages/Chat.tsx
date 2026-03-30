import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from "react";
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
  isPlaying?: boolean;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Good evening. What's on your mind tonight?",
    },
  ]);
  const [input, setInput] = useState("");
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendMessageMutation = useSendMessage();
  const ttsMutation = useTextToSpeech();

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, sendMessageMutation.isPending]);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const handlePlayAudio = (messageId: string, base64: string, mimeType: string = "audio/mpeg") => {
    if (audioRef.current) {
      audioRef.current.pause();
      if (playingAudioId === messageId) {
        setPlayingAudioId(null);
        return;
      }
    }

    const audioUrl = `data:${mimeType};base64,${base64}`;
    const audio = new Audio(audioUrl);
    
    audio.onended = () => {
      setPlayingAudioId(null);
    };
    
    audio.onerror = () => {
      setPlayingAudioId(null);
      console.error("Error playing audio");
    };

    audioRef.current = audio;
    audio.play().catch(err => {
      console.error("Playback failed:", err);
      setPlayingAudioId(null);
    });
    setPlayingAudioId(messageId);
  };

  const submitMessage = () => {
    if (!input.trim() || sendMessageMutation.isPending) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    const historyForApi = messages.map(m => ({ role: m.role, content: m.content }));
    
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    sendMessageMutation.mutate(
      {
        data: {
          message: userMsg.content,
          history: historyForApi,
        },
      },
      {
        onSuccess: (data) => {
          const assistantMsgId = Date.now().toString();
          const assistantMsg: Message = {
            id: assistantMsgId,
            role: "assistant",
            content: data.reply,
          };
          
          setMessages((prev) => [...prev, assistantMsg]);

          // Automatically trigger TTS for Winston's reply
          ttsMutation.mutate(
            { data: { text: data.reply } },
            {
              onSuccess: (ttsData) => {
                setMessages((prev) => 
                  prev.map((msg) => 
                    msg.id === assistantMsgId 
                      ? { ...msg, audioBase64: ttsData.audioBase64 } 
                      : msg
                  )
                );
                // Auto-play the newly generated audio
                handlePlayAudio(assistantMsgId, ttsData.audioBase64, ttsData.mimeType);
              },
            }
          );
        },
        onError: () => {
          // Add a temporary error message or handle gracefully
        }
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
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  return (
    <div className="flex flex-col h-[100dvh] max-w-4xl mx-auto overflow-hidden bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/5 py-4 px-6 flex items-center justify-center gap-4 bg-background/80 backdrop-blur-sm z-10 sticky top-0">
        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10 border border-primary/20 bg-card">
            <AvatarFallback className="bg-card text-primary font-serif font-medium text-lg">W</AvatarFallback>
          </Avatar>
          <div>
            <h1 className="text-xl font-serif font-medium text-foreground tracking-wide">Winston</h1>
            <p className="text-xs text-muted-foreground font-medium tracking-widest uppercase">ALWAYS HERE</p>
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
                  : "bg-card border border-white/5 text-card-foreground rounded-bl-sm"
              }`}
            >
              <div className="whitespace-pre-wrap font-sans">{msg.content}</div>
              
              {msg.role === "assistant" && msg.audioBase64 && (
                <div className="mt-4 pt-3 border-t border-white/5 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-8 w-8 rounded-full transition-colors ${
                      playingAudioId === msg.id 
                        ? "bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary" 
                        : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                    }`}
                    onClick={() => handlePlayAudio(msg.id, msg.audioBase64!)}
                    data-testid={`button-play-audio-${msg.id}`}
                  >
                    {playingAudioId === msg.id ? (
                      <Disc3 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 fill-current ml-0.5" />
                    )}
                  </Button>
                  <span className="text-xs text-muted-foreground/70 font-medium">
                    {playingAudioId === msg.id ? "Playing..." : "Listen"}
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
