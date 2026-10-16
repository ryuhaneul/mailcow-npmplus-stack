import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountFilters,accountState,referenceRow} from '../../web/src/admin/pages/accounts.js';
import {sieveDisabledWarning} from '../../server/admin/messages.js';
test('AF05 approved account filters retain their order and API values',()=>assert.deepEqual(accountFilters,[['all','전체'],['personal','개인'],['team','팀'],['off','비활성']]));
test('AF05 receiving-only active=2 is never labelled login enabled',()=>{assert.equal(accountState(2),'받기 전용');assert.equal(accountState(1),'사용 중');assert.equal(accountState(0),'비활성');});
test('AF05 alias reference preview distinguishes deleting, removing a target, and keeping',()=>{const row={address:'alias@example.com',targets:['person@example.com']};assert.equal(referenceRow('aliases',{...row,effect:'deleted'})[2],'대상이 비어 함께 삭제');assert.equal(referenceRow('aliases',{...row,effect:'target_removed'})[2],'대상에서 제외');assert.equal(referenceRow('aliases',{...row,effect:'kept'})[2],'유지');});
test('AF05 one shared Sieve warning preserves the server contract',()=>assert.deepEqual(sieveDisabledWarning,{code:'SIEVE_DISABLED',message:'Sieve를 끄면 필터를 저장할 수 없어요.'}));
