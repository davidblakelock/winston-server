import { useState, useRef, useCallback } from "react";

interface Story {
  id: number;
  promptQuestion: string;
  response: string;
  capturedAt: string;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    timeZone: "America/Chicago",
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  background: "#faf8f4",
  minHeight: "100vh",
  fontFamily: "Georgia, 'Times New Roman', serif",
  color: "#2c1810",
};

const containerStyle: React.CSSProperties = {
  maxWidth: "740px",
  margin: "0 auto",
  padding: "60px 40px 100px",
};

const titleStyle: React.CSSProperties = {
  fontSize: "2.6rem",
  fontWeight: "400",
  letterSpacing: "0.04em",
  color: "#2c1810",
  marginBottom: "6px",
  lineHeight: "1.2",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "1rem",
  color: "#8b6347",
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  marginBottom: "36px",
  fontFamily: "'Georgia', serif",
};

const dividerStyle: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #d4b896",
  margin: "36px 0",
};

const introStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  lineHeight: "1.85",
  color: "#4a2e1a",
  fontStyle: "italic",
  marginBottom: "12px",
};

const countStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#8b6347",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginTop: "28px",
};

const storyCardStyle: React.CSSProperties = {
  marginBottom: "64px",
  pageBreakInside: "avoid",
};

const storyDateStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: "#8b6347",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  marginBottom: "10px",
  fontFamily: "Georgia, serif",
};

const promptStyle: React.CSSProperties = {
  fontSize: "1.15rem",
  fontStyle: "italic",
  color: "#5d3d25",
  marginBottom: "20px",
  lineHeight: "1.6",
  borderLeft: "3px solid #c4956a",
  paddingLeft: "16px",
};

const responseStyle: React.CSSProperties = {
  fontSize: "1.05rem",
  lineHeight: "1.9",
  color: "#2c1810",
  whiteSpace: "pre-wrap",
};

const footerStyle: React.CSSProperties = {
  textAlign: "center",
  color: "#a87d5a",
  fontSize: "0.88rem",
  marginTop: "80px",
  fontStyle: "italic",
  lineHeight: "1.7",
};

const printBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  padding: "10px 24px",
  background: "#c4956a",
  color: "#faf8f4",
  border: "none",
  borderRadius: "4px",
  fontSize: "0.85rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  cursor: "pointer",
  fontFamily: "Georgia, serif",
};

// ── Password Gate ─────────────────────────────────────────────────────────────

