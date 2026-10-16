import AdminIcon from './AdminIcon.jsx';
export default function FlowSteps({ step }) {
  return <ol class="ac-progress" aria-label="진행 단계">{['입력', '미리보기', '실행 확인', '결과'].map((title, index) => <li class={index === step ? 'ac-current' : index < step ? 'ac-done' : ''} aria-current={index === step ? 'step' : undefined} key={title}><span>{index < step ? <AdminIcon name="check"/> : String(index + 1).padStart(2, '0')}</span>{title}</li>)}</ol>;
}
