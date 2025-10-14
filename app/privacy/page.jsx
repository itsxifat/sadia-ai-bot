// app/privacy/page.js
export const metadata = {
  title: "Privacy Policy – Sadia AI",
  description:
    "Privacy Policy for the Sadia AI Messenger chatbot created by Sifat Hosen.",
};

export default function PrivacyPage() {
  return (
    <main style={{maxWidth: 880, margin: "40px auto", padding: "0 16px", lineHeight: 1.65}}>
      <h1 style={{fontSize: 32, marginBottom: 8}}>Privacy Policy</h1>
      <p style={{color:"#555"}}>Last updated: {new Date().toISOString().slice(0,10)}</p>

      <section>
        <h2>Who we are</h2>
        <p>
          <strong>Sadia AI</strong> is a conversational virtual assistant that chats with you on
          Facebook Messenger. It was developed by <strong>Sifat Hosen</strong>.
          This Privacy Policy explains how we handle your data.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li><strong>Message content you send to the Page</strong> (texts you type to the bot).</li>
          <li><strong>Messenger identifiers</strong> (Page-scoped ID provided by Meta so we can reply).</li>
          <li><strong>Technical logs</strong> (timestamps, error logs, basic analytics).</li>
        </ul>
        <p>
          We do <em>not</em> collect phone numbers, emails, or precise location unless you
          voluntarily share them in chat.
        </p>
      </section>

      <section>
        <h2>How we use data</h2>
        <ul>
          <li>To reply in chat and keep the conversation context short-term.</li>
          <li>To improve response quality, safety, and reliability.</li>
          <li>To detect abuse and prevent spam or misuse.</li>
        </ul>
      </section>

      <section>
        <h2>Legal basis</h2>
        <p>
          We rely on your consent and our legitimate interest in providing a safe, useful chat
          experience. If you do not agree, please stop using the bot and message us to delete data.
        </p>
      </section>

      <section>
        <h2>Sharing</h2>
        <p>
          We do <strong>not</strong> sell your personal data. We may share limited data with:
        </p>
        <ul>
          <li>
            <strong>Meta Platforms</strong> (Messenger infrastructure that delivers messages).
          </li>
          <li>
            <strong>AI model provider</strong> (e.g., Google Gemini) to generate replies. Message
            snippets may be processed to produce a response.
          </li>
          <li>
            <strong>Hosting & infrastructure</strong> (e.g., Vercel, Redis Cloud) to operate the
            service.
          </li>
          <li>
            Authorities if required by law, or to protect our rights and users.
          </li>
        </ul>
      </section>

      <section>
        <h2>Retention</h2>
        <p>
          Short conversation summaries and preferences (e.g., your name) may be stored to improve
          chat continuity. We aim to purge or rotate this data periodically (typically within 30–90
          days) and when no longer needed. You can request deletion at any time.
        </p>
      </section>

      <section>
        <h2>Your choices</h2>
        <ul>
          <li>Stop using the bot at any time.</li>
          <li>Request a copy or deletion of your stored data by contacting us.</li>
          <li>Type <code>STOP</code> in chat to opt out of memory going forward.</li>
        </ul>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          The service is intended for users aged <strong>13+</strong>. We do not knowingly collect
          data from children under 13. If you believe a child has provided data, contact us and we
          will delete it.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          We use reasonable technical and organizational measures (HTTPS, access controls). No
          method of transmission or storage is 100% secure.
        </p>
      </section>

      <section>
        <h2>International transfers</h2>
        <p>
          Your data may be processed in countries different from your own due to the nature of cloud
          services. We take steps to protect it consistent with this Policy.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          We may update this Policy. The “Last updated” date will change. Continued use means you
          accept the revised Policy.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          For privacy questions or requests: <a href="mailto:contact.sadia.ai@gmail.com">contact.sadia.ai@gmail.com</a>
        </p>
      </section>
    </main>
  );
}
