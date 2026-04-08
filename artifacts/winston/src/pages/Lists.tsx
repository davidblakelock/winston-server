import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ListItem {
  id: number;
  item_text: string;
  created_at: string;
}

type Tab = "shopping" | "to do";

export default function Lists() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("shopping");
  const [items, setItems] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem("winston_session_token") ?? "";

  async function fetchItems(listName: Tab) {
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/lists/${encodeURIComponent(listName)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { items: ListItem[] };
      setItems(data.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchItems(activeTab);
    setInputValue("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function handleAdd() {
    const text = inputValue.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await fetch(`${API}/api/lists/${encodeURIComponent(activeTab)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ item: text }),
      });
      const data = await res.json() as { item: ListItem };
      setItems((prev) => [...prev, data.item]);
      setInputValue("");
      inputRef.current?.focus();
    } catch(err) {
      console.error("List add failed:", err);
      alert("Failed to save: " + (err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(listName: Tab, id: number) {
    setItems((prev) => prev.filter((i) => i.id !== id));
    try {
      await fetch(`${API}/api/lists/${encodeURIComponent(listName)}/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      void fetchItems(listName);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "shopping", label: "Shopping" },
    { key: "to do", label: "To Do" },
  ];

  return (
    <div className="flex flex-col h-[100dvh] max-w-4xl mx-auto bg-background">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-white/5 py-3 px-4 sm:px-6 flex items-center gap-3 bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <button
          onClick={() => setLocation("/")}
          className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-white/10 border border-white/10 hover:border-white/20"
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-xl font-serif font-medium text-foreground tracking-wide">Lists</h1>
      </header>

      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-white/5 px-4 sm:px-6 pt-3 gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
              activeTab === tab.key
                ? "text-foreground border-amber-500/70 bg-white/5"
                : "text-muted-foreground border-transparent hover:text-foreground hover:bg-white/5"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {loading ? (
          <p className="text-sm text-muted-foreground text-center pt-12">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center pt-12">Nothing here yet.</p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] transition-colors group"
              >
                {/* Checkbox — checking deletes the item */}
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border border-white/20 bg-transparent accent-amber-500 cursor-pointer flex-shrink-0"
                  onChange={() => void handleDelete(activeTab, item.id)}
                />
                <span className="flex-1 text-sm text-foreground/90">{item.item_text}</span>
                {/* Explicit delete button */}
                <button
                  onClick={() => void handleDelete(activeTab, item.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all p-1 rounded"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add input — pinned to bottom */}
      <div className="flex-shrink-0 border-t border-white/5 px-4 sm:px-6 py-4">
        <form
          onSubmit={(e) => { e.preventDefault(); void handleAdd(); }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={`Add to ${activeTab} list…`}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-amber-500/40 focus:bg-white/[0.07] transition-colors"
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || adding}
            className="p-2.5 rounded-xl border border-white/10 bg-white/5 hover:bg-amber-950/40 hover:border-amber-500/30 text-muted-foreground hover:text-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Add item"
          >
            <Plus className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
