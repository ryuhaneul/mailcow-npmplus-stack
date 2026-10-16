import {test} from 'node:test';import assert from 'node:assert/strict';
import {addressList,forwardRows} from '../../web/src/admin/pages/permissions.js';
import {flowParams,flowRecoveryLink} from '../../web/src/admin/flows/distribution.js';
test('AF06 address inputs normalize delimiters without interpreting patterns',()=>assert.deepEqual(addressList(' Team@Example.com;\n@Example.com,team@example.com *'),['team@example.com','@example.com','*']));
test('AF06 separate forwards group destinations without changing paginated items',()=>{const data={items:[{mailbox:'team@example.com'}],forwards:[{mailbox:'move@example.com',to:'one@example.com'},{mailbox:'move@example.com',to:'two@example.com'}]};const rows=forwardRows(data);assert.equal(rows.length,1);assert.deepEqual(rows[0].targets,['one@example.com','two@example.com']);assert.equal(rows[0].editable,false);assert.equal(rows[0].distribution,'move');assert.deepEqual(forwardRows(data,'not-found'),[]);assert.equal(data.items.length,1);});
test('AF06 team flow omits forbidden from/to keys for add/remove and preserves independent switches',()=>{const draft={member:'Person@Example.com',fromTeam:'old@example.com',toTeam:'new@example.com',mode:'add',distribution:false,sendGrant:true};assert.deepEqual(flowParams('team-move',draft),{member:'person@example.com',toTeam:'new@example.com',mode:'add',distribution:false,sendGrant:true});assert.ok(!('toTeam'in flowParams('team-move',{...draft,mode:'remove'})));});
test('AF06 recovery links target the corresponding screen',()=>{assert.equal(flowRecoveryLink({stage:'senders',target:'person@example.com'}),'#permissions/person%40example.com');assert.equal(flowRecoveryLink({stage:'alias',target:'contact@example.com'}),'#aliases/contact%40example.com');assert.equal(flowRecoveryLink({stage:'team.add',target:'team@example.com'}),'#teams/team%40example.com');});

test('multiple option selection converts exactly the selected values across rerenders and back navigation',async()=>{
 const {multipleValues}=await import('../../web/src/admin/flows/helpers.js');
 const options=[{value:'one@example.com',selected:true},{value:'two@example.com',selected:false},{value:'three@example.com',selected:true}];
 const values=multipleValues(options);
 assert.deepEqual(values,['one@example.com','three@example.com']);
 assert.deepEqual(multipleValues(options.map(row=>({...row,selected:values.includes(row.value)}))),values);
 assert.deepEqual(multipleValues(options.map(row=>({...row,selected:false}))),[]);
 assert.deepEqual(flowParams('alias',{alias:'alias@example.com',target:'one@example.com',grantSendTo:values}).grantSendTo,values);
});
test('distribution partial results include every planned stage and each separate sender',async()=>{
 const {completedFlowSteps}=await import('../../web/src/admin/flows/helpers.js');
 const expected=[{stage:'alias',target:'alias@example.com'},{stage:'senders',target:'one@example.com'},{stage:'senders',target:'two@example.com'}];
 const applied=[{...expected[0],status:'ok'},{...expected[1],status:'failed',code:'SYNTHETIC_FAILED'}];
 assert.deepEqual(completedFlowSteps(expected,applied).map(row=>row.status),['ok','failed','not_run']);
 assert.equal(completedFlowSteps(expected,applied)[2].target,'two@example.com');
 assert.equal(completedFlowSteps(expected,applied)[1].code,'SYNTHETIC_FAILED');
});
test('mailbox lifecycle results reflect delete, disable and optional reference cleanup contracts',async()=>{
 const {completedFlowSteps,mailboxLifecycleSteps}=await import('../../web/src/admin/flows/helpers.js');
 const refs={aliases:[{address:'alias@example.com'}],teams:[{mailbox:'team@example.com'}],senders:[{mailbox:'person@example.com'},{mailbox:'person@example.com'}],shares:[{owner:'team@example.com',grantee:'person@example.com'}],syncjobs:[{id:3}]};
 const plan={address:'person@example.com',mode:'delete',cleanRefs:true,refs};
 const expected=mailboxLifecycleSteps(plan);
 assert.deepEqual(expected.map(row=>row.stage),['aliases','teams','senders','shares','syncjobs','mailbox']);
 const result=completedFlowSteps(expected,[{...expected[0],status:'ok'},{stage:'teams',status:'failed',code:'SYNTHETIC_FAILED'}]);
 assert.deepEqual(result.map(row=>row.status),['ok','failed','not_run','not_run','not_run','not_run']);
 assert.deepEqual(mailboxLifecycleSteps({...plan,mode:'disable',forwardTo:'team@example.com'}).map(row=>row.stage),['active','forward','teams','senders','shares','syncjobs']);
 assert.deepEqual(mailboxLifecycleSteps({...plan,mode:'disable',cleanRefs:false}).map(row=>row.stage),['active']);
});
