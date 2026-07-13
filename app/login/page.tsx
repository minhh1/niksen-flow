// app/login/page.tsx
"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import {
  Lock, Mail, Loader2, Globe, Fingerprint, ArrowRight,
  Eye, EyeOff, CheckCircle2, Building2, AlertCircle
} from "lucide-react";

type AuthMode = "login" | "register";

function isValidABN(abn: string): boolean {
  const cleaned = abn.replace(/\s/g, '');
  if (!/^\d{11}$/.test(cleaned)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = cleaned.split('').map(Number);
  digits[0] -= 1;
  return digits.reduce((sum, d, i) => sum + d * weights[i], 0) % 89 === 0;
}

function isValidACN(acn: string): boolean {
  const cleaned = acn.replace(/\s/g, '');
  if (!/^\d{9}$/.test(cleaned)) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  const total = cleaned.slice(0, 8).split('').reduce((sum, d, i) => sum + Number(d) * weights[i], 0);
  const remainder = total % 10;
  const expected = remainder === 0 ? 0 : 10 - remainder;
  return expected === Number(cleaned[8]);
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get('token');

  const [mode, setMode] = useState<AuthMode>(inviteToken ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [abn, setAbn] = useState("");
  const [acn, setAcn] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Token state
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [tokenData, setTokenData] = useState<{
    id: string;
    company_id: string | null;
    company_name: string | null;
    note: string | null;
    expires_at: string | null;
    used_at: string | null;
  } | null>(null);

  // Is this an invite to join an existing company (vs creating a new one)?
  const isJoinInvite = !!inviteToken && !!tokenData?.company_id;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        // If logged in with a token, handle joining the company
        if (inviteToken) {
          handleTokenJoin(session.user.id);
        } else {
          router.replace("/dashboard/properties");
        }
      }
    });
  }, [router]);

  // Validate token on load
  useEffect(() => {
    if (!inviteToken) return;
    validateToken();
  }, [inviteToken]);

  const validateToken = async () => {
    const { data, error } = await supabase
      .from('registration_tokens')
      .select('id, note, expires_at, used_at, company_id, company:company_id(name)')
      .eq('token', inviteToken!)
      .single();

    if (error || !data) {
      setTokenValid(false);
      return;
    }

    const isExpired = data.expires_at
      ? new Date(data.expires_at) < new Date()
      : false;
    const isUsed = !!data.used_at;

    if (isExpired || isUsed) {
      setTokenValid(false);
      setTokenData(null);
      return;
    }

    setTokenValid(true);
    setTokenData({
      id: data.id,
      company_id: data.company_id,
      company_name: (data.company as any)?.name || null,
      note: data.note,
      expires_at: data.expires_at,
      used_at: data.used_at,
    });

    // If joining existing company, default to login mode
    if (data.company_id) {
      setMode("login");
    } else {
      setMode("register");
    }
  };

  // Handle joining an existing company (called when already logged in with token)
  const handleTokenJoin = async (userId: string) => {
    if (!inviteToken || !tokenData?.company_id) {
      router.replace("/dashboard/properties");
      return;
    }

    try {
      // Add to company_memberships
      await supabase.from('company_memberships').upsert({
        company_id: tokenData.company_id,
        user_id: userId,
        role: 'member',
      }, { onConflict: 'company_id,user_id' });

      // Switch active company
      await supabase.from('profiles')
        .update({ active_company_id: tokenData.company_id })
        .eq('id', userId);

      // Mark token used
      await supabase.from('registration_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token', inviteToken);

      router.replace("/dashboard/properties");
    } catch {
      router.replace("/dashboard/properties");
    }
  };

  const clearMessages = () => { setError(null); setSuccess(null); };

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    clearMessages();
    // Store invite token in cookie so callback can read it after OAuth redirect
    if (inviteToken) {
      document.cookie = `invite_token=${inviteToken}; path=/; max-age=600; SameSite=Lax`;
    }
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) { setError(error.message); setGoogleLoading(false); }
  };

  // ── Login — also handles joining existing company with token ──────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    if (inviteToken && tokenValid === false) {
      setError("This invitation link is invalid or has already been used.");
      return;
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        setError("Please confirm your email before signing in.");
      } else if (error.message.toLowerCase().includes('invalid login')) {
        setError("Incorrect email or password.");
      } else {
        setError(error.message);
      }
      setLoading(false);
      return;
    }

    if (!data.session) {
      setError("Login succeeded but no session was created. Please try again.");
      setLoading(false);
      return;
    }

    const userId = data.user.id;

    // If there's a valid company invite token, join that company
    if (inviteToken && tokenValid && tokenData?.company_id) {
      try {
        // Add to company_memberships
        const { error: memberErr } = await supabase
          .from('company_memberships')
          .upsert({
            company_id: tokenData.company_id,
            user_id: userId,
            role: 'member',
          }, { onConflict: 'company_id,user_id' });

        if (memberErr) console.error('membership error:', memberErr);

        // Switch active company to the invited company
        await supabase.from('profiles')
          .update({ active_company_id: tokenData.company_id })
          .eq('id', userId);

        // Mark token as used
        await supabase.from('registration_tokens')
          .update({ used_at: new Date().toISOString() })
          .eq('token', inviteToken);

      } catch (err) {
        console.error('Token join error:', err);
        // Don't block login even if join fails
      }
    }

    router.replace("/dashboard/properties");
  };

  // ── Register — creates new company OR joins existing via token ────
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    if (inviteToken && tokenValid === false) {
      setError("This invitation link is invalid or has already been used.");
      return;
    }

    // If joining existing company, just need email + password
    if (!isJoinInvite) {
      if (!companyName.trim()) { setError("Company name is required."); return; }
    }
    if (password !== confirmPassword) { setError("Passwords don't match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (abn.trim() && !isValidABN(abn.trim())) { setError("ABN is not valid."); return; }
    if (acn.trim() && !isValidACN(acn.trim())) { setError("ACN is not valid."); return; }

    setLoading(true);

    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName || email.split('@')[0] },
          emailRedirectTo: inviteToken
            ? `${window.location.origin}/auth/callback?token=${inviteToken}`
            : `${window.location.origin}/auth/callback`,
        },
      });

      if (authError) throw new Error(authError.message);
      if (!authData.user) throw new Error("User creation failed.");

      const userId = authData.user.id;

      if (isJoinInvite && tokenData?.company_id) {
        // ── Join existing company ──────────────────────────────
        // Create profile first
        await supabase.from('profiles').upsert({
          id: userId,
          full_name: fullName || email.split('@')[0],
          email,
          active_company_id: tokenData.company_id,
          is_admin: false,
          is_active: true,
        }, { onConflict: 'id' });

        // Add to memberships
        await supabase.from('company_memberships').upsert({
          company_id: tokenData.company_id,
          user_id: userId,
          role: 'member',
        }, { onConflict: 'company_id,user_id' });

        // Mark token used
        await supabase.from('registration_tokens')
          .update({ used_at: new Date().toISOString() })
          .eq('token', inviteToken);

      } else {
        // ── Create new company (original flow) ─────────────────
        const { data: result, error: rpcError } = await supabase.rpc(
          'register_company_and_profile',
          {
            p_user_id: userId,
            p_full_name: fullName || email.split('@')[0],
            p_email: email,
            p_company_name: companyName.trim(),
            p_abn: abn.trim() || null,
            p_acn: acn.trim() || null,
            p_invite_token: inviteToken || null,
          }
        );

        if (rpcError) throw new Error(`Registration failed: ${rpcError.message}`);
        if (result && !result.success) throw new Error(result.error || 'Registration failed');
      }

      const needsConfirmation = !authData.session;
      if (needsConfirmation) {
        setSuccess("Account created! Check your inbox and confirm your email to get started.");
        setLoading(false);
      } else {
        router.replace("/dashboard/properties");
      }
    } catch (err: any) {
      setError(err.message || "Registration failed. Please try again.");
      setLoading(false);
    }
  };

  const switchMode = () => {
    setMode(m => m === 'login' ? 'register' : 'login');
    clearMessages();
    setPassword(''); setConfirmPassword('');
    setCompanyName(''); setAbn(''); setAcn('');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 font-sans antialiased selection:bg-black selection:text-white">
      <div className="w-full max-w-[480px] bg-white rounded-[48px] p-10 md:p-12 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] border border-slate-100">

        {/* Branding */}
        <div className="text-center mb-10">
          <div className="mx-auto w-14 h-14 bg-black rounded-[22px] flex items-center justify-center mb-5 shadow-2xl shadow-black/20">
            <Fingerprint className="text-white" size={28} />
          </div>
          <h1 className="text-3xl font-black italic tracking-tighter text-slate-900">niksen-flow</h1>
          <p className="text-slate-400 text-[10px] font-black uppercase tracking-[0.3em] mt-3">
            {mode === 'register'
              ? isJoinInvite ? `Join ${tokenData?.company_name || 'Company'}` : 'New Company Enrolment'
              : isJoinInvite ? `Sign in to join ${tokenData?.company_name || 'Company'}` : 'Enterprise Secure Access'
            }
          </p>
        </div>

        {/* Invite token status */}
        {inviteToken && (
          <div className={`mb-6 px-5 py-3.5 rounded-2xl text-[11px] font-bold flex items-center gap-2 ${
            tokenValid === false
              ? 'bg-red-50 border border-red-100 text-red-600'
              : tokenValid === true
              ? 'bg-emerald-50 border border-emerald-100 text-emerald-700'
              : 'bg-slate-50 border border-slate-100 text-slate-400'
          }`}>
            {tokenValid === null
              ? <Loader2 size={14} className="animate-spin" />
              : tokenValid
              ? <CheckCircle2 size={14} />
              : <AlertCircle size={14} />
            }
            {tokenValid === null
              ? 'Validating invitation...'
              : tokenValid
              ? isJoinInvite
                ? `You've been invited to join ${tokenData?.company_name || 'a company'}`
                : 'Valid invitation — complete registration below'
              : 'This invitation link is invalid or has already been used'
            }
          </div>
        )}

        {/* Note from inviter */}
        {tokenData?.note && tokenValid && (
          <p className="text-[12px] text-slate-400 italic text-center mb-6">
            "{tokenData.note}"
          </p>
        )}

        {/* Messages */}
        {error && (
          <div className="mb-6 px-5 py-3.5 bg-red-50 border border-red-100 rounded-2xl text-[11px] font-bold text-red-600 leading-relaxed flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {success && (
          <div className="mb-6 px-5 py-3.5 bg-emerald-50 border border-emerald-100 rounded-2xl text-[11px] font-bold text-emerald-700 leading-relaxed flex items-start gap-2">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> {success}
          </div>
        )}

        {/* Google */}
        <button
          onClick={handleGoogleLogin}
          disabled={googleLoading || loading || tokenValid === false}
          className="w-full flex items-center justify-center gap-3 py-4 rounded-full border border-slate-200 font-bold text-sm hover:bg-slate-50 transition-all mb-8 group disabled:opacity-50"
        >
          {googleLoading
            ? <Loader2 size={18} className="animate-spin text-slate-400" />
            : <Globe size={18} className="text-blue-500 group-hover:rotate-12 transition-transform" />
          }
          Continue with Google
        </button>

        {/* Divider */}
        <div className="relative mb-8 text-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-100" />
          </div>
          <span className="relative bg-white px-4 text-[10px] font-black text-slate-300 uppercase tracking-widest">
            Or continue with email
          </span>
        </div>

        {/* Form */}
        <form onSubmit={mode === 'login' ? handleLogin : handleRegister} className="space-y-4">
          {mode === 'register' && (
            <>
              <input
                type="text"
                placeholder="Full name"
                value={fullName}
                onChange={e => { setFullName(e.target.value); clearMessages(); }}
                className="w-full p-4 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
              />

              {/* Only show company fields if creating a new company */}
              {!isJoinInvite && (
                <div className="rounded-[28px] border border-slate-100 bg-slate-50/50 p-4 space-y-3">
                  <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1">
                    Company details
                  </p>
                  <div className="relative">
                    <Building2 className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={16} />
                    <input
                      required
                      type="text"
                      placeholder="Company name"
                      value={companyName}
                      onChange={e => { setCompanyName(e.target.value); clearMessages(); }}
                      className="w-full p-4 pl-12 rounded-full border border-slate-200 bg-white outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      placeholder="ABN (optional)"
                      value={abn}
                      onChange={e => { setAbn(e.target.value); clearMessages(); }}
                      className="w-full p-4 rounded-full border border-slate-200 bg-white outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
                    />
                    <input
                      type="text"
                      placeholder="ACN (optional)"
                      value={acn}
                      onChange={e => { setAcn(e.target.value); clearMessages(); }}
                      className="w-full p-4 rounded-full border border-slate-200 bg-white outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
                    />
                  </div>
                </div>
              )}
            </>
          )}

          <div className="relative">
            <Mail className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
            <input
              required
              type="email"
              placeholder="Corporate email"
              value={email}
              onChange={e => { setEmail(e.target.value); clearMessages(); }}
              className="w-full p-4 pl-14 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
            />
          </div>

          <div className="relative">
            <Lock className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
            <input
              required
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={password}
              onChange={e => { setPassword(e.target.value); clearMessages(); }}
              className="w-full p-4 pl-14 pr-14 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
            />
            <button
              type="button"
              onClick={() => setShowPassword(p => !p)}
              className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-600 transition-colors"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {mode === 'register' && (
            <div className="relative">
              <Lock className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-300" size={18} />
              <input
                required
                type={showPassword ? "text" : "password"}
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); clearMessages(); }}
                className="w-full p-4 pl-14 rounded-full border border-slate-200 bg-slate-50 outline-none focus:ring-4 focus:ring-black/5 font-bold text-sm"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading || googleLoading || tokenValid === false}
            className="w-full bg-black text-white py-4 rounded-full font-black uppercase text-xs tracking-widest shadow-xl shadow-black/10 hover:bg-slate-800 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading
              ? <Loader2 className="animate-spin" size={18} />
              : <>
                  {mode === 'login'
                    ? isJoinInvite ? `Sign in & join ${tokenData?.company_name || 'company'}` : 'Sign in'
                    : isJoinInvite ? `Create account & join ${tokenData?.company_name || 'company'}` : 'Create account'
                  }
                  <ArrowRight size={16} />
                </>
            }
          </button>
        </form>

        {/* Toggle — for invite links, allow switching between sign in and register */}
        <button
          onClick={switchMode}
          className="w-full mt-8 text-[10px] font-black uppercase text-slate-400 hover:text-indigo-600 transition-colors tracking-widest text-center"
        >
          {mode === 'login'
            ? isJoinInvite
              ? "New to niksen? Create an account instead"
              : "New here? Create an account"
            : isJoinInvite
              ? "Already have an account? Sign in instead"
              : "Already have an account? Sign in"
          }
        </button>
      </div>

      <div className="fixed bottom-8 text-[10px] font-black text-slate-300 uppercase tracking-[0.5em] pointer-events-none">
        Niksen Time Pty Ltd • Asset Management
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}