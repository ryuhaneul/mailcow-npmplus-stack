import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initialComposition, composePayload, defaultCompositionSignature, selectCompositionSignature, changeCompositionFrom, updateCompositionHtml } from '../../web/src/compose.js';
import { prepareSignatureInline } from '../../server/mail/signature-inline.js';

const dom=new JSDOM(''),previousDocument=globalThis.document;
globalThis.document=dom.window.document;
after(()=>{globalThis.document=previousDocument;dom.window.close();});
const nonce='N'.repeat(32),a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
const cid=id=>`cid:wm-sig-v1.${id}@signature.invalid`;
const token=id=>`cid:wm-compose-v1.${nonce}.${id}@signature.invalid`;
const entry=id=>({token:token(id),assetId:id});
const markers={start:`<!--webmail-signature:${nonce}-->`,end:`<!--/webmail-signature:${nonce}-->`};
const identities={defaultFrom:'sender@example.invalid',identities:[{address:'sender@example.invalid'},{address:'alias@example.invalid'},{address:'none@example.invalid'}]};
const signatures={revision:'synthetic',items:[
  {id:'new',name:'새 메일',html:`<p>회사</p><img src="${cid(a)}" width="160" alt="회사"><img src="${cid(a)}">`},
  {id:'reply',name:'답장',html:`<p>짧은 서명</p><img src="${cid(b)}">`},
  {id:'text',name:'글자',html:'<p>글자 서명</p>'},
  {id:'both',name:'두 이미지',html:`<img src="${cid(a)}"><img src="${cid(c)}">`},
  {id:'empty',name:'빈 서명',html:''},
],defaults:{'sender@example.invalid':{newDefault:'new',replyDefault:'reply'},'alias@example.invalid':{newDefault:'text',replyDefault:'both'},'none@example.invalid':{newDefault:null,replyDefault:null}}};
const images={images:[{id:a,size:17},{id:b,size:23},{id:c,size:31}]};
const original={ref:'synthetic-ref',from:[{address:'other@example.invalid'}],to:[{address:'sender@example.invalid'}],subject:'원문',html:`<P title='old'>이전 메일 &amp; 내용</P><img src="${cid(a)}"><img src="${token(a)}"><!--webmail-signature--><div class="sig">옛 서명</div><!--/webmail-signature-->`,attachments:[{partId:'2',filename:'example.txt',size:7}]};
function initial(kind='new',document=signatures,inventory=images){return initialComposition(kind==='new'?null:{kind,message:original},identities,{},'sender@example.invalid',{signatures:document,images:inventory,nonce});}
function apply(model,result){assert.equal(result.confirmationRequired,false);return {...model,...result.patch};}
function choose(model,id,document=signatures,options={}){return apply(model,selectCompositionSignature(model,id,document,images,options));}
function edit(model,html){return apply(model,updateCompositionHtml(model,html));}
function markup(content){return markers.start+`<div class="sig">${content}</div>`+markers.end;}
function quote(html){return html.slice(html.indexOf('<blockquote>'));}
function serialize(html){const root=document.createElement('template');root.innerHTML=html;return root.innerHTML;}

for(const kind of ['new','reply','replyall','forward']){
  test(`${kind} selects the address default and emits exact session tokens, manifest and bytes`,()=>{
    const model=initial(kind),isNew=kind==='new',id=isNew?a:b;
    assert.equal(model.selectedSignatureId,isNew?'new':'reply');assert.equal(model.signatureNonce,nonce);
    assert.deepEqual(model.signatureImages,[entry(id)]);assert.equal(model.signatureImageBytes,isNew?17:23);
    assert.deepEqual(model.signatureImageSizes,{[id]:isNew?17:23});assert.equal(model.signatureDirty,false);
    const content=isNew?`<p>회사</p><img src="${token(a)}" width="160" alt="회사"><img src="${token(a)}">`:`<p>짧은 서명</p><img src="${token(b)}">`;
    assert.equal(model.html.slice(model.signatureRange.start,model.signatureRange.end),markup(content));
    assert.ok(model.html.startsWith('<p><br></p>'+markup(content)));
    if(!isNew){assert.ok(quote(model.html).endsWith(original.html+'</blockquote>'));assert.equal(model.html.indexOf(markers.start)<model.html.indexOf('<blockquote>'),true);}
    assert.equal(signatures.items[0].html.includes('wm-compose-v1'),false);
  });
}

