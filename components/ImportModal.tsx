// components/ImportModal.tsx
"use client";

import { useState, useRef, useEffect } from "react";
import { X, Loader2, ArrowLeft, ArrowRight, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";

import FileUploader from "./import/FileUploader";
import ImportResultsTable from "./import/ImportResultsTable";
import SectionPicker from "./import/SectionPicker";
import ImportReviewTable from "./import/ImportReviewTable";

import { buildAllSections, type ImportSection } from "@/lib/import/buildTemplate";
import { parseImportFile, type ParsedRow } from "@/lib/import/parseImportFile";
import { detectSectionFromHeaders } from "@/lib/import/detectSection";
import { stageAndCheckProperties, stageAndCheckEntities, clearStaging, type StagingFlag } from "@/lib/import/stagingCheck";
import { commitBaseRow, commitChildRow, type RowAction, type ImportRowResult } from "@/lib/import/commitImport";
import { findExistingChildRow, findMatchingProperty } from "@/lib/import/parentResolver";

type Stage = "upload" | "checking" | "review" | "committing" | "results";
type BaseMode = "properties" | "entities" | "projects";

const BLOCKING_SCORE = 3;

export default function ImportModal({ isOpen, onClose, onRefresh }: any) {
  const [stage, setStage] = useState<Stage>("upload");
  const [baseMode, setBaseMode] = useState<BaseMode>("properties");
  const [sections, setSections] = useState<ImportSection[]>([]);
  const [sectionKey, setSectionKey] = useState<string>("properties");
  const [loadingSections, setLoadingSections] = useState(true);
  const [detectedNotice, setDetectedNotice] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [stagingFlags, setStagingFlags] = useState<StagingFlag[]>([]);
  const [rowActions, setRowActions] = useState<Map<number, RowAction>>(new Map());
  const [rowUpdateTarget, setRowUpdateTarget] = useState<Map<number, string>>(new Map());
  const [rowParentMatched, setRowParentMatched] = useState<Set<number>>(new Set());
  const [rowParentWarnings, setRowParentWarnings] = useState<Map<number, string>>(new Map());
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);
  const [showParentDetails, setShowParentDetails] = useState(false);

  const [results, setResults] = useState<ImportRowResult[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  const currentSection = sections.find(s => s.key === sectionKey);
  const isBaseSection = currentSection ? currentSection.targetTable === baseMode : true;

  const currentSectionRef = useRef(currentSection);
  const baseModeRef = useRef(baseMode);
  useEffect(() => { currentSectionRef.current = currentSection; }, [currentSection]);
  useEffect(() => { baseModeRef.current = baseMode; }, [baseMode]);

  useEffect(() => {
    if (!isOpen) return;
    setLoadingSections(true);
    buildAllSections(baseMode).then(s => {
      setSections(s);
      setSectionKey(baseMode);
      setLoadingSections(false);
    });
  }, [baseMode, isOpen]);

  const resetAll = () => {
    if (batchId) clearStaging(batchId);
    setStage("upload"); setFile(null); setParsedRows([]); setStagingFlags([]);
    setRowActions(new Map()); setRowUpdateTarget(new Map()); setRowParentMatched(new Set());
    setRowParentWarnings(new Map()); setResults([]); setBatchId(null);
    setDetectedNotice(null); setShowParentDetails(false);
  };

  const handleFileSelect = async (selectedFile: File) => {
    setFile(selectedFile);
    setDetectedNotice(null);
    if (!selectedFile || sections.length === 0) return;

    const text = await selectedFile.text();
    const firstLine = text.split('\n')[0] || '';
    const result = detectSectionFromHeaders(firstLine, sections);

    if (result && result.section.key !== sectionKey) {
      setSectionKey(result.section.key);
      setDetectedNotice(`Detected "${result.section.title}" from this file's columns — switched automatically. Change it above if this isn't right.`);
    } else if (!result) {
      setDetectedNotice(`Couldn't automatically detect which section this file belongs to — please confirm the right one is selected above.`);
    }
  };

  // --- STAGE 1 -> 2 ---
  const handleAnalyze = async () => {
    const section = currentSectionRef.current;
    const mode = baseModeRef.current;
    if (!file || !section) return;
    const sectionIsBase = section.targetTable === mode;

    setStage("checking");

    const text = await file.text();
    const { rows: parsed } = parseImportFile(text, { baseMode: mode, sectionIsBase });
    if (parsed.length === 0) { alert("This file has no data rows."); setStage("upload"); return; }

    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase.from("profiles").select("company_id").eq("id", user?.id).single();
    const uid = user?.id || ''; const cid = prof?.company_id || '';
    setUserId(uid); setCompanyId(cid);

    const newBatchId = crypto.randomUUID();
    setBatchId(newBatchId);
    setParsedRows(parsed);

    let flags: StagingFlag[] = [];
    const actions = new Map<number, RowAction>();
    const updateTargets = new Map<number, string>();
    const parentMatched = new Set<number>();

    if (sectionIsBase) {
      try {
        if (mode === 'properties') {
          flags = await stageAndCheckProperties(newBatchId, uid, cid, parsed.map(r => ({
            row_index: r.rowIndex, street_address: r.parsed.street_address, suburb: r.parsed.suburb,
            state: r.parsed.state, postcode: r.parsed.postcode, purchase_price: r.parsed.purchase_price,
            purchase_date: r.parsed.purchase_date, entity_name: r.parsed.entity_name || null, raw_payload: r.parsed,
          })));
        } else if (mode === 'entities') {
          flags = await stageAndCheckEntities(newBatchId, uid, cid, parsed.map(r => ({
            row_index: r.rowIndex, name: r.parsed.entity_name || r.parsed.name, raw_payload: r.parsed,
          })));
        }
      } catch (err: any) {
        alert(`Duplicate check failed: ${err.message}. You can still review and commit manually.`);
      }

      parsed.forEach(row => {
        const rowFlags = flags.filter(f => f.staging_row_index === row.rowIndex);
        const blockingFlag = rowFlags.find(f => (f.match_score ?? 99) >= BLOCKING_SCORE || f.match_reason?.includes('Pty/Ltd'));
        const existingMatch = rowFlags.find(f => f.matched_against === 'existing' && f.matched_id);

        if (existingMatch) {
          updateTargets.set(row.rowIndex, existingMatch.matched_id!);
          actions.set(row.rowIndex, 'update');
        } else if (blockingFlag) {
          actions.set(row.rowIndex, 'skip');
        } else {
          actions.set(row.rowIndex, 'include');
        }
      });
    } else {
      const warnings = new Map<number, string>();
      for (const row of parsed) {
        const refAddress = row.parsed.property_street_address;
        const refSuburb = row.parsed.property_suburb;

        if (section.parentKey !== 'property_id' || !refAddress) {
          actions.set(row.rowIndex, 'include');
          continue;
        }

        // Uses the shared, punctuation/whitespace-normalized matcher —
        // the same function resolvePropertyParent calls at commit time —
        // so review-time detection and commit-time resolution can never
        // disagree about whether a property already exists.
        const existingProperty = await findMatchingProperty(cid, refAddress, refSuburb);

        if (!existingProperty) {
          warnings.set(row.rowIndex, `Property "${refAddress}" not found — a new minimal property record will be created.`);
          actions.set(row.rowIndex, 'include');
          continue;
        }

        parentMatched.add(row.rowIndex);

        const existingChildId = await findExistingChildRow(
          section.targetTable, existingProperty.id, section.fixedValues?.category
        );
        if (existingChildId) {
          updateTargets.set(row.rowIndex, existingChildId);
        }
        actions.set(row.rowIndex, 'update');
      }
      setRowParentWarnings(warnings);
    }

    setStagingFlags(flags);
    setRowActions(actions);
    setRowUpdateTarget(updateTargets);
    setRowParentMatched(parentMatched);
    setStage("review");
  };

  const cycleRowAction = (rowIndex: number) => {
    const canReachUpdate = rowUpdateTarget.has(rowIndex) || rowParentMatched.has(rowIndex);
    setRowActions(prev => {
      const next = new Map(prev);
      const current = next.get(rowIndex) || 'include';
      if (current === 'include') next.set(rowIndex, 'skip');
      else if (current === 'skip') next.set(rowIndex, canReachUpdate ? 'update' : 'include');
      else next.set(rowIndex, 'include');
      return next;
    });
  };

  const blockedRowsSetToInclude = parsedRows.filter(row => {
    const flags = stagingFlags.filter(f => f.staging_row_index === row.rowIndex);
    const isBlocking = flags.some(f => (f.match_score ?? 99) >= BLOCKING_SCORE || f.match_reason?.includes('Pty/Ltd'));
    return isBlocking && (rowActions.get(row.rowIndex) || 'include') === 'include';
  });

  // --- STAGE 3 -> 4 ---
  const handleCommit = async () => {
    const section = currentSectionRef.current;
    const mode = baseModeRef.current;
    if (!companyId || !section) return;
    const sectionIsBase = section.targetTable === mode;

    if (blockedRowsSetToInclude.length > 0) {
      const proceed = window.confirm(`${blockedRowsSetToInclude.length} row(s) flagged as likely duplicates are still set to create a new record. Continue anyway?`);
      if (!proceed) return;
    }

    setStage("committing");
    const importLogs: ImportRowResult[] = [];
    const ctx = { companyId, userId: userId!, batchId: batchId!, baseMode: mode, rowUpdateTarget };
    const rowsToProcess = parsedRows.filter(r => (rowActions.get(r.rowIndex) || 'include') !== 'skip');

    for (const row of rowsToProcess) {
      const action = rowActions.get(row.rowIndex) || 'include';
      const result = sectionIsBase
        ? await commitBaseRow(row, action, ctx)
        : await commitChildRow(row, section, action, ctx);
      importLogs.push(result);
    }

    parsedRows.forEach(row => {
      if ((rowActions.get(row.rowIndex) || 'include') === 'skip') {
        importLogs.push({
          id: '', status: 'failed',
          identifier: row.parsed.street_address || row.parsed.entity_name || row.parsed.name || `Row ${row.rowIndex}`,
          message: 'Skipped by user during review', details: row.parsed,
        });
      }
    });

    await supabase.from("import_history").insert([{
      id: batchId, user_id: userId, company_id: companyId, target_table: section.targetTable,
      filename: file?.name, total_rows: parsedRows.length,
      success_count: importLogs.filter(r => r.status === 'new' || r.status === 'updated').length,
      error_count: importLogs.filter(r => r.status === 'failed').length,
      results_json: importLogs,
    }]);

    if (batchId) await clearStaging(batchId);
    setResults(importLogs);
    setStage("results");
    onRefresh();
  };

  const handleReverse = async (id: string, index: number) => {
    const section = currentSectionRef.current;
    if (!section) return;
    if (!window.confirm("Archive this entry? It will be soft-deleted, not permanently removed.")) return;
    const { error } = await supabase.from(section.targetTable).update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (!error) {
      const next = [...results]; next[index].status = "reversed"; setResults(next); onRefresh();
    }
  };

  if (!isOpen) return null;

  const flagsByRow = new Map<number, StagingFlag[]>();
  stagingFlags.forEach(f => flagsByRow.set(f.staging_row_index, [...(flagsByRow.get(f.staging_row_index) || []), f]));

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans antialiased text-slate-600">
      <div className="bg-white w-full max-w-7xl rounded-[40px] shadow-2xl flex flex-col max-h-[92vh]">

        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-white shrink-0">
          <div>
            <h2 className="text-xl font-light text-slate-900 uppercase tracking-widest leading-none">Data synchronization</h2>
            <p className="text-[11px] text-slate-400 mt-1 font-medium">
              {stage === 'upload' && 'Step 1 of 3 — choose a section and file'}
              {stage === 'checking' && 'Checking for duplicates and parent records...'}
              {stage === 'review' && 'Step 2 of 3 — review before committing'}
              {stage === 'committing' && 'Writing records...'}
              {stage === 'results' && 'Step 3 of 3 — import complete'}
            </p>
          </div>
          <button onClick={() => { onClose(); resetAll(); }} className="p-2 text-slate-300 hover:text-black transition-colors"><X size={20}/></button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
          {stage === "upload" && (
            <>
              <SectionPicker
                baseMode={baseMode}
                onBaseModeChange={setBaseMode}
                sections={sections}
                sectionKey={sectionKey}
                onSectionChange={(key) => { setSectionKey(key); setDetectedNotice(null); }}
                currentSection={currentSection}
                isBaseSection={isBaseSection}
                loadingSections={loadingSections}
                detectedNotice={detectedNotice}
              />
              <FileUploader file={file} onFileSelect={handleFileSelect} fileInputRef={fileInputRef} />
              <input type="file" accept=".csv" className="hidden" ref={fileInputRef} onChange={(e) => { if (e.target.files?.[0]) handleFileSelect(e.target.files[0]); }} />
            </>
          )}

          {stage === "checking" && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="animate-spin text-indigo-500" size={28} />
              <p className="text-[12px] font-medium text-slate-400">Parsing file and checking records...</p>
            </div>
          )}

          {stage === "review" && (
            <>
              {blockedRowsSetToInclude.length > 0 && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-[12px] font-medium text-amber-700 flex items-start gap-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  {blockedRowsSetToInclude.length} row(s) flagged as likely duplicates are still set to create a new record.
                </div>
              )}

              <div className="flex items-center justify-between px-2">
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">{parsedRows.length} rows parsed</p>
                <div className="flex gap-4 text-[10px] font-bold uppercase">
                  {stagingFlags.length > 0 && <span className="text-amber-600">{stagingFlags.length} possible duplicates</span>}
                  {rowParentWarnings.size > 0 && (
                    <button onClick={() => setShowParentDetails(p => !p)} className="text-blue-600 hover:underline">
                      {rowParentWarnings.size} new parent record{rowParentWarnings.size > 1 ? 's' : ''}
                    </button>
                  )}
                  <span className="text-slate-400">{Array.from(rowActions.values()).filter(a => a === 'skip').length} skipped</span>
                </div>
              </div>

              {showParentDetails && rowParentWarnings.size > 0 && (
                <div className="p-4 bg-blue-50 border border-blue-100 rounded-2xl space-y-1">
                  <p className="text-[10px] font-bold text-blue-700 uppercase tracking-wide mb-2">
                    These properties don't exist yet — a minimal record will be created for each:
                  </p>
                  {Array.from(rowParentWarnings.entries()).map(([rowIndex, warning]) => (
                    <p key={rowIndex} className="text-[11px] text-blue-600">
                      <span className="font-bold">Row {rowIndex}:</span> {warning.replace(/^Property "(.+)" not found.*/, '$1')}
                    </p>
                  ))}
                </div>
              )}

              <ImportReviewTable
                parsedRows={parsedRows}
                isBaseSection={isBaseSection}
                rowActions={rowActions}
                rowUpdateTarget={rowUpdateTarget}
                rowParentWarnings={rowParentWarnings}
                flagsByRow={flagsByRow}
                editingCell={editingCell}
                onCycleAction={cycleRowAction}
                onStartEdit={(row, field) => setEditingCell({ row, field })}
                onCommitEdit={(rowIndex, field, value) => {
                  setParsedRows(prev => prev.map(r => r.rowIndex === rowIndex ? { ...r, parsed: { ...r.parsed, [field]: value } } : r));
                  setEditingCell(null);
                }}
              />
            </>
          )}

          {stage === "committing" && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="animate-spin text-indigo-500" size={28} />
              <p className="text-[12px] font-medium text-slate-400">Writing records...</p>
            </div>
          )}

          {stage === "results" && <ImportResultsTable results={results} onReverse={handleReverse} />}
        </div>

        <div className="p-6 bg-white border-t border-slate-50 flex justify-between items-center">
          {stage === "review" ? (
            <button onClick={() => { if (batchId) clearStaging(batchId); setStage("upload"); }} className="flex items-center gap-2 px-6 py-3 text-slate-400 hover:text-slate-700 text-sm font-medium transition-all">
              <ArrowLeft size={16} /> Back
            </button>
          ) : <div />}

          {stage === "upload" && (
            <button disabled={!file} onClick={handleAnalyze} className="px-8 py-4 bg-slate-900 text-white rounded-full text-sm font-medium transition-all hover:bg-black disabled:opacity-30 flex items-center gap-2">
              Analyze file <ArrowRight size={16} />
            </button>
          )}
          {stage === "review" && (
            <button onClick={handleCommit} className="px-8 py-4 bg-slate-900 text-white rounded-full text-sm font-medium transition-all hover:bg-black flex items-center gap-2">
              Commit {Array.from(rowActions.values()).filter(a => a !== 'skip').length} records <ArrowRight size={16} />
            </button>
          )}
          {stage === "results" && (
            <button onClick={resetAll} className="px-8 py-4 bg-slate-50 border border-slate-200 text-slate-600 rounded-full text-sm font-medium hover:bg-slate-100 transition-all">
              Import another file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}