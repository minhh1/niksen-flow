"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { 
  Lock, 
  Mail, 
  Loader2, 
  Globe, 
  Fingerprint, 
  ArrowRight 
} from "lucide-react";

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // --- GOOGLE AUTH LOGIC ---
  const handleGoogleLogin = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        // Ensure this points to your callback route we created
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) alert(error.message);
  };

  // --- EMAIL/PASSWORD AUTH LOGIC ---
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const { error } = isRegister 
      ? await supabase.auth.signUp({ 
          email, 
          password,
          options: {
            data: {
              full_name: email.split('@')[0], // Default name from email
            }
          }
        })
      : await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      alert(error.message);
    } else {
      // Redirect to dashboard on success
      window.location.href = "/dashboard/projects";
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 font-sans antialiased selection:bg-black selection:text-white">
      <div className="w-full max-w-[440px] bg-white rounded-[48px] p-10 md:p-12 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] border border-slate-100 animate-in fade-in duration-700">
        
        {/* Branding */}
        <div className="text-center mb-10">
          <div className="mx-auto w-14 h-14 bg-black rounded-[22px] flex items-center justify-center mb-5 shadow-2xl shadow-black/20">
            <Fingerprint className="text-white" size={28} />
          </div>
          <h1 className="text-3xl font-black italic tracking-tighter text-slate-900">niksen-flow</h1>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.3em] mt-3">
            {isRegister ? 'New Company Enrolment' : 'Enterprise Secure Access'}
          </p>
        </div>

        {/* 1. GOOGLE LOGIN BUTTON */}
        <button 
          onClick={handleGoogleLogin}
          className="w-full flex items-center justify-center gap-3 py-4.5 rounded-full border border-slate-200 font-bold text-sm hover:bg-slate-50 transition-all mb-8 group"
        >
          <Globe size={18} className="text-blue-500 group-hover:rotate-12 transition-transform" /> 
          <span>Continue with Google</span>
        </button>

        {/* Separator */}
        <div className="relative mb-8 text-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-100"></div>
          </div>
          <span className="relative bg-white px-4 text-[10px] font-black text-slate-300 uppercase tracking-widest">
            Verification Strategy
          </span>
        </div>

        {/* 2. EMAIL FORM */}
        <form onSubmit={handleAuth} className="space-y-4">
          <div className="relative">
            <Mail className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
            <input 
              required 
              type="email" 
              placeholder="Corporate Email" 
              className="w-full p-4.5 pl-14 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm transition-all" 
              onChange={e => setEmail(e.target.value)} 
            />
          </div>
          
          <div className="relative">
            <Lock className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
            <input 
              required 
              type="password" 
              placeholder="Access Key" 
              className="w-full p-4.5 pl-14 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 ring-black/5 font-bold text-sm transition-all" 
              onChange={e => setPassword(e.target.value)} 
            />
          </div>

          <button 
            disabled={loading} 
            className="w-full bg-black text-white py-5 rounded-full font-black uppercase text-xs tracking-widest shadow-xl shadow-black/10 hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : (
              <>
                {isRegister ? 'Register' : 'Authorise Entrance'}
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        {/* Toggle Switch */}
        <button 
          onClick={() => setIsRegister(!isRegister)} 
          className="w-full mt-10 text-[10px] font-black uppercase text-slate-400 hover:text-indigo-600 transition-colors tracking-widest text-center"
        >
          {isRegister ? 'Already onboarded? Sign In' : 'New Subsidiary? Register Unit'}
        </button>

      </div>
      
      {/* Footer Decoration */}
      <div className="fixed bottom-8 text-[10px] font-black text-slate-300 uppercase tracking-[0.5em] pointer-events-none">
        Niksen Time Pty Ltd • Asset Management
      </div>
    </div>
  );
}