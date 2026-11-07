import { useLayoutEffect, useRef } from 'preact/hooks';
import { route } from '../router.js';

export default function SettingsTabs() {
  const current=route.value.name==='rule'?'filters':route.value.name;
  const node = useRef();
  useLayoutEffect(() => {
    if (current !== 'otp') return;
    const tabs = node.current;
    const reveal = () => { if (node.current === tabs) tabs?.querySelector('[aria-current=page]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); };
    reveal();
    void document.fonts?.ready.then(reveal);
  }, [current]);
  return <nav ref={node} class="tabs" aria-label="설정">{[['settings','보기'],['shared','공유 메일함'],['filters','필터·규칙'],['storage','저장 공간'],['password','암호'],['otp','2단계 인증']].map(([name,label])=><a key={name} href={`#${name}`} aria-current={current===name?'page':undefined}>{label}</a>)}</nav>;
}