function PasswordGate({ onSuccess }: { onSuccess: (pwd: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(false);

    try {
      const res = await fetch(`${BASE}/api/stories/archive?password=${encodeURIComponent(value)}`);
      if (res.ok) {
        onSuccess(value);
      } else {
        setError(true);
        setValue("");
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#faf8f4",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Georgia, 'Times New Roman', serif",
        padding: "40px 20px",
      }}
    >
      <div
        style={{
          maxWidth: "400px",
          width: "100%",
          textAlign: "center",
        }}
      >
        {/* Ornament */}
        <div style={{ color: "#c4956a", fontSize: "2rem", marginBottom: "24px", letterSpacing: "0.3em" }}>
          ✦ ✦ ✦
        </div>

        <h1 style={{ ...titleStyle, fontSize: "2rem", marginBottom: "8px" }}>
          Memories from Dad
        </h1>
        <p style={{ color: "#8b6347", fontSize: "0.85rem", letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: "40px" }}>
          A Private Memory Book for Olivia
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "16px" }}>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              autoFocus
              style={{
                width: "100%",
                padding: "14px 20px",
                border: `1px solid ${error ? "#c0392b" : "#d4b896"}`,
                borderRadius: "4px",
                background: "#fff",
                fontSize: "1rem",
                fontFamily: "Georgia, serif",
                color: "#2c1810",
                outline: "none",
                boxSizing: "border-box",
                textAlign: "center",
                letterSpacing: "0.2em",
              }}
            />
            {error && (
              <p style={{ color: "#c0392b", fontSize: "0.82rem", marginTop: "8px", fontStyle: "italic" }}>
                That password isn't quite right. Try again.
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={loading || !value.trim()}
            style={{
              ...printBtnStyle,
              width: "100%",
              justifyContent: "center",
              opacity: loading || !value.trim() ? 0.6 : 1,
            }}
          >
            {loading ? "Opening…" : "Open Memory Book"}
          </button>
        </form>

        <p style={{ color: "#a87d5a", fontSize: "0.78rem", marginTop: "32px", fontStyle: "italic" }}>
          This is a private collection shared with love.
        </p>
      </div>
    </div>
  );
}

// ── Archive View ──────────────────────────────────────────────────────────────

function ArchiveView({ stories, companionName, displayName }: { stories: Story[]; companionName: string | null; displayName: string | null }) {
  const companion = companionName ?? "their AI companion";
  const authorName = displayName ?? "your dad";
  const printRef = useRef<HTMLDivElement>(null);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const firstYear = stories.length > 0
    ? new Date(stories[0].capturedAt).getFullYear()
    : new Date().getFullYear();

  const lastYear = stories.length > 0
    ? new Date(stories[stories.length - 1].capturedAt).getFullYear()
    : new Date().getFullYear();

  const yearRange = firstYear === lastYear ? `${firstYear}` : `${firstYear}–${lastYear}`;

  return (
    <>
      {/* Print-specific global styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
          .story-card { page-break-inside: avoid; }
          @page {
            margin: 1.4in 1.2in;
            size: letter;
          }
        }
        @media screen {
          .olivia-page a { color: #8b6347; }
        }
      `}</style>

      <div ref={printRef} style={pageStyle} className="olivia-page">
        <div style={containerStyle}>

          {/* ── Header ── */}
          <div style={{ marginBottom: "8px" }}>
            <div style={{ color: "#c4956a", fontSize: "1.1rem", letterSpacing: "0.4em", marginBottom: "20px" }}>
              ✦ ✦ ✦
            </div>
            <h1 style={titleStyle}>Memories from Dad</h1>
            <p style={subtitleStyle}>A Memory Book for Olivia · {yearRange}</p>
          </div>

          <hr style={dividerStyle} />

          {/* ── Introduction ── */}
          <p style={introStyle}>
            These are stories and memories {authorName} chose to share — one evening at a time —
            with their AI companion {companion}. Each one was captured in response to a gentle question,
            and every word is their own. Together they form a portrait of a life, told in their voice,
            preserved for you.
          </p>
          <p style={{ ...introStyle, marginBottom: "0" }}>
            Read them slowly. They were written with love.
          </p>

          {stories.length > 0 && (
            <p style={countStyle}>
              {stories.length} {stories.length === 1 ? "memory" : "memories"} captured
              {stories.length > 1 && ` · ${formatDateShort(stories[0].capturedAt)} through ${formatDateShort(stories[stories.length - 1].capturedAt)}`}
            </p>
          )}

          {/* ── Print Button ── */}
          <div className="no-print" style={{ marginTop: "32px" }}>
            <button onClick={handlePrint} style={printBtnStyle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9"></polyline>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                <rect x="6" y="14" width="12" height="8"></rect>
              </svg>
              Save as PDF / Print
            </button>
          </div>

          <hr style={{ ...dividerStyle, marginTop: "48px" }} />

          {/* ── Empty State ── */}
          {stories.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 0", color: "#8b6347" }}>
              <p style={{ fontSize: "1.1rem", fontStyle: "italic" }}>
                No memories have been captured yet.
              </p>
              <p style={{ fontSize: "0.9rem", marginTop: "12px" }}>
                Stories will appear here as {authorName} shares them during evening conversations with {companion}.
              </p>
            </div>
          )}

          {/* ── Stories ── */}
          {stories.map((story, index) => (
            <div key={story.id} style={storyCardStyle} className="story-card">

              {/* Story number + date */}
              <div style={storyDateStyle}>
                Memory {index + 1} &nbsp;·&nbsp; {formatDate(story.capturedAt)}
              </div>

              {/* Prompt question */}
              <div style={promptStyle}>
                "{story.promptQuestion}"
              </div>

              {/* Response */}
              <div style={responseStyle}>
                {story.response}
              </div>

              {/* Divider between stories */}
              {index < stories.length - 1 && (
                <div style={{ textAlign: "center", margin: "56px 0 0", color: "#c4956a", letterSpacing: "0.5em", fontSize: "0.75rem" }}>
                  ✦
                </div>
              )}
            </div>
          ))}

          {/* ── Footer ── */}
          {stories.length > 0 && (
            <div style={footerStyle}>
              <div style={{ color: "#c4956a", letterSpacing: "0.3em", marginBottom: "16px" }}>✦ ✦ ✦</div>
              <p>
                These memories were captured between {formatDate(stories[0].capturedAt)}
                {stories.length > 1 && ` and ${formatDate(stories[stories.length - 1].capturedAt)}`}.
              </p>
              <p style={{ marginTop: "8px" }}>
                Written by {authorName}, with a little help from {companion}.
              </p>
              <p style={{ marginTop: "8px", fontSize: "0.78rem", color: "#b89070" }}>
                For Olivia — always.
              </p>
            </div>
          )}

        </div>
      </div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function OliviaArchive() {
  const [password, setPassword] = useState<string | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [companionName, setCompanionName] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  async function handlePasswordSuccess(pwd: string) {
    setLoading(true);
    setLoadError(false);

    try {
      const res = await fetch(`${BASE}/api/stories/archive?password=${encodeURIComponent(pwd)}`);
      if (res.ok) {
        const data = await res.json() as { stories: Story[]; companionName: string | null; displayName: string | null };
        setStories(data.stories);
        setCompanionName(data.companionName ?? null);
        setDisplayName(data.displayName ?? null);
        setPassword(pwd);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p style={{ color: "#8b6347", fontStyle: "italic" }}>Opening your memory book…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", flexDirection: "column", gap: "16px" }}>
        <p style={{ color: "#c0392b", fontStyle: "italic" }}>Something went wrong loading the memory book.</p>
        <button style={{ ...printBtnStyle, background: "#8b6347" }} onClick={() => setLoadError(false)}>
          Try Again
        </button>
      </div>
    );
  }

  if (!password) {
    return <PasswordGate onSuccess={handlePasswordSuccess} />;
  }

  return <ArchiveView stories={stories} companionName={companionName} displayName={displayName} />;
}
