import { useState } from 'preact/hooks';
import Notice from '../components/Notice.jsx';
import { partialTeamRecovery, connectionRecovery } from './helpers.js';
export function InitialPasswords({ rows }) {
  const [copied, setCopied] = useState('');
  return <>{rows.filter(row => row.password).map((row, index) => <Notice key={row.line ?? index}><p>초기 암호는 한 번만 표시됩니다. 이 화면을 벗어나면 다시 볼 수 없습니다.</p><p>{row.email ?? row.address} <code data-initial-password>{row.password}</code> <button class="btn" type="button" onClick={async () => { try { await navigator.clipboard.writeText(row.password); setCopied(String(index)); } catch { setCopied('failed'); } }}>암호 복사</button></p>{copied === String(index) && <p role="status">복사했어요.</p>}{copied === 'failed' && <p role="status">암호를 선택해 복사해 주세요.</p>}</Notice>)}</>;
}
export function Recovery({ row, team }) {
  if (row.result !== 'partial') return null;
  const failed = row.steps?.find(item => item.status === 'failed'), message = row.recovery?.join(' ') ?? (failed?.stage === 'team' ? partialTeamRecovery : connectionRecovery);
  return <Notice tone="warn"><p>{message}</p><a href={`#accounts/${encodeURIComponent(row.email ?? row.address)}`}>계정에서 마저 하기</a>{(team || failed?.stage === 'team') && <> · <a href={team ? `#teams/${encodeURIComponent(team)}` : '#teams'}>팀에서 마저 하기</a></>}</Notice>;
}
export function JoinResult({ row, draft }) {
  const steps = [{ stage: 'mailbox', label: '메일함' }, ...(draft.team ? [{ stage: 'team', label: '팀 배정' }] : []), ...(draft.alias ? [{ stage: 'alias', label: '별칭' }] : []), ...(draft.send ? [{ stage: 'permissions', label: '보내기 권한' }] : [])];
  return <><h2>{row.result === 'ok' ? '입사 처리 완료' : '입사 처리 · 단계별 결과'}</h2><div class="table-wrap"><table><thead><tr><th>단계</th><th>결과</th><th>확인</th></tr></thead><tbody>{steps.map(item => { const applied = row.steps?.find(step => step.stage === item.stage); return <tr key={item.stage}><td>{item.label}</td><td>{applied?.status === 'ok' ? '성공' : applied?.status === 'failed' ? '실패' : '실행 안 함'}</td><td>{applied?.code ?? ''}</td></tr>; })}</tbody></table></div><Recovery row={row} team={draft.team}/><InitialPasswords rows={[row]}/><a class="btn" href={`#accounts/${encodeURIComponent(row.address ?? draft.address)}`}>생성한 메일함 상세</a></>;
}
export function CsvResults({ rows }) {
  return <><h2>일괄 작업 결과</h2><div class="table-wrap"><table><thead><tr><th>줄</th><th>대상</th><th>실행 결과</th><th>다음 단계</th></tr></thead><tbody>{rows.map(row => <tr key={row.line}><td>{row.line}</td><td>{row.email ?? row.address}</td><td>{({ ok: '성공', failed: '실패', partial: '일부 적용', unknown: '결과 확인 불가', not_run: '실행 안 함' })[row.result]}{row.code && <small>{row.code}</small>}</td><td>{row.error ?? (row.result === 'unknown' ? '결과 확인 불가 — 계정 목록에서 확인해 주세요' : row.result === 'not_run' ? '인증이 끝나 실행하지 않았습니다.' : '')}{row.result === 'partial' && <Recovery row={row} team={row.teamAddress}/>}</td></tr>)}</tbody></table></div><InitialPasswords rows={rows}/></>;
}
