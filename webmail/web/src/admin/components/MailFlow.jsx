import { useId, useState } from 'preact/hooks';
import Loading from './Loading.jsx';
import LoadError from './LoadError.jsx';

const kinds = { alias: '별칭', team: '팀 분배', filter: '관리자 필터', external: '외부', cycle: '순환' };

function FlowChip({ kind, children }) {
  return <span class={`chip mail-flow-chip is-${kind}`}>{children ?? kinds[kind]}</span>;
}

function Address({ address, domain }) {
  const separator = address.lastIndexOf('@');
  return <span title={address}>{separator > 0 && address.slice(separator + 1) === domain ? address.slice(0, separator + 1) : address}</span>;
}

function FlowWarning({ warning }) {
  return warning?.code === 'FILTER_UNINSPECTABLE' && <span class="mail-flow-warning">필터 #{warning.filterId} 를 해석하지 못해 이 필터의 전달은 빠졌어요.</span>;
}

function FlowCard({ node, parent, domain, direction, nested }) {
  const end = direction === 'out' && !node.children.length && !node.cycle && node.type !== 'alias';
  return <div class={`mail-flow-card${end ? ' is-end' : ''}${node.type === 'external' ? ' is-external' : ''}${node.cycle ? ' is-cycle' : ''}${node.group ? ' is-group' : ''}`}>
    <strong class="mail-flow-address">{node.group ? `구성원 ${node.group.members.length}명` : <Address address={node.address} domain={domain}/>}</strong>
    <div class="mail-flow-card-meta">
      <FlowChip kind={node.kind}/>
      {node.kind === 'filter' && <span>{node.copy ? '사본' : '원본 이동'}</span>}
      {node.type === 'external' && <FlowChip kind="external"/>}
      {node.active === 0 && !node.group && <span class="chip">꺼짐</span>}
      {node.cycle && <FlowChip kind="cycle">순환 · 여기서 멈춤</FlowChip>}
      {nested && <span class="mail-flow-relative"><span aria-hidden="true">{direction === 'in' ? '→' : '←'} </span><Address address={parent} domain={domain}/></span>}
    </div>
    {node.group && <span class="mail-flow-members">{node.group.members.map((member, index) => <span key={member}>{index > 0 && ' · '}<Address address={member} domain={domain}/></span>)}</span>}
    <FlowWarning warning={node.warning}/>
  </div>;
}

function Branches({ nodes, parent, direction, domain, nested = false }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const hidden = !expanded && nodes.length >= 10 ? nodes.length - 9 : 0;
  return <div class="mail-flow-branches">
    <ol class="mail-flow-branches-list" id={listId}>
      {nodes.slice(0, nodes.length - hidden).map(node => <li class="mail-flow-branch" key={`${node.address}:${node.kind}:${node.copy}`}>
        <FlowCard node={node} parent={parent} domain={domain} direction={direction} nested={nested}/>
        {node.children.length > 0 && <Branches nodes={node.children} parent={node.address} direction={direction} domain={domain} nested/>}
      </li>)}
    </ol>
    {hidden > 0 && <button type="button" class="mail-flow-more" aria-controls={listId} aria-expanded="false" onClick={() => setExpanded(true)}>나머지 {hidden}개 펼치기</button>}
  </div>;
}

function stepCount(root) {
  let max = 1;
  const pending = root.children.map(node => [node, 1]);
  while (pending.length) {
    const [node, depth] = pending.pop();
    max = Math.max(max, depth);
    for (const child of node.children) pending.push([child, depth + 1]);
  }
  return max;
}

function FlowSide({ root, direction, count, steps, domain }) {
  const incoming = direction === 'in';
  return <div class={`mail-flow-side is-${direction}`} style={{ '--flow-steps': steps }}>
    <h4 class="mail-flow-side-title">{incoming ? '여기로 오는 주소' : '여기서 가는 곳'}<span class="num">{count ? `${incoming ? '경로' : '끝 메일함'} ${count}` : '0'}</span></h4>
    {root.children.length ? <div class="mail-flow-columns">
      <div class="mail-flow-steps" aria-hidden="true">
        {Array.from({ length: steps }, (_, index) => <span key={index}>{index + 1}단계{incoming ? ' 전' : ''}</span>)}
      </div>
      <Branches nodes={root.children} parent={root.address} direction={direction} domain={domain}/>
    </div> : <p class="mail-flow-empty">{incoming ? '들어오는 별칭·팀 분배·관리자 필터가 없어요.' : '다른 곳으로 넘기지 않아요. 받은 메일은 여기서 끝나요.'}</p>}
  </div>;
}

function FlowChart({ data, name }) {
  const incomingSteps = stepCount(data.incoming), outgoingSteps = stepCount(data.outgoing);
  const domain = data.address.slice(data.address.lastIndexOf('@') + 1);
  return <>
    <div class="mail-flow-container" style={{ '--flow-in': incomingSteps, '--flow-out': outgoingSteps }}>
      <div class="mail-flow-chart">
        <FlowSide root={data.incoming} direction="in" count={data.counts.incoming} steps={incomingSteps} domain={domain}/>
        <div class="mail-flow-center">
          <span class="pic" aria-hidden="true">{(name || data.address).slice(0, 1)}</span>
          <div><strong><Address address={data.address} domain={domain}/></strong><small>이 계정 · {data.outgoing.team ? '팀 메일함' : '메일함'}</small><FlowWarning warning={data.outgoing.warning}/></div>
        </div>
        <FlowSide root={data.outgoing} direction="out" count={data.counts.endMailboxes} steps={outgoingSteps} domain={domain}/>
      </div>
    </div>
    <div class="mail-flow-legend">{Object.keys(kinds).map(kind => <FlowChip key={kind} kind={kind}/>)}</div>
  </>;
}

export default function MailFlow({ result, address, name }) {
  const ready = result.data?.address === address;
  return <section class="detail-section mail-flow" aria-labelledby="mail-flow-title" aria-busy={!ready && !result.error}>
    <div class="section-title">
      <h3 id="mail-flow-title">메일 흐름</h3>
      <div class="mail-flow-links">
        <a class="btn ghost" href="#aliases" aria-label="별칭에서 보기 (메일 흐름)">별칭에서 보기</a>
        <a class="btn ghost" href="#teams" aria-label="팀에서 보기 (메일 흐름)">팀에서 보기</a>
        <a class="btn ghost" href="#filters" aria-label="필터에서 보기 (메일 흐름)">필터에서 보기</a>
      </div>
    </div>
    {result.error ? <LoadError title="메일 흐름을 불러오지 못했습니다" error={result.error} retry={result.reload}/>
      : ready ? <FlowChart data={result.data} name={name}/> : <Loading message="메일 흐름을 불러오는 중…"/>}
  </section>;
}
