// app/privacy/page.tsx
import Link from "next/link";

export const metadata = { title: "Privacy Policy — Diract" };

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <Link href="/" className="text-[11px] text-indigo-600 hover:underline mb-8 block">
          ← Back to Diract
        </Link>

        <h1 className="text-3xl font-light tracking-tight text-slate-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-slate-400 mb-10">Diract — Management Central · Last updated: July 2026</p>

        <div className="prose prose-slate prose-sm max-w-none space-y-8">

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Overview</h2>
            <p className="text-slate-600 leading-relaxed">Diract is an internal property and legal management tool operated by Huynh Lawyers. This policy explains how we collect and use information when you use the Diract Gmail Add-on and web application.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Information We Collect</h2>
            <h3 className="text-sm font-medium text-slate-700 mt-3 mb-1">Gmail Data</h3>
            <p className="text-slate-600 leading-relaxed">When you connect your Gmail account to Diract, we access email metadata (subject lines, sender addresses, dates, message IDs), Gmail labels, and email content — but only for emails you explicitly assign to a project. We do not read, store, or process any other emails.</p>
            <h3 className="text-sm font-medium text-slate-700 mt-3 mb-1">Account Information</h3>
            <p className="text-slate-600 leading-relaxed">Your Google account email address and your company membership role within Diract.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">How We Use Your Information</h2>
            <ul className="list-disc list-inside text-slate-600 space-y-1">
              <li>To assign emails to projects and sync labels across your team</li>
              <li>To display project-related emails within the Diract web application</li>
              <li>To allow authorised team members to collaborate on shared projects</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Data Sharing</h2>
            <p className="text-slate-600 leading-relaxed">We do not sell, rent, or share your personal information with third parties. Email data is shared only with other authorised members of your company within Diract.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Data Storage</h2>
            <p className="text-slate-600 leading-relaxed">All data is stored securely in Supabase (PostgreSQL) hosted on AWS infrastructure. Gmail tokens are used solely to perform actions on your behalf and are never shared externally.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Your Rights</h2>
            <p className="text-slate-600 leading-relaxed">You may disconnect your Gmail account from Diract at any time via application settings, request deletion of your data by contacting us, or revoke Diract's Gmail access via <a href="https://myaccount.google.com" className="text-indigo-600 hover:underline">myaccount.google.com</a>.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Google API Services</h2>
            <p className="text-slate-600 leading-relaxed">Diract's use of Google APIs complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-indigo-600 hover:underline">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-800 mb-2">Contact</h2>
            <p className="text-slate-600">For privacy-related enquiries: <a href="mailto:privacy@huynhco.com" className="text-indigo-600 hover:underline">privacy@huynhco.com</a></p>
          </section>

        </div>
      </div>
    </div>
  );
}