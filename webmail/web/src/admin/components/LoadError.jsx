export default function LoadError({ error, retry, title = '항목을 불러오지 못했습니다' }) {
  return <div class="state" role="alert" data-error-code={error?.code}>
    <p><b>{title}</b></p>
    <p>연결 상태를 확인한 뒤 다시 시도하세요.</p>
    <button class="btn" type="button" onClick={retry}>다시 시도</button>
  </div>;
}
