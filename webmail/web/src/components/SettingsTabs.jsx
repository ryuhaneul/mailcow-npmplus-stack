import { route } from '../router.js';

export default function SettingsTabs() {
  const current=route.value.name==='rule'?'filters':route.value.name;
  return <nav class="tabs" aria-label="설정">{[['settings','보기'],['shared','공유 메일함'],['filters','필터·규칙'],['storage','저장 공간'],['password','암호']].map(([name,label])=><a key={name} href={`#${name}`} aria-current={current===name?'page':undefined}>{label}</a>)}</nav>;
}
