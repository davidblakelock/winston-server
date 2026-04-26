import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Plus, X, Tv, UtensilsCrossed } from "lucide-react";
import { useLocation } from "wouter";

const API = import.meta.env.BASE_URL.replace(/\/$/, "");

interface ListItem {
  id: number;
  item_text: string;
  detail?: string | null;
  status?: string | null;
  created_at: string;
}

type Tab = "shopping" | "to do" | "tv-shows" | "restaurants";

const TAB_CONFIG: { key: Tab; label: string; readOnly: boolean; emptyText: string }[] = [
  { key: "shopping",    label: "Shopping",    readOnly: false, emptyText: "Shopping list is empty." },
  { key: "to do",      label: "To Do",       readOnly: false, emptyText: "No to-dos yet." },
  { key: "tv-shows",   label: "TV Shows",    readOnly: true,  emptyText: "No shows on your watch list." },
  { key: "restaurants",label: "Restaurants", readOnly: true,  emptyText: "No restaurants saved yet." },
];

function apiPath(tab: Tab): string {
  if (tab === "tv-shows") return `${API}/api/lists/tv-shows`;
  if (tab === "restaurants") return `${API}/api/lists/restaurants`;
  return `${API}/api/lists/${encodeURIComponent(tab)}`;
}

function deletePath(tab: Tab, id: number): string {
  if (tab === "tv-shows") return `${API}/api/lists/tv-shows/${id}`;
  if (tab === "restaurants") return `${API}/api/lists/restaurants/${id}`;
  return `${API}/api/lists/${encodeURIComponent(tab)}/${id}`;
}

export default function Lists() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("shopping");
  const [itemsByTab, setItemsByTab] = useState<Record<Tab, ListItem[] | null>>({
    "shopping": null,
    "to do": null,
    "tv-shows": null,
    "restaurants": null,
  });
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem("winston_session_token") ?? "";
  const tabCfg = TAB_CONFIG.find((t) => t.key === activeTab)!;
  const items = itemsByTab[activeTab] ?? [];

  async function fetchItems(tab: Tab) {
    setLoading(true);
    try {
      const res = await fetch(apiPath(tab), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as { items: ListItem[] };
      setItemsByTab((prev) => ({ ...prev, [tab]: data.items ?? [] }));
    } catch {
      setItemsByTab((prev) => ({ ...prev, [tab]: [] }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (itemsByTab[activeTab] === null) {
      void fetchItems(activeTab);
    } else {
      setLoading(false);
    }
    setInputValue("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function handleAdd() {
    const text = inputValue.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const res = await fetch(apiPath(activeTab), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ item: text }),
      });
      const data = await res.json() as { item: ListItem };
      setItemsByTab((prev) => ({
        ...prev,
        [activeTab]: [...(prev[activeTab] ?? []), data.item],
      }));
      setInputValue("");
      inputRef.current?.focus();
    } catch (err) {
      console.error("List add failed:", err);
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(tab: Tab, id: number) {
    setItemsByTab((prev) => ({
      ...prev,
      [tab]: (prev[tab] ?? []).filter((i) => i.id !== id),
    }));
    try {
      await fetch(deletePath(tab, id), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      void fetchItems(tab);
    }
  }

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
      <div className="flex-shrink-0 flex border-b border-white/5 px-4 sm:px-6 pt-3 gap-1 overflow-x-auto">
        {TAB_CONFIG.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === tab.key
                ? "text-foreground border-amber-500/70 bg-white/5"
                : "text-muted-foreground border-transparent hover:text-foreground hover:bg-white/5"
            }`}
          >
            {tab.key === "tv-shows" && <Tv className="h-3.5 w-3.5" />}
            {tab.key === "restaurants" && <UtensilsCrossed className="h-3.5 w-3.5" />}
            {tab.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        {loading ? (
          <p className="text-sm text-muted-foreground text-center pt-12">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center pt-12">{tabCfg.emptyText}</p>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.06] transition-colors group"
              >
                {/* Checkbox — only on editable lists; checking removes the item */}
                {!tabCfg.readOnly && (
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border border-white/20 bg-transparent accent-amber-500 cursor-pointer flex-shrink-0"
                    onChange={() => void handleDelete(activeTab, item.id)}
                  />
                )}

                {/* Text + optional subtitle */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground/90 truncate">{item.item_text}</p>
                  {item.detail && (
                    <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{item.detail}</p>
                  )}
                </div>

                {/* Status badge for TV shows (Ended / Running) */}
                {item.status && item.status !== "Running" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-white/10 text-muted-foreground/50 flex-shrink-0">
                    {item.status}
                  </span>
                )}

                {/* Delete button */}
                <button
                  onClick={() => void handleDelete(activeTab, item.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all p-1 rounded flex-shrink-0"
                  title="Remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add input — only for editable lists (Shopping, To Do) */}
      {!tabCfg.readOnly && (
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
      )}

      {/* Footer note for read-only tabs */}
      {tabCfg.readOnly && (
        <div className="flex-shrink-0 border-t border-white/5 px-4 sm:px-6 py-3">
          <p className="text-xs text-muted-foreground/40 text-center">
            {activeTab === "tv-shows"
              ? `Ask Winston to add or remove shows`
              : `Ask Winston to add or remove restaurants`}
          </p>
        </div>
      )}
    </div>
  );
}
