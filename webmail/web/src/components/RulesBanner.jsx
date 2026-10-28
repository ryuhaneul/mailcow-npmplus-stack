export default function RulesBanner({ data, busy, onAction }) {
  const { state, doc, prevAvailable } = data;
  const activeName = data.activeName ?? data.activeScript;
  const messages = {
    none: '아직 저장한 필터가 없어요. 새 규칙을 저장하면 필터가 켜져요.',
    import_pending: '기존 필터에서 반영할 수 있는 규칙만 가져와요. 반영 안 되는 규칙과 달라지는 동작을 확인한 뒤 켜 주세요.',
    import_blocked: '기존 필터를 가져오거나, 끄고 새로 시작할 수 있어요.',
    inactive_other: activeName ? '필터가 다른 프로그램에서 바뀌었어요' : '필터가 꺼져 있어요',
    modified_externally: '다른 곳에서 필터 내용을 고쳤어요. 저장된 웹메일 규칙은 읽기 전용으로 보여요.',
    newer_version: `새 버전 웹메일에서 만든 필터예요. 지금은 볼 수만 있어요. ${activeName === 'webmail-rules' ? '필터는 서버에서 계속 동작해요.' : activeName ? '필터가 다른 프로그램에서 바뀌었어요' : '필터가 꺼져 있어요'}`,
    damaged: '저장된 필터 데이터를 읽을 수 없어요. 지금은 규칙을 고칠 수 없어요.',
  };
  const action = state === 'inactive_other' ? {label: '다시 켜기', path: 'reactivate', detail: activeName ? `지금 켜진 ‘${activeName}’ 필터는 꺼집니다. 지우지는 않아요.` : '저장된 웹메일 필터를 다시 켭니다.'}
    : state === 'modified_externally' ? {label: '웹메일 규칙으로 되돌리기', path: 'restore', body: {source: 'data'}, detail: `다른 곳에서 고친 내용은 사라지고, 웹메일에 저장된 규칙 ${doc?.rules.length ?? 0}개로 다시 만듭니다.`}
    : state === 'damaged' && prevAvailable === true ? {label: '이전 저장본으로 되돌리기', path: 'restore', body: {source: 'prev'}, detail: '손상된 필터를 직전 저장본으로 다시 만듭니다.'} : null;
  if (state === 'ok') return null;
  return <section class="banner rules-banner" aria-label="필터 상태" data-state={state}>
    <div><p>{messages[state]}</p>{state === 'import_blocked' && <p>반영 안 되는 항목을 확인한 뒤 선택해 주세요.</p>}{state === 'damaged' && !prevAvailable && <p>복구할 수 있는 직전 저장본이 없어요. 관리자에게 문의해 주세요.</p>}</div>
    {action && <button class="btn" type="button" disabled={busy} onClick={() => onAction(action)}>{action.label}</button>}
  </section>;
}