test('null defaults select none for every composition kind and missing addresses',()=>{
  const document={...signatures,defaults:{'sender@example.invalid':{newDefault:null,replyDefault:null}}};
  for(const kind of ['new','reply','replyall','forward']){
    const model=initial(kind,document);assert.equal(model.selectedSignatureId,null);assert.equal(model.signatureRange,null);
    assert.deepEqual(model.signatureImages,[]);assert.equal(model.signatureImageBytes,0);assert.ok(!model.html.includes(markers.start));
  }
  assert.equal(defaultCompositionSignature(signatures,'missing@example.invalid','reply'),null);
  assert.equal(defaultCompositionSignature(signatures,'SENDER@EXAMPLE.INVALID','new'),'new');
});

test('replacement and none atomically update the model without touching authored bytes, quoted mail or files',()=>{
  const first=initial('forward'),authored="<P title='authored'>나의 &amp; 본문</P>\n";
  const model=edit(first,authored+first.html);model.attachments=[{id:'upload',size:11}];model.draftRef='draft-a';
  const frozen=structuredClone(model),oldQuote=quote(model.html),replacement=selectCompositionSignature(model,'both',signatures,images);
  assert.deepEqual(model,frozen);
  const next=apply(model,replacement);assert.equal(next.selectedSignatureId,'both');assert.deepEqual(next.signatureImages,[entry(a),entry(c)]);
  assert.equal(next.signatureImageBytes,48);assert.deepEqual(next.signatureImageSizes,{[a]:17,[c]:31});assert.equal(next.signatureDirty,false);
  assert.equal(quote(next.html),oldQuote);assert.ok(next.html.startsWith(authored));assert.deepEqual(next.attachments,model.attachments);assert.deepEqual(next.forwardFiles,model.forwardFiles);assert.equal(next.draftRef,'draft-a');
  const none=choose(next,null);assert.equal(none.selectedSignatureId,null);assert.equal(none.signatureRange,null);assert.deepEqual(none.signatureImages,[]);assert.equal(none.signatureImageBytes,0);
  assert.equal(none.html,authored+first.html.slice(0,first.signatureRange.start)+first.html.slice(first.signatureRange.end));
});

test('body copies keep their manifest and unique size after replacement or none; removing the last reference clears them',()=>{
  let model=initial();model=edit(model,`<img src="${token(a)}"><img src="${token(a)}">`+model.html);
  model=choose(model,'both');assert.deepEqual(model.signatureImages,[entry(a),entry(c)]);assert.equal(model.signatureImageBytes,48);
  model=choose(model,'reply');assert.deepEqual(model.signatureImages,[entry(a),entry(b)]);assert.equal(model.signatureImageBytes,40);
  model=choose(model,null);assert.deepEqual(model.signatureImages,[entry(a)]);assert.equal(model.signatureImageBytes,17);
  model=edit(model,model.html.replaceAll(`<img src="${token(a)}">`,''));assert.deepEqual(model.signatureImages,[]);assert.equal(model.signatureImageBytes,0);
});

test('only quoted references do not keep a removed image manifest or bytes',()=>{
  let model=initial();model=edit(model,model.html+`<blockquote><img src="${token(a)}"></blockquote>`);
  model=choose(model,null);assert.deepEqual(model.signatureImages,[]);assert.equal(model.signatureImageBytes,0);assert.ok(model.html.includes(token(a)));
});

