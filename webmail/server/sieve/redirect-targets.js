import { AppError } from '../errors.js';
import { tokens } from './import-syntax.js';

// Preserve the existing administrator filter reader contract.
const addressPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
const normalize = value => value.trim().toLowerCase();
const uninspectable = () => new AppError(422, 'FILTER_UNINSPECTABLE', '전달 대상을 안전하게 해석할 수 없는 필터예요.');

export function inspectRedirects(source) {
  if (typeof source !== 'string') throw uninspectable();
  let values; try { values = tokens(source); } catch { throw uninspectable(); }
  const redirects = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 'redirect') continue;
    let index = i + 1, copy = false;
    while (typeof values[index] === 'string' && values[index].startsWith(':')) {
      if (values[index] !== ':copy' || copy) throw uninspectable(); copy = true; index++;
    }
    const targets = [];
    if (values[index] === '[') {
      index++;
      for (;;) {
        if (!values[index] || typeof values[index] !== 'object') throw uninspectable(); targets.push(values[index++].string);
        if (values[index] === ']') { index++; break; }
        if (values[index++] !== ',') throw uninspectable();
      }
    } else {
      if (!values[index] || typeof values[index] !== 'object') throw uninspectable(); targets.push(values[index++].string);
    }
    if (values[index] !== ';' || targets.some(target => typeof target !== 'string' || target.includes('${') || !addressPattern.test(target))) throw uninspectable();
    for (const target of targets) redirects.push({ target: normalize(target), copy });
    i = index;
  }
  return redirects;
}

// Retirement checks must also reject opaque commands that can hide delivery.
export function retirementRedirects(source) {
  const redirects = inspectRedirects(source), values = tokens(source);
  const commands = new Set(['require','if','elsif','else','keep','stop','discard','redirect','fileinto','set','setflag','addflag','removeflag','vacation','addheader','deleteheader','reject','ereject']);
  const opaque = new Set(['include','pipe','execute','notify','enotify']);
  const stack = [], pairs = { '[':']', '(':')', '{':'}' };
  let start = true;
  for (const value of values) {
    if (typeof value === 'object') { if (start) throw uninspectable(); continue; }
    if (opaque.has(value)) throw uninspectable();
    if (value === '}') { if (!start || stack.pop() !== '}') throw uninspectable(); start = true; continue; }
    if (start) { if (!commands.has(value)) throw uninspectable(); start = false; }
    if (Object.hasOwn(pairs,value)) { stack.push(pairs[value]); if (value === '{') start = true; }
    else if ([']',')'].includes(value)) { if (stack.pop() !== value) throw uninspectable(); }
    else if (value === ';') { if (stack.at(-1) && stack.at(-1) !== '}') throw uninspectable(); start = true; }
  }
  if (stack.length || !start) throw uninspectable();
  return redirects;
}
