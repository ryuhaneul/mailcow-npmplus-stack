const fields = {from:'from','보낸사람':'from',to:'to','받는사람':'to',subject:'subject','제목':'subject',in:'folder','폴더':'folder'};
const labels = {from:'보낸 사람',to:'받는 사람',subject:'제목',folder:'폴더',attachment:'첨부',word:'낱말'};
export function parseSearch(query = '') {
  const tokens = []; let value = '', quoted = false, escaped = false;
  for (const char of query) {
    if (escaped) { if (char !== '\\' && char !== '"') value += '\\'; value += char; escaped = false; }
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (/\s/u.test(char) && !quoted) {if(value) tokens.push(value);value='';}
    else value += char;
  }
  if (quoted || escaped) throw {code:'SEARCH_QUERY_INVALID',message:'검색어 형식을 확인해 주세요.'};
  if (value) tokens.push(value);
  const chips = [], conditions = [], textTerms = [];
  for (const token of tokens) {
    const colon=token.indexOf(':'), key=colon<0?'':token.slice(0,colon).toLowerCase(), value=colon<0?token:token.slice(colon+1);
    let field=fields[key];
    if(field && !value) throw {code:'SEARCH_QUERY_INVALID',message:'검색어 형식을 확인해 주세요.'};
    if(!field && ((key==='has' && value==='attachment') || (key==='첨부' && value==='있음')))field='attachment';
    if(!field) {field='word';textTerms.push(token);}
    chips.push({field,label:labels[field],value:field==='attachment'?'있음':field==='word'?token:value});
    if(['from','to','subject','attachment'].includes(field))conditions.push({field,op:'has',value:field==='attachment'?'':value});
  }
  return {chips,conditions,textTerms};
}
