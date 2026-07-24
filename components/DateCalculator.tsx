// components/DateCalculator.tsx
// "X days from" popover — calendar days or AU business days (skips weekends +
// public holidays for a chosen state, via the date-calc edge function).
"use client";

import { useState, useRef, useEffect } from "react";
import { Calendar, Loader2, CalendarClock } from "lucide-react";
import { supabase } from "@/lib/supabase";

const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

interface Result {
  resultDate: string;
  dayOfWeek: string;
  mode: string;
  state: string | null;
  holidaysSkipped: { date: string; name: string }[];
  weekendsSkipped: number;
}

interface Props {
  /** Defaults to today if omitted */
  defaultFromDate?: string;
  /** Called with the computed YYYY-MM-DD date when the user clicks "Use this date" */
  onApply?: (date: string) => void;
  /** Icon-only trigger button styling — pass a className to override */
  triggerClassName?: string;
}

export default function DateCalculator({ defaultFromDate, onApply, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [fromDate, setFromDate] = useState(defaultFromDate || new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState<'calendar' | 'business'>('calendar');
  const [state, setState] = useState('NSW');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const calculate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('date-calc', {
        body: { fromDate, days, mode, state: mode === 'business' ? state : undefined },
      });
      if (fnError || data?.error) {
        setError(data?.error || fnError?.message || 'Calculation failed');
        return;
      }
      setResult(data);
    } catch (err: any) {
      setError(err?.message || 'Calculation failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(p => !p)}
        title="Date calculator"
        className={triggerClassName || "p-1.5 text-slate-300 hover:text-indigo-600 transition-colors"}
      >
        <CalendarClock size={13} />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-2 w-72 bg-white border border-slate-200 rounded-2xl shadow-xl p-4 space-y-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Date calculator</p>

          <div>
            <p className="text-[9px] text-slate-400 mb-1">From</p>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1">
              <p className="text-[9px] text-slate-400 mb-1">Days</p>
              <input type="number" value={days} onChange={e => setDays(parseInt(e.target.value) || 0)}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[12px] outline-none focus:border-indigo-400" />
            </div>
            <div className="flex-1">
              <p className="text-[9px] text-slate-400 mb-1">Type</p>
              <select value={mode} onChange={e => setMode(e.target.value as 'calendar' | 'business')}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                <option value="calendar">Calendar</option>
                <option value="business">Business</option>
              </select>
            </div>
          </div>

          {mode === 'business' && (
            <div>
              <p className="text-[9px] text-slate-400 mb-1">State (public holidays)</p>
              <select value={state} onChange={e => setState(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-200 rounded-full text-[12px] outline-none bg-white">
                {AU_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}

          <button onClick={calculate} disabled={loading}
            className="w-full py-2 bg-slate-900 text-white text-[11px] font-bold rounded-full hover:bg-slate-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {loading ? <Loader2 size={12} className="animate-spin" /> : 'Calculate'}
          </button>

          {error && <p className="text-[10px] text-red-500">{error}</p>}

          {result && (
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 rounded-xl">
                <Calendar size={12} className="text-indigo-500 shrink-0" />
                <div>
                  <p className="text-[12px] font-bold text-indigo-800">{result.resultDate}</p>
                  <p className="text-[10px] text-indigo-400">{result.dayOfWeek}</p>
                </div>
              </div>
              {result.mode === 'business' && (result.weekendsSkipped > 0 || result.holidaysSkipped.length > 0) && (
                <p className="text-[9px] text-slate-400 px-1">
                  Skipped {result.weekendsSkipped} weekend day{result.weekendsSkipped !== 1 ? 's' : ''}
                  {result.holidaysSkipped.length > 0 && (
                    <> and {result.holidaysSkipped.length} holiday{result.holidaysSkipped.length !== 1 ? 's' : ''} ({result.holidaysSkipped.map(h => h.name).join(', ')})</>
                  )}
                </p>
              )}
              {onApply && (
                <button onClick={() => { onApply(result.resultDate); setOpen(false); }}
                  className="w-full py-2 bg-indigo-600 text-white text-[11px] font-bold rounded-full hover:bg-indigo-700 transition-colors">
                  Use this date
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