test('from changes choose new/reply defaults and clear previous image accounting',()=>{
  for(const kind of ['new','reply','replyall','forward']){
    let model=initial(kind),oldQuote=kind==='new'?null:quote(model.html);
    model=apply(model,changeCompositionFrom(model,'alias@example.invalid',signatures,images));
    assert.equal(model.from,'alias@example.invalid');assert.equal(model.selectedSignatureId,kind==='new'?'text':'both');
    assert.deepEqual(model.signatureImages,kind==='new'?[]:[entry(a),entry(c)]);assert.equal(model.signatureImageBytes,kind==='new'?0:48);
    if(oldQuote)assert.equal(quote(model.html),oldQuote);
    model=apply(model,changeCompositionFrom(model,'none@example.invalid',signatures,images));
    assert.equal(model.from,'none@example.invalid');assert.equal(model.selectedSignatureId,null);assert.deepEqual(model.signatureImages,[]);assert.equal(model.signatureImageBytes,0);
  }
});

for(const target of ['reply',null,'from']){
  test(`dirty signature requires confirmation before ${target}; cancel preserves all fields, confirm replaces atomically`,()=>{
    const first=initial(),model=edit(first,first.html.replace('<p>회사</p>','<p>이 메일에서 고침</p>')),before=structuredClone(model);
    assert.equal(model.signatureDirty,true);assert.equal(signatures.items[0].html.includes('이 메일'),false);
    const attempt=confirm=>target==='from'?changeCompositionFrom(model,'alias@example.invalid',signatures,images,{confirm}):selectCompositionSignature(model,target,signatures,images,{confirm});
    assert.deepEqual(attempt(false),{confirmationRequired:true,patch:null});assert.deepEqual(model,before);
    const next=apply(model,attempt(true));assert.equal(next.signatureDirty,false);assert.equal(next.from,target==='from'?'alias@example.invalid':model.from);
    assert.equal(next.selectedSignatureId,target==='from'?'text':target);assert.equal(next.html.includes('이 메일에서 고침'),false);
    assert.equal(next.signatureImageBytes,target==='reply'?23:0);assert.deepEqual(model,before);
  });
}

test('body and quote edits plus browser serialization stay clean; signature edits and removed boundaries become dirty',()=>{
  const first=initial('reply');
  let model=edit(first,`<p>본문 수정</p>`+first.html.replace('이전 메일 &amp; 내용','인용문 수정'));
  assert.equal(model.signatureDirty,false);
  model=edit(model,serialize(model.html));assert.equal(model.signatureDirty,false);
  model=edit(model,model.html.replace('짧은 서명','고친 서명'));assert.equal(model.signatureDirty,true);
  model=edit(model,model.html.replace('고친 서명','짧은 서명'));assert.equal(model.signatureDirty,false);
  model=edit(model,model.html.replace(markers.start,''));assert.equal(model.signatureDirty,true);assert.equal(model.signatureRange,null);
  assert.equal(selectCompositionSignature(model,null,signatures,images).confirmationRequired,true);
});

test('quoted old markers, canonical CIDs, this-session markers and tokens are never replaced or tokenized',()=>{
  const quoted=`<blockquote>${markers.start}<div class="sig">옛 서명<img src="${cid(a)}"><img src="${token(a)}"></div>${markers.end}<blockquote><img src="${cid(b)}"></blockquote></blockquote>`;
  const first=initial(),model=edit(first,quoted+first.html),next=choose(model,'reply');
  assert.ok(next.html.startsWith(quoted));assert.deepEqual(next.signatureImages,[entry(b)]);assert.equal(next.signatureImageBytes,23);
  assert.ok(choose(next,null).html.startsWith(quoted));
});

