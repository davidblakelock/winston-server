export default function Terms() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="flex items-center gap-3 mb-12">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <span className="text-base font-bold text-white tracking-tight">W</span>
          </div>
          <span className="text-lg font-semibold text-zinc-100">Winston</span>
        </div>

        <h1 className="text-3xl font-bold text-white mb-2">Terms of Service</h1>
        <p className="text-zinc-400 text-sm mb-10">Last updated: April 2026</p>

        <div className="space-y-8 text-zinc-300 leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-white mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Winston, you agree to be bound by these Terms of Service.
              Winston is a private personal AI companion application. Access is limited to
              authorized users only.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">2. Description of Service</h2>
            <p>
              Winston is a personal AI companion that integrates with Google services (Calendar,
              Gmail, Contacts, Tasks), provides daily briefings, manages reminders, tracks health
              and fitness data, and delivers personalized AI-driven conversation and assistance.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">3. User Responsibilities</h2>
            <p className="mb-3">You agree to:</p>
            <ul className="list-disc list-inside space-y-2 text-zinc-400">
              <li>Use Winston only for lawful personal purposes</li>
              <li>Not attempt to reverse engineer, modify, or exploit the application</li>
              <li>Keep your login credentials secure and confidential</li>
              <li>Not use Winston to process or store the personal data of others without consent</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">4. Google API Usage</h2>
            <p>
              Winston's access to Google services is governed by Google's Terms of Service.
              Winston uses Google APIs in compliance with the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="text-indigo-400 underline hover:text-indigo-300"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              . You may revoke Winston's access to your Google account at any time through your
              Google account security settings.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">5. AI-Generated Content</h2>
            <p>
              Winston uses AI models (including Anthropic Claude and OpenAI) to generate responses.
              AI-generated content may not always be accurate, complete, or appropriate. You should
              not rely on Winston for medical, legal, financial, or emergency advice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">6. Availability</h2>
            <p>
              Winston is provided on an "as is" and "as available" basis. The developer does not
              guarantee uninterrupted service and may modify, suspend, or discontinue the service
              at any time without notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">7. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, the developer of Winston shall not be liable
              for any indirect, incidental, special, or consequential damages arising from your use
              of or inability to use the service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">8. Changes to Terms</h2>
            <p>
              These Terms may be updated from time to time. Continued use of Winston after changes
              are posted constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white mb-3">9. Contact</h2>
            <p>
              For questions about these Terms, contact{" "}
              <a href="mailto:davidblakelock01@gmail.com" className="text-indigo-400 underline hover:text-indigo-300">
                davidblakelock01@gmail.com
              </a>.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-zinc-800 flex items-center justify-between text-sm text-zinc-500">
          <span>© 2026 Winston</span>
          <a href="/privacy" className="hover:text-zinc-300 transition-colors">Privacy Policy</a>
        </div>
      </div>
    </div>
  );
}
