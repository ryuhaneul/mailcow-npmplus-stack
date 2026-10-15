import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDocument, messageSandbox, canPreview, partUrl, allowSender, readerRuleSeed } from '../../web/src/reader.js';

test('reader previews match server allowlist and all attachment URL segments are encoded',()=>{
  for(const type of ['image/png','image/jpeg','image/gif','image/webp','application/pdf'])assert.equal(canPreview(type),true,type);
  for(const type of ['image/svg+xml','text/html','application/zip','image/avif'])assert.equal(canPreview(type),false,type);
  assert.equal(partUrl('ref/?#','2.1'),'/api/messages/ref%2F%3F%23/parts/2.1?inline=0');
  assert.equal(partUrl('ref','2',true),'/api/messages/ref/parts/2?inline=1');
});
test('plain text is escaped inside the sandbox document while server HTML stays intact',()=>{
  const style={mode:'dark',fontSize:'15px',ink:'#eee',surface:'#111',link:'#aaf'};
  const text=messageDocument({text:'<script>alert("x")</script> &'},style);
  assert.ok(text.includes('&lt;script&gt;'));assert.ok(!text.includes('<script>'));assert.ok(text.includes('color-scheme:dark'));
  assert.ok(messageDocument({html:'<p>정화된 본문</p>'},style).includes('<p>정화된 본문</p>'));
  assert.equal(messageSandbox,'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  assert.ok(!messageSandbox.includes('allow-scripts'));
});
test('always-show keeps the complete prefs document, deduplicates case-insensitively and does not mutate it',()=>{
  const current={theme:'olive',mode:'dark',accent:{olive:2},layout:null,imageAllow:['sender@example.com'],signatures:{'user@example.com':'서명'},defaultFrom:null,folderColors:{Projects:2}};
  const same=allowSender(current,'SENDER@EXAMPLE.COM');assert.deepEqual(same,current);assert.notEqual(same.imageAllow,current.imageAllow);
  const next=allowSender(current,'NEW@EXAMPLE.COM');assert.deepEqual(next,{...current,imageAllow:['sender@example.com','new@example.com']});assert.equal(current.imageAllow.length,1);
});
test('reader rule seed passes only sender and subject to the shared rule handoff',()=>{
  assert.deepEqual(readerRuleSeed({from:[{address:'sender@example.com'}],subject:'검토 요청',text:'본문 낱말',to:[{address:'user@example.com'}]}),{conditions:[{field:'from',op:'has',value:'sender@example.com'},{field:'subject',op:'has',value:'검토 요청'}],sourceQuery:''});
  assert.deepEqual(readerRuleSeed({from:[],subject:''}).conditions,[]);
});
