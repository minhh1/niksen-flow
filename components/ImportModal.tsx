"use client";

import { useState, useRef, useEffect } from "react";
import { X, Loader2, ArrowLeft, ArrowRight, AlertTriangle, FileText } from "lucide-react";
import { supabase } from "@/lib/supabase";

import FileUploader from "./import/FileUploader";
import ImportResultsTable from "./import/ImportResultsTable";
import SectionPicker from "./import/SectionPicker";
import ImportReviewTable from "./import/ImportReviewTable";

import { buildAllSections, buildHeaderMap, type ImportSection } from "@/lib/import/buildTemplate";
import { parseImportFile, splitCSVLine, type ParsedRow } from "@/lib/import/parseImportFile";
import { detectSectionFromHeaders } from "@/lib/import/detectSection";
import { stageAndCheckProperties, stageAndCheckEntities, clearStaging, type StagingFlag } from "@/lib/import/stagingCheck";
import { commitBaseRow, commitChildRow, type RowAction, type ImportRowResult } from "@/lib/import/commitImport";
import { findExistingChildRow } from "@/lib/import/parentResolver";

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
  const [csvPreviewHeaders, setCsvPreviewHeaders] = useState<string[]>([]);
  const [csvPreviewRows, setCsvPreviewRows] = useState<string[][]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [stagingFlags, setStagingFlags] = useState<StagingFlag[]>([]);
  const [rowActions, setRowActions] = useState<Map<number, RowAction>>(new Map());
  const [rowUpdateTarget, setRowUpdateTarget] = useState<Map<number, string>>(new Map());
  const [rowParentWarnings, setRowParentWarnings] = useState<Map<number, string>>(new Map());
  const [editingCell, setEditingCell] = useState<{ row: number; field: string } | null>(null);

  const [results, setResults] = useState<ImportRowResult[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  const currentSection = sections.find(s => s.key === sectionKey);
  const isBaseSection = currentSection ? currentSection.targetTable === baseMode : true;

  const currentSectionRef = useRef(currentSection);
  const baseModeRef = useRef(baseMode);
  const [customFieldLabels, setCustomFieldLabels] = useState<Map<string, string>>(new Map());




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
    setRowActions(new Map()); setRowUpdateTarget(new Map()); setRowParentWarnings(new Map());
    setResults([]); setBatchId(null); setDetectedNotice(null);
    setCsvPreviewHeaders([]); setCsvPreviewRows([]);
  };

  // ── File select — show preview immediately ──────────────────────
  const handleFileSelect = async (selectedFile: File) => {
    setFile(selectedFile);
    setDetectedNotice(null);

    const text = await selectedFile.text();
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());

    // Show raw CSV headers and first 5 rows as preview
    if (lines.length > 0) {
      const headers = splitCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
      setCsvPreviewHeaders(headers);
      const previewRows = lines.slice(1, 6).map(line =>
        splitCSVLine(line).map(v => v.replace(/^"|"$/g, '').trim())
      );
      setCsvPreviewRows(previewRows);
    }

    if (sections.length === 0) return;
    const firstLine = lines[0] || '';
    const result = detectSectionFromHeaders(firstLine, sections);
    if (result && result.section.key !== sectionKey) {
      setSectionKey(result.section.key);
      setDetectedNotice(`Detected "${result.section.title}" from this file's columns — switched automatically.`);
    } else if (!result) {
      setDetectedNotice(`Couldn't automatically detect section — please confirm above.`);
    }
  };

  // ── Analyze ─────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    const section = currentSectionRef.current;
    const mode = baseModeRef.current;
    if (!file || !section) return;
    const sectionIsBase = section.targetTable === mode;

    setStage("checking");

    const text = await file.text();

    // ── Fix: use active_company_id ──────────────────────────────
    const { data: { user } } = await supabase.auth.getUser();
    const { data: prof } = await supabase
      .from("profiles")
      .select("active_company_id")
      .eq("id", user?.id)
      .single();
    const uid = user?.id || '';
    const cid = prof?.active_company_id || '';
    setUserId(uid);
    setCompanyId(cid);

    // Build custom field map so human-readable headers resolve correctly
    const customFieldMap = await buildHeaderMap(section.targetTable, cid);
    const cfLabels = new Map<string, string>();
      customFieldMap.forEach((internalKey, humanLabel) => {
        if (internalKey.startsWith('custom:')) {
          const fieldId = internalKey.split(':')[1];
          // Only store once per fieldId, prefer the human-readable label (no underscores)
          if (!cfLabels.has(fieldId) && !humanLabel.includes('_')) {
            cfLabels.set(fieldId, humanLabel.replace(/\b\w/g, c => c.toUpperCase()));
          }
        }
      });
    setCustomFieldLabels(cfLabels);  // ← set state once after building the map

    const { rows: parsed } = parseImportFile(
      text,
      { baseMode: mode, sectionIsBase },
      customFieldMap
    );

    // DEBUG — remove after confirming
    console.log('customFieldMap size:', customFieldMap.size);
    console.log('customFieldMap entries:', [...customFieldMap.entries()].slice(0, 5));
    console.log('First row parsed keys:', Object.keys(parsed[0]?.parsed || {}));
    console.log('First row customFields:', parsed[0]?.customFields);
    console.log('First row resolvedHeaders sample:', parsed[0] ? 'check network' : 'no rows');

    if (parsed.length === 0) {
      alert("This file has no data rows.");
      setStage("upload");
      return;
    }

    const newBatchId = crypto.randomUUID();
    setBatchId(newBatchId);
    setParsedRows(parsed);

    let flags: StagingFlag[] = [];
    const actions = new Map<number, RowAction>();
    const updateTargets = new Map<number, string>();

    if (sectionIsBase) {
      try {
        if (mode === 'properties') {
          flags = await stageAndCheckProperties(newBatchId, uid, cid, parsed.map(r => ({
            row_index: r.rowIndex,
            street_address: r.parsed.street_address,
            suburb: r.parsed.suburb,
            state: r.parsed.state,
            postcode: r.parsed.postcode,
            purchase_price: r.parsed.purchase_price,
            purchase_date: r.parsed.purchase_date,
            entity_name: r.parsed.entity_name || null,
            raw_payload: r.parsed,
          })));
        } else if (mode === 'entities') {
          flags = await stageAndCheckEntities(newBatchId, uid, cid, parsed.map(r => ({
            row_index: r.rowIndex,
            name: r.parsed.entity_name || r.parsed.name,
            raw_payload: r.parsed,
          })));
        } else if (mode === 'projects') {
          // ── Project duplicate check — match by name + property ──
          for (const row of parsed) {
            const name = row.parsed.name?.trim();
            const streetAddress = row.parsed.property_street_address?.trim();

            if (!name) {
              actions.set(row.rowIndex, 'include');
              continue;
            }

            // Check for existing project with same name
            let query = supabase
              .from('projects')
              .select('id, name, property:property_id(street_address)')
              .eq('company_id', cid)
              .ilike('name', name)
              .is('deleted_at', null);

            const { data: existing } = await query.limit(5);

            if (existing && existing.length > 0) {
              // If we also have a property address, match on both
              const match = streetAddress
                ? existing.find((p: any) => {
                    const propAddr = Array.isArray(p.property)
                      ? p.property[0]?.street_address
                      : p.property?.street_address;
                    return propAddr?.toLowerCase().includes(
                      streetAddress.toLowerCase().split(',')[0].trim()
                    );
                  })
                : existing[0];

              if (match) {
                updateTargets.set(row.rowIndex, match.id);
                actions.set(row.rowIndex, 'update');
              } else {
                actions.set(row.rowIndex, 'include');
              }
            } else {
              actions.set(row.rowIndex, 'include');
            }
          }
        }
      } catch (err: any) {
        alert(`Duplicate check failed: ${err.message}. You can still review and commit manually.`);
      }

      // For properties + entities — map flags to actions
      if (mode !== 'projects') {
        parsed.forEach(row => {
          const rowFlags = flags.filter(f => f.staging_row_index === row.rowIndex);
          const blockingFlag = rowFlags.find(
            f => (f.match_score ?? 99) >= BLOCKING_SCORE || f.match_reason?.includes('Pty/Ltd')
          );
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
      }
    } else {
      // Child section
      const warnings = new Map<number, string>();
      for (const row of parsed) {
        const refAddress = row.parsed.property_street_address;
        const refSuburb = row.parsed.property_suburb;

        if (section.parentKey !== 'property_id' || !refAddress) {
          actions.set(row.rowIndex, 'include');
          continue;
        }

        let query = supabase
          .from('properties')
          .select('id')
          .eq('company_id', cid)
          .ilike('street_address', refAddress.trim())
          .is('deleted_at', null);
        if (refSuburb) query = query.ilike('suburb', refSuburb.trim());
        const { data: existingProperty } = await query.limit(1).single();

        if (!existingProperty) {
          warnings.set(
            row.rowIndex,
            `Property "${refAddress}" not found — a new minimal property record will be created.`
          );
        }
        actions.set(row.rowIndex, 'include');
      }
      setRowParentWarnings(warnings);
    }

    setStagingFlags(flags);
    setRowActions(actions);
    setRowUpdateTarget(updateTargets);
    setStage("review");
  };

  // ── Cycle row action ────────────────────────────────────────────
  const cycleRowAction = (rowIndex: number) => {
    setRowActions(prev => {
      const current = prev.get(rowIndex) || 'include';
      const next: RowAction = current === 'include' ? 'skip'
        : current === 'skip' ? 'update'
        : 'include';
      const updated = new Map(prev);
      updated.set(rowIndex, next);
      return updated;
    });
  };

  const blockedRowsSetToInclude = parsedRows.filter(row => {
    const flags = stagingFlags.filter(f => f.staging_row_index === row.rowIndex);
    const isBlocked = flags.some(f => (f.match_score ?? 99) >= BLOCKING_SCORE);
    return isBlocked && rowActions.get(row.rowIndex) === 'include';
  });

  // ── Commit ──────────────────────────────────────────────────────
  const handleCommit = async () => {
    const section = currentSectionRef.current;
    const mode = baseModeRef.current;
    if (!section || !batchId) return;
    const sectionIsBase = section.targetTable === mode;

    setStage("committing");
    const importLogs: ImportRowResult[] = [];

    const ctx = {
      companyId: companyId || '',
      userId: userId || '',
      batchId,
      baseMode: mode,
      rowUpdateTarget,
    };

    const rowsToProcess = parsedRows.filter(
      r => (rowActions.get(r.rowIndex) || 'include') !== 'skip'
    );

    for (const row of rowsToProcess) {
      const action = rowActions.get(row.rowIndex) || 'include';
      const result = sectionIsBase
        ? await commitBaseRow(row, action, ctx, section)
        : await commitChildRow(row, section, action, ctx);
      importLogs.push(result);
    }

    parsedRows.forEach(row => {
      if ((rowActions.get(row.rowIndex) || 'include') === 'skip') {
        importLogs.push({
          id: '', status: 'failed',
          identifier: row.parsed.street_address || row.parsed.name || `Row ${row.rowIndex}`,
          message: 'Skipped by user during review',
          details: row.parsed,
        });
      }
    });

    // ── Fix: use companyId (now correctly set from active_company_id) ──
    await supabase.from("import_history").insert([{
      id: batchId,
      user_id: userId,
      company_id: companyId,
      target_table: section.targetTable,
      filename: file?.name,
      total_rows: parsedRows.length,
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
    if (!window.confirm("Archive this entry?")) return;
    const { error } = await supabase
      .from(section.targetTable)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (!error) {
      const next = [...results];
      next[index].status = "reversed";
      setResults(next);
      onRefresh();
    }
  };

  if (!isOpen) return null;

  const flagsByRow = new Map<number, StagingFlag[]>();
  stagingFlags.forEach(f => flagsByRow.set(
    f.staging_row_index,
    [...(flagsByRow.get(f.staging_row_index) || []), f]
  ));

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-6 bg-slate-900/40 backdrop-blur-md font-sans antialiased text-slate-600">
      <div className="bg-white w-full max-w-7xl rounded-[40px] shadow-2xl flex flex-col max-h-[92vh]">

        {/* Header */}
        <div className="p-8 border-b border-slate-100 flex justify-between items-center bg-white shrink-0">
          <div>
            <h2 className="text-xl font-light text-slate-900 uppercase tracking-widest leading-none">
              Data synchronization
            </h2>
            <p className="text-[11px] text-slate-400 mt-1 font-medium">
              {stage === 'upload' && 'Step 1 of 3 — choose a section and file'}
              {stage === 'checking' && 'Checking for duplicates and parent records...'}
              {stage === 'review' && 'Step 2 of 3 — review before committing'}
              {stage === 'committing' && 'Writing records...'}
              {stage === 'results' && 'Step 3 of 3 — import complete'}
            </p>
          </div>
          <button
            onClick={() => { onClose(); resetAll(); }}
            className="p-2 text-slate-300 hover:text-black transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
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
                onDownloadTemplate={() => {
                  if (!currentSection) return;
                  const downloadHeaders = currentSection.headers.filter(
                    h => !h.startsWith('relation:')
                  );
                  const labelledHeaders = downloadHeaders.map(h => {
                    if (h.startsWith('custom:')) {
                      const parts = h.split(':');
                      const fieldId = parts[1];
                      const cf = currentSection.customFields?.find((f: any) => f.id === fieldId);
                      if (cf?.label) return cf.label;
                      const fieldKey = parts[2] || '';
                      return fieldKey.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                    }
                    return h.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
                  });
                  const prefix = !isBaseSection ? ['Property Street Address'] : [];
                  const allHeaders = [...prefix, ...labelledHeaders];
                  const blob = new Blob([allHeaders.join(',') + '\n'], { type: 'text/csv' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `diract_${currentSection.key}_template.csv`;
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
              />

              <FileUploader
                file={file}
                onFileSelect={handleFileSelect}
                fileInputRef={fileInputRef}
              />
              <input
                type="file"
                accept=".csv"
                className="hidden"
                ref={fileInputRef}
                onChange={(e) => { if (e.target.files?.[0]) handleFileSelect(e.target.files[0]); }}
              />

              {/* ── CSV Preview — shown immediately after file selected ── */}
              {csvPreviewHeaders.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <FileText size={14} className="text-slate-400" />
                    <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                      File preview — {csvPreviewHeaders.length} columns detected
                    </p>
                  </div>
                  <div className="overflow-x-auto rounded-2xl border border-slate-200">
                    <table className="text-[11px] font-medium w-full">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          {csvPreviewHeaders.map((h, i) => (
                            <th
                              key={i}
                              className="px-4 py-3 text-left text-[9px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap border-r border-slate-100 last:border-0"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {csvPreviewRows.map((row, ri) => (
                          <tr key={ri} className="hover:bg-slate-50">
                            {csvPreviewHeaders.map((_, ci) => (
                              <td
                                key={ci}
                                className="px-4 py-2.5 text-slate-600 border-r border-slate-50 last:border-0 max-w-[200px] truncate"
                              >
                                {row[ci] || <span className="text-slate-300">—</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {csvPreviewRows.length === 0 && (
                      <p className="text-center text-[11px] text-slate-300 py-6 italic">
                        No data rows found
                      </p>
                    )}
                    <p className="text-[10px] text-slate-400 px-4 py-2 border-t border-slate-100 bg-slate-50">
                      Showing first {csvPreviewRows.length} row{csvPreviewRows.length !== 1 ? 's' : ''} of preview
                    </p>
                  </div>
                </div>
              )}
            </>
          )}

          {stage === "checking" && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="animate-spin text-indigo-500" size={28} />
              <p className="text-[12px] font-medium text-slate-400">
                Parsing file and checking for duplicates...
              </p>
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
                <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                  {parsedRows.length} rows parsed
                </p>
                <div className="flex gap-4 text-[10px] font-bold uppercase">
                  {stagingFlags.length > 0 && (
                    <span className="text-amber-600">{stagingFlags.length} possible duplicates</span>
                  )}
                  {rowParentWarnings.size > 0 && (
                    <span className="text-blue-600">{rowParentWarnings.size} new parent records</span>
                  )}
                  <span className="text-indigo-600">
                    {Array.from(rowActions.values()).filter(a => a === 'update').length} updates
                  </span>
                  <span className="text-slate-400">
                    {Array.from(rowActions.values()).filter(a => a === 'skip').length} skipped
                  </span>
                </div>
              </div>

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
                  setParsedRows(prev => prev.map(r => {
                    if (r.rowIndex !== rowIndex) return r;
                    if (field.startsWith('cf:')) {
                      const fieldId = field.replace('cf:', '');
                      return {
                        ...r,
                        customFields: { ...r.customFields, [fieldId]: value },
                      };
                    }
                    return { ...r, parsed: { ...r.parsed, [field]: value } };
                  }));
                  setEditingCell(null);
                }}
                customFieldLabels={customFieldLabels}
              />
            </>
          )}

          {stage === "committing" && (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <Loader2 className="animate-spin text-indigo-500" size={28} />
              <p className="text-[12px] font-medium text-slate-400">Writing records...</p>
            </div>
          )}

          {stage === "results" && (
            <ImportResultsTable results={results} onReverse={handleReverse} customFieldLabels={customFieldLabels}/>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 bg-white border-t border-slate-50 flex justify-between items-center">
          {stage === "review" ? (
            <button
              onClick={() => { if (batchId) clearStaging(batchId); setStage("upload"); }}
              className="flex items-center gap-2 px-6 py-3 text-slate-400 hover:text-slate-700 text-sm font-medium transition-all"
            >
              <ArrowLeft size={16} /> Back
            </button>
          ) : <div />}

          {stage === "upload" && (
            <button
              disabled={!file}
              onClick={handleAnalyze}
              className="px-8 py-4 bg-slate-900 text-white rounded-full text-sm font-medium transition-all hover:bg-black disabled:opacity-30 flex items-center gap-2"
            >
              Analyze file <ArrowRight size={16} />
            </button>
          )}
          {stage === "review" && (
            <button
              onClick={handleCommit}
              className="px-8 py-4 bg-slate-900 text-white rounded-full text-sm font-medium transition-all hover:bg-black flex items-center gap-2"
            >
              Commit {Array.from(rowActions.values()).filter(a => a !== 'skip').length} records
              <ArrowRight size={16} />
            </button>
          )}
          {stage === "results" && (
            <button
              onClick={resetAll}
              className="px-8 py-4 bg-slate-50 border border-slate-200 text-slate-600 rounded-full text-sm font-medium hover:bg-slate-100 transition-all"
            >
              Import another file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}