// app/page.tsx
import Link from "next/link";

const features = [
  {
    icon: "◈",
    title: "Project management",
    body: "Organise properties, matters, and entities in one place. Custom fields, statuses, and team assignments.",
  },
  {
    icon: "✉",
    title: "Gmail integration",
    body: "Assign emails to projects directly from Gmail. Labels sync automatically across your entire team.",
  },
  {
    icon: "⟳",
    title: "Automatic sync",
    body: "Labels applied by one team member appear in everyone's Gmail within minutes — no manual sharing.",
  },
  {
    icon: "⬡",
    title: "Multi-company",
    body: "Manage multiple entities under one login. Switch between companies without signing out.",
  },
  {
    icon: "◎",
    title: "Role-based access",
    body: "Admins control label settings and source emails. Team members collaborate without overriding each other.",
  },
  {
    icon: "↗",
    title: "Gmail Add-on",
    body: "Create projects, assign emails, and remove labels directly from the Gmail sidebar — no browser tab needed.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">

      {/* Nav */}
      <nav className="fixed top-0 inset-x-0 z-50 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg width="28" height="28" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="14" width="110" height="110" rx="24" fill="#818cf8" fillOpacity="0.4"/>
              <rect x="14" y="0" width="110" height="110" rx="24" fill="#4f46e5"/>
            </svg>
            <span className="font-medium text-slate-900 tracking-tight">Flow</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/privacy" className="text-[12px] text-slate-400 hover:text-slate-700 transition-colors">Privacy</Link>
            <Link href="/terms" className="text-[12px] text-slate-400 hover:text-slate-700 transition-colors">Terms</Link>
            <Link href="/login" className="px-4 py-2 bg-indigo-600 text-white text-[12px] font-medium rounded-full hover:bg-indigo-700 transition-colors">
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-40 pb-28 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50 border border-indigo-100 rounded-full text-[11px] font-medium text-indigo-600 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 inline-block"></span>
            Property & Legal Management
          </div>
          <h1 className="text-5xl font-light tracking-tight text-slate-900 mb-6 leading-tight">
            Your firm's matters,<br />
            <span className="text-indigo-600">finally in sync.</span>
          </h1>
          <p className="text-lg text-slate-500 font-light max-w-xl mx-auto mb-10 leading-relaxed">
            Flow connects your Gmail and project management into one system.
            Assign emails to matters, sync labels across your team, and keep everyone on the same page.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/login" className="px-7 py-3.5 bg-indigo-600 text-white text-sm font-medium rounded-full hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200">
              Get started
            </Link>
            <Link href="/privacy" className="px-7 py-3.5 text-slate-500 text-sm hover:text-slate-800 transition-colors">
              Learn more →
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-slate-50 py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <p className="text-center text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-12">
            Everything your firm needs
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="bg-white rounded-[24px] p-7 border border-slate-100 shadow-sm">
                <div className="text-2xl mb-4 text-indigo-500">{f.icon}</div>
                <h3 className="text-[14px] font-semibold text-slate-800 mb-2">{f.title}</h3>
                <p className="text-[13px] text-slate-500 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Gmail add-on callout */}
      <section className="py-24 px-6">
        <div className="max-w-3xl mx-auto bg-indigo-600 rounded-[40px] px-12 py-16 text-center">
          <h2 className="text-3xl font-light text-white tracking-tight mb-4">Works right inside Gmail</h2>
          <p className="text-indigo-200 text-base leading-relaxed mb-8 max-w-lg mx-auto">
            The Flow Gmail Add-on lets you create projects, assign emails, and manage labels without ever leaving your inbox.
          </p>
          <a href="https://workspace.google.com/marketplace" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-7 py-3.5 bg-white text-indigo-600 text-sm font-medium rounded-full hover:bg-indigo-50 transition-colors">
            Install Gmail Add-on →
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="14" width="110" height="110" rx="24" fill="#818cf8" fillOpacity="0.4"/>
              <rect x="14" y="0" width="110" height="110" rx="24" fill="#4f46e5"/>
            </svg>
            <span className="text-sm text-slate-500">Flow — Management Central</span>
          </div>
          <div className="flex items-center gap-6 text-[12px] text-slate-400">
            <Link href="/privacy" className="hover:text-slate-700 transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-slate-700 transition-colors">Terms of Service</Link>
            <span>© {new Date().getFullYear()} Niksen Time Pty Ltd</span>
          </div>
        </div>
      </footer>

    </div>
  );
}