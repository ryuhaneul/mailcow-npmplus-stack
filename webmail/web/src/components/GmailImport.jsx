import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import { ImportTable, ImportConsent } from './ImportReview.jsx';
import { importErrorMessage } from './ImportResult.jsx';

const xmlErrors = {too_large:'파일은 512KiB까지 올릴 수 있어요.',not_utf8:'UTF-8로 저장한 Gmail 필터 파일을 골라 주세요.',dtd:'DTD가 있는 XML은 가져올 수 없어요.',pi:'처리 명령이 있는 XML은 가져올 수 없어요.',malformed:'XML 형식이 올바르지 않아요.',not_gmail:'Gmail에서 내보낸 필터 XML 파일을 골라 주세요.',too_many_entries:'한 파일에서 필터 1000개까지 읽을 수 있어요.'};
function errorMessage(error) {
  if (error.code === 'XML_INVALID') return xmlErrors[error.detail?.reason ?? error.reason] ?? 'Gmail 필터 파일 형식을 확인해 주세요.';
  if (['IMPORT_PREVIEW_CHANGED','FOLDER_CREATE_FAILED','IMPORT_WRITE_FAILED'].includes(error.code)) return importErrorMessage(error);
  if (error.code === 'IMPORT_NOTHING') return '반영할 수 있는 규칙이 없어요.';
  return error.message ?? '파일을 읽을 수 없어요. 다시 골라 주세요.';
}

export default function GmailImport({ data, onApplied, onBusyChange }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const live = useRef(true);
  const generation = useRef(0);
  const errorNotice = useRef(null);
  useEffect(() => () => {live.current = false; generation.current++; onBusyChange(false);}, []);
  useEffect(() => {onBusyChange(busy);}, [busy]);
  useEffect(() => {if (error) {errorNotice.current?.scrollIntoView({block:'nearest'});errorNotice.current?.focus({preventScroll:true});}}, [error]);
  const existing = data.doc?.rules.length ?? 0;
  async function review(nextFile, mode = existing ? 'append' : undefined, keepPreview = false) {
    const request = ++generation.current;
    setBusy(true); setError(null); setConfirmed(false); if (!keepPreview) setPreview(null);
    try {
      const value = await api('/api/rules/import/xml/preview', {method:'POST',body:{...nextFile,...(mode ? {mode} : {})}});
      if (live.current && request === generation.current) setPreview(value);
    } catch (error) {if (live.current && request === generation.current) setError(error);}
    finally {if (live.current && request === generation.current) setBusy(false);}
  }
  async function pick(event) {
    const selected = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!selected || busy) return;
    setFile(null); setPreview(null); setConfirmed(false); setError(null); setBusy(true);
    try {
      if (selected.size > 512 * 1024) throw {code:'XML_INVALID',reason:'too_large'};
      let xml;
      try {xml = new TextDecoder('utf-8', {fatal:true}).decode(await selected.arrayBuffer());}
      catch {throw {code:'XML_INVALID',reason:'not_utf8'};}
      if (!live.current) return;
      const next = {xml,fileName:selected.name}; setFile(next);
      await review(next);
    } catch (error) {if (live.current) {setError(error);setBusy(false);}}
  }
  async function apply() {
    if (!confirmed || busy || !preview || !preview.plan.applied) return;
    setBusy(true); setError(null);
    try {
      const result = await api('/api/rules/import/xml', {method:'POST',body:{...file,...(preview.plan.mode === 'new' ? {} : {mode:preview.plan.mode}),confirm:true,expect:preview.expect}});
      await onApplied(result);
    } catch (error) {if (live.current) {setError(error);setConfirmed(false);if (['IMPORT_PREVIEW_CHANGED','RULES_STATE','IMPORT_NOTHING'].includes(error.code)) setPreview(null);}}
    finally {if (live.current) setBusy(false);}
  }
  return <div class="gi-body gi-a" aria-busy={busy}>
    {!preview && <><div class="lead"><p>Gmail에서 내보낸 필터 파일을 올리면 규칙마다 새 웹메일에서 어떻게 동작할지 먼저 보여 드려요. 반영할 수 없는 규칙은 이유와 함께 표시하고, 확인한 뒤에 적용해요.</p></div>
    <div class="gi-pick"><span class="gi-pick-i"><Icon name="file"/></span><div><b>Gmail 필터 파일 올리기</b><small>Gmail 설정 → 필터 및 차단된 주소 → 내보내기에서 받은 mailFilters.xml · UTF-8 · 512KiB까지</small></div><label class="btn gi-file">파일 고르기<input type="file" accept=".xml,text/xml,application/xml" aria-label="Gmail 필터 파일 고르기" disabled={busy} onChange={pick}/></label></div></>}
    {busy && <p role="status">필터 처리 중이에요. 잠시만 기다려 주세요.</p>}
    {error && <div ref={errorNotice} class="banner rules-error" role="alert" tabIndex={-1}><div>{errorMessage(error)}</div>{file && <button type="button" class="btn" disabled={busy} onClick={() => review(file, preview?.plan.mode === 'new' ? undefined : preview?.plan.mode)}>미리보기 다시 불러오기</button>}</div>}
    {preview && <>
      <p class="gi-count" role="status"><span class="gi-fname"><Icon name="file" size="s"/>{file.fileName}</span>Gmail 필터 <b>{preview.items.length}</b>개를 읽었어요 — 그대로 <b>{preview.counts.same}</b> · 달라짐 <b>{preview.counts.changed}</b> · 반영 안 됨 <b>{preview.counts.no}</b></p>
      <ImportTable key={`${file.fileName}-${preview.expect.planSha256}`} items={preview.items}/>
      <ImportConsent xml plan={preview.plan} dropped={preview.counts.no} confirmed={confirmed} onChange={setConfirmed} busy={busy} onConfirm={apply} onModeChange={mode => review(file,mode,true)}/>
    </>}
  </div>;
}
