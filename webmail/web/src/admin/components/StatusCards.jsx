import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';
import { statusCards } from '../pages/status.js';
export default function StatusCards({ resource }) {
  const cards = resource.data ? statusCards(resource.data) : ['메일 큐', '차단 IP', '인증서 만료까지', '디스크 사용량'].map((label, key) => ({ key, label }));
  return <div class="stats" aria-label="주요 상태">{cards.map(card => <section class="stat" data-status-card={card.key} key={card.key}><span class="label">{card.label}</span>
    {resource.loading ? <Loading/> : resource.error || card.error ? <LoadError error={resource.error ?? { code: card.error }} title={`${card.label} 정보를 불러오지 못했습니다`} retry={resource.reload}/> : <><div class="value num">{card.value}<small>{card.unit}</small></div>{card.note && <p>{card.note}</p>}</>}
  </section>)}</div>;
}
