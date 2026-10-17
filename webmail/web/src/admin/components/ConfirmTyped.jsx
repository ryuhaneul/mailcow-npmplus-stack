export default function ConfirmTyped({ expected, value, onChange }) {
  return <div class="field"><label for="confirm-address">확인을 위해 메일 주소를 직접 입력하세요.</label><p>{expected}</p><input id="confirm-address" autoComplete="off" value={value} onInput={event => onChange(event.currentTarget.value)} required pattern={expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/></div>;
}