test('selected signature quote images stay canonical; external, received and non-img sources remain unchanged',()=>{
  const html=`<img src="${cid(a)}"><blockquote><img src="${cid(b)}"></blockquote><img src="cid:received@example.invalid"><img src="https://example.invalid/logo.png"><p>${cid(c)}</p><a href="${cid(c)}">링크</a>`;
  const document={...signatures,items:[...signatures.items,{id:'quoted',name:'인용 포함',html}]};
  const model=choose(initial(),'quoted',document);assert.deepEqual(model.signatureImages,[entry(a)]);assert.equal(model.signatureImageBytes,17);
  assert.ok(model.html.includes(`<blockquote><img src="${cid(b)}"></blockquote>`));assert.ok(model.html.includes(`<p>${cid(c)}</p>`));assert.ok(model.html.includes(`<a href="${cid(c)}">`));
});

test('marker text inside attributes and scripts is not mistaken for the current signature range',()=>{
  const first=initial(),prefix=`<p title='${markers.start}${markers.end}'>글</p><script>"${markers.start}${markers.end}"</script>`;
  const model=edit(first,prefix+first.html);assert.equal(model.signatureDirty,false);assert.equal(model.signatureRange.start,prefix.length+first.signatureRange.start);
  const next=choose(model,null);assert.equal(next.html,prefix+'<p><br></p>');
});

test('missing range inserts before quoted mail and never replaces old generic markers',()=>{
  let model=initial('reply');model=choose(model,null);
  const before=model.html,next=choose(model,'text');assert.equal(quote(next.html),quote(before));assert.equal(next.html,before.slice(0,before.indexOf('<blockquote>'))+markup('<p>글자 서명</p>')+quote(before));
  assert.equal(next.html.includes('<!--webmail-signature--><div class="sig">옛 서명'),true);
});

test('empty signatures, deleted open selections and same-selection no-ops retain the copied composition',()=>{
  const model=choose(initial(),'empty');assert.equal(model.selectedSignatureId,'empty');assert.equal(model.html,'<p><br></p>'+markup(''));assert.equal(model.signatureDirty,false);assert.equal(model.signatureImageBytes,0);
  const deleted={...signatures,items:[]},before=structuredClone(model);
  assert.deepEqual(selectCompositionSignature(model,'empty',deleted,images),{confirmationRequired:false,patch:{}});assert.deepEqual(model,before);
  assert.deepEqual(changeCompositionFrom(model,model.from,deleted,images),{confirmationRequired:false,patch:{}});
  assert.throws(()=>selectCompositionSignature(model,'missing',deleted,images),{code:'SIGNATURE_INVALID'});
});

test('same default on a different address still requires confirmation of dirty content',()=>{
  const document={...signatures,defaults:{...signatures.defaults,'alias@example.invalid':{newDefault:'new',replyDefault:'reply'}}};
  const first=initial(),model=edit(first,first.html.replace('회사','수정'));
  assert.deepEqual(changeCompositionFrom(model,'alias@example.invalid',document,images),{confirmationRequired:true,patch:null});
  const next=apply(model,changeCompositionFrom(model,'alias@example.invalid',document,images,{confirm:true}));assert.equal(next.from,'alias@example.invalid');assert.equal(next.signatureDirty,false);assert.deepEqual(next.signatureImages,[entry(a)]);
});

test('legacy data and missing assets fail without changing the open model',()=>{
  const model=initial(),before=structuredClone(model);
  for(const src of ['data:image/png;base64,AAAA','DaTa:image/png;base64,AAAA','data&#58;image/png;base64,AAAA',' d a t a :image/png;base64,AAAA']){
    const document={...signatures,items:[{id:'legacy',name:'예전',html:`<img src="${src}">`}]};
    assert.throws(()=>selectCompositionSignature(model,'legacy',document,images),{code:'SIGNATURE_DATA_IMAGE_UNSUPPORTED'});
    assert.throws(()=>initial('new',{...document,defaults:{'sender@example.invalid':{newDefault:'legacy',replyDefault:null}}}),{code:'SIGNATURE_DATA_IMAGE_UNSUPPORTED'});
  }
  const quotedData={...signatures,items:[{id:'quoted-data',name:'예전 인용',html:'<blockquote><img src="data:image/png;base64,AAAA"></blockquote>'}]};
  assert.throws(()=>selectCompositionSignature(model,'quoted-data',quotedData,images),{code:'SIGNATURE_DATA_IMAGE_UNSUPPORTED'});
  assert.throws(()=>selectCompositionSignature(model,'both',signatures,{images:[]}),{code:'SIGNATURE_IMAGE_NOT_FOUND'});assert.deepEqual(model,before);
});

