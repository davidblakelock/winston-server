export default function Privacy() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="flex items-center gap-3 mb-12">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-bold text-white tracking-tight">W</span>
          </div>
          <span className="text-lg font-semibold text-zinc-100">Winston</span>
        </div>

        <h1 className="text-3xl font-bold text-white mb-2">Privacy Policy</h1>
        <p className="text-zinc-400 text-sm mb-10">Last updated: April 2026</p>

        <div className="space-y-8 text-zinc-300 leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Overview</h2>
            <p>
              Winston is a personal AI companion application. This Privacy Policy describes how Winston
              collects, uses, and protects information when you use the application. Winston is designed
              as a private, single-user tool — your data is used solely to provide and improve your
              personal AI companion experience.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Information We Collect</h2>
            <p className="mb-3">Winston may access the following information when you connect your Google account:</p>
            <ul className="list-disc list-inside space-y-2 text-zinc-400">
              <li>Google Calendar events and schedules</li>
              <li>Gmail messages (read-only, used to summarize important emails)</li>
              <li>Google Contacts (read-only, used to personalize responses)</li>
              <li>Google Tasks (to sync and manage your task lists)</li>
              <li>Basic Google profile information (name, email, profile photo)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">How We Use Your Information</h2>
            <p className="mb-3">Your information is used exclusively to:</p>
            <ul className="list-disc list-inside space-y-2 text-zinc-400">
              <li>Provide personalized AI companion responses</li>
              <li>Deliver morning briefings, calendar reminders, and departure alerts</li>
              <li>Summarize unread emails during daily briefings</li>
              <li>Sync task lists between Winston and Google Tasks</li>
              <li>Improve the relevance and accuracy of your companion's responses</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Data Storage and Security</h2>
            <p>
              Your data is stored securely using Supabase (PostgreSQL). OAuth tokens used to access
              Google services are encrypted and stored server-side. Winston does not sell, rent, or
              share your personal data with any third parties. Google API data is accessed only
              to fulfill the functions described above and is not used for advertising or tracking.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Google API Services</h2>
            <p>
              Winston's use and transfer to any other app of information received from Google APIs
              adheres to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="text-indigo-400 underline hover:text-indigo-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Your Rights and Control</h2>
            <p className="mb-3">You can at any time:</p>
            <ul className="list-disc list-inside space-y-2 text-zinc-400">
              <li>Disconnect your Google account from within the Winston Settings panel</li>
              <li>Revoke Winston's access via your Google account's security settings</li>
              <li>Request deletion of your stored data by contacting the developer</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Third-Party Services</h2>
            <p>
              Winston uses the following third-party services to operate: Anthropic (Claude AI),
              OpenAI (voice and image features), ElevenLabs (voice synthesis), Tomorrow.io (weather),
              Garmin Connect (fitness data), and Supabase (database). Each of these services has
              its own privacy policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">Contact</h2>
            <p>
              For privacy questions or data deletion requests, contact the developer at{" "}
              <a href="mailto:davidblakelock01@gmail.com" className="text-indigo-400 underline hover:text-indigo-300">
                davidblakelock01@gmail.com
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-500">
          <span>© 2026 Winston</span>
          <a href="/terms" className="hover:text-zinc-300 transition-colors">Terms of Service</a>
        </div>
      </div>
    </div>
  );
}
