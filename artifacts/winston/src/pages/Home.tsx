export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="max-w-2xl mx-auto px-6 w-full flex flex-col flex-1">
        <header className="py-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
              <span className="text-base font-bold text-white tracking-tight">W</span>
            </div>
            <span className="text-lg font-semibold text-zinc-100">Winston</span>
          </div>
          <a
            href="/"
            className="text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Open App
          </a>
        </header>

        <main className="flex-1 flex flex-col justify-center py-20">
          <div className="mb-6">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-950 border border-indigo-800 text-indigo-300 text-xs font-medium mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
              Personal AI Companion
            </div>
            <h1 className="text-5xl font-bold text-white leading-tight mb-6">
              Meet Winston,<br />
              <span className="text-indigo-400">your personal companion.</span>
            </h1>
            <p className="text-zinc-400 text-lg leading-relaxed max-w-lg">
              Winston is a private AI companion that learns your routines, manages your day,
              and keeps you informed — through conversation that feels natural.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 mt-12 sm:grid-cols-2">
            {[
              {
                icon: "📅",
                title: "Calendar awareness",
                desc: "Knows your schedule and sends departure alerts before meetings.",
              },
              {
                icon: "📬",
                title: "Morning briefings",
                desc: "Summarizes your emails, weather, and news every morning.",
              },
              {
                icon: "🔔",
                title: "Smart reminders",
                desc: "Medications, bills, birthdays — Winston keeps track so you don't have to.",
              },
              {
                icon: "💬",
                title: "Natural conversation",
                desc: "Ask anything, anytime. Winston remembers context across your conversations.",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800"
              >
                <div className="text-2xl mb-3">{feature.icon}</div>
                <div className="font-semibold text-zinc-100 mb-1">{feature.title}</div>
                <div className="text-sm text-zinc-400 leading-relaxed">{feature.desc}</div>
              </div>
            ))}
          </div>
        </main>

        <footer className="py-8 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-500">
          <span>© 2026 Winston</span>
          <div className="flex gap-4">
            <a href="/privacy" className="hover:text-zinc-300 transition-colors">Privacy Policy</a>
            <a href="/terms" className="hover:text-zinc-300 transition-colors">Terms of Service</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