test('injected nonce is exact; generated nonces have 24 random bytes and independent sessions',()=>{
  const options={signatures,images};
  const one=initialComposition(null,identities,{},'sender@example.invalid',options),two=initialComposition(null,identities,{},'sender@example.invalid',options);
  assert.match(one.signatureNonce,/^[A-Za-z0-9_-]{32}$/);assert.notEqual(one.signatureNonce,two.signatureNonce);assert.notEqual(one.signatureImages[0].token,two.signatureImages[0].token);
  assert.throws(()=>initialComposition(null,identities,{},'sender@example.invalid',{...options,nonce:'bad'}),{code:'SIGNATURE_INVALID'});
});

test('draft/send payloads own a manifest snapshot and omit UI state; replacement cannot alter save A',()=>{
  const model=initial('forward');model.attachments=[{id:'upload',size:5}];model.to=[{address:'target@example.invalid'}];
  const snapshot=composePayload(model),html=snapshot.html,manifest=structuredClone(snapshot.signatureImages);
  const next=choose(model,'both');assert.equal(snapshot.html,html);assert.deepEqual(snapshot.signatureImages,manifest);assert.notDeepEqual(snapshot.signatureImages,next.signatureImages);
  assert.notEqual(snapshot.signatureImages,model.signatureImages);assert.notEqual(snapshot.signatureImages[0],model.signatureImages[0]);
  assert.deepEqual(composePayload(next,true).signatureImages,[entry(a),entry(c)]);assert.deepEqual(snapshot.attachmentIds,['upload']);assert.deepEqual(snapshot.forwardParts,[{ref:'synthetic-ref',partId:'2'}]);
  for(const key of ['signatureNonce','signatureRange','signatureBaseline','signatureDirty','signatureImageBytes','signatureImageSizes','selectedSignatureId'])assert.equal(key in snapshot,false);
});

test('client tokens and manifest satisfy the server inline contract and count unique bytes exactly',()=>{
  const model=initial(),serverImages={[a]:{name:'synthetic.png',contentType:'image/png',base64:Buffer.alloc(17).toString('base64')}};
  const result=prepareSignatureInline({...composePayload(model),images:serverImages,nonce:'S'.repeat(32)});
  assert.equal(result.totalBytes,model.signatureImageBytes);assert.equal(result.parts.length,1);
  assert.equal(result.html.split('cid:wm-inline-v1.').length-1,2);assert.equal(result.html.includes('wm-compose-v1.'),false);
});


test('manifest has no entry count cap and deduplicates both tokens and asset sizes',()=>{
  const first=initial(),entries=Array.from({length:25},(_,index)=>({token:`cid:wm-compose-v1.${String(index).padStart(32,'0')}.${a}@signature.invalid`,assetId:a}));
  const html=entries.map(({token})=>`<img src="${token}"><img src="${token}">`).join('');
  const model={...first,signatureImages:[...entries,...entries],signatureImageSizes:{[a]:17}};
  const result=updateCompositionHtml(model,html).patch;
  assert.deepEqual(result.signatureImages,entries);assert.equal(result.signatureImages.length,25);assert.equal(result.signatureImageBytes,17);assert.deepEqual(result.signatureImageSizes,{[a]:17});
  const inline=prepareSignatureInline({html,signatureImages:result.signatureImages,images:{[a]:{name:'synthetic.png',contentType:'image/png',base64:Buffer.alloc(17).toString('base64')}},nonce:'S'.repeat(32)});
  assert.equal(inline.parts.length,1);assert.equal(inline.totalBytes,17);
});
