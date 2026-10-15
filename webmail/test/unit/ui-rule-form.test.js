import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardStatus, personalFolder, ruleProblem, seededConditions } from '../../web/src/components/rule-form.js';
import { parseRoute } from '../../web/src/router.js';
const folder = {path:'Projects',name:'프로젝트'};
const rule = {id:'abcd1234',enabled:true,match:'all',conditions:[{field:'subject',op:'has',value:'회의'}],actions:{move:'Projects'},stop:false};
test('rule hash query decodes seed values without confusing slash or ampersand', () => {
  const route = parseRoute('#rule?from=sales%40example.com&subject=A%2FB%26C&attachment=has');
  assert.equal(route.name,'rule');assert.equal(route.value,'');
  assert.deepEqual(seededConditions(route.query),[{field:'from',op:'has',value:'sales@example.com'},{field:'subject',op:'has',value:'A/B&C'},{field:'attachment',op:'has',value:''}]);
  assert.equal(parseRoute('#rule/abcd1234').value,'abcd1234');
});
test('forward policy accepts only exact configured domains and 1–3 valid addresses', () => {
  const domains=['example.com'];
  assert.equal(forwardStatus('user@EXAMPLE.com, team@example.com',domains).valid,true);
  for(const value of ['user@external.example.org','user@sub.example.com','user@example.com.evil.test'])assert.equal(forwardStatus(value,domains).external,true);
  for(const value of ['', 'a..b@example.com','a@example.com,','a@example.com,b@example.com,c@example.com,d@example.com','a@example.com\n','a@-example.com'])assert.equal(forwardStatus(value,domains).valid,false,value);
  assert.equal(forwardStatus('user@example.com',[]).valid,false);
});
test('move choices exclude shared, virtual, system and unsafe folders', () => {
  assert.equal(personalFolder(folder),true);
  for(const value of [{path:'INBOX'},{path:'Trash'},{path:'Junk'},{path:'Drafts'},{path:'Shared/a'},{path:'WebmailVirtual/AllMail'},{path:'Private',shared:true},{path:'Private',virtual:true},{path:'Private',personal:false},{path:'Other',specialUse:'\\Inbox'},{path:'bad\nfolder'},{path:'${folder}'}])assert.equal(personalFolder(value),false,JSON.stringify(value));
});
test('rule validation blocks unsafe conditions, missing folders, empty actions and move/trash', () => {
  assert.equal(ruleProblem(rule,[folder],[],''),null);
  assert.equal(ruleProblem({...rule,conditions:[{field:'subject',op:'has',value:'\u{1F4E7}'.repeat(200)}]},[folder],[],''),null);
  for(const value of ['', '${name}', 'x\n', 'x'.repeat(201)])assert.ok(ruleProblem({...rule,conditions:[{field:'from',op:'has',value}]},[folder],[],''));
  assert.ok(ruleProblem({...rule,conditions:Array(11).fill(rule.conditions[0])},[folder],[],''));
  assert.ok(ruleProblem(rule,[],[],''));
  assert.ok(ruleProblem({...rule,actions:{move:'Projects',trash:true}},[folder],[],''));
  assert.ok(ruleProblem({...rule,actions:{}},[folder],[],''));
  assert.ok(ruleProblem({...rule,actions:{forward:['user@external.example.org']}},[folder],['example.com'],'user@external.example.org'));
});
