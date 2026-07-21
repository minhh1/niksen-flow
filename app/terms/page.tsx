// app/terms/page.tsx
import Link from "next/link";

export const metadata = { title: "Terms of Service — Diract" };

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-2xl mx-auto px-6 py-16">
        <Link href="/" className="text-[11px] text-indigo-600 hover:underline mb-8 block">
          ← Back to Diract
        </Link>

        <h1 className="text-3xl font-light tracking-tight text-slate-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-slate-400 mb-10">Diract — Management Central · Last updated: July 2026</p>

        <div className="space-y-8 text-slate-600 text-sm leading-relaxed">

          {[
            { title: "1. Acceptance of Terms", body: "By accessing or using the Diract application, including the Gmail Add-on, you agree to be bound by these Terms of Service. If you do not agree, do not use the App." },
            { title: "2. Eligibility", body: "The App is intended for use by authorised employees and contractors of Huynh Lawyers. Access is granted by your company administrator." },
            { title: "3. Use of the Application", body: "You agree to use the App only for legitimate business purposes. You must not share login credentials, access other companies' data, or attempt to reverse engineer or interfere with the App." },
            { title: "4. Gmail Integration", body: "By connecting your Gmail account, you authorise Diract to create and manage Gmail labels, read metadata and content of emails you assign to projects, and sync changes across your team. You may revoke this access at any time via your Google Account settings." },
            { title: "5. Data and Privacy", body: "Your use of the App is governed by our Privacy Policy. We handle your data in accordance with applicable Australian privacy laws." },
            { title: "6. Intellectual Property", body: "All content, code, and features of the App are the property of Diract. You may not copy or distribute any part of the App without prior written consent." },
            { title: "7. Limitation of Liability", body: "The App is provided \"as is\". We make no warranties regarding uptime or data integrity. To the maximum extent permitted by law, we are not liable for any indirect or consequential damages." },
            { title: "8. Changes to Terms", body: "We may update these Terms at any time. Continued use of the App after changes are posted constitutes acceptance of the revised Terms." },
            { title: "9. Governing Law", body: "These Terms are governed by the laws of New South Wales, Australia." },
            { title: "10. Contact", body: "For questions: legal@huynhco.com" },
          ].map(s => (
            <section key={s.title}>
              <h2 className="text-base font-semibold text-slate-800 mb-1">{s.title}</h2>
              <p>{s.body}</p>
            </section>
          ))}

        </div>
      </div>
    </div>
  );
}