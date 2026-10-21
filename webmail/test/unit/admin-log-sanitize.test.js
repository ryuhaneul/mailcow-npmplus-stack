import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSyncResponse, secretParams } from '../../server/admin/log-sanitize.js';
import { sanitizeSyncResponse as legacySanitize } from '../../server/admin/services/sync.js';

test('common sanitizer preserves the sync export identity', () => {
  assert.equal(legacySanitize, sanitizeSyncResponse);
});

test('common sanitizer removes nested credential keys without mutating input or address/IP values', () => {
  const value = {
    id: '1', address: 'sender@example.net', ip: '2001:db8::7', password1: 'SyntheticPassword984',
    nested: [{ API_KEY: 'SyntheticApiKey984', deeper: { 'totp-secret': 'SyntheticTotp984' } }],
    message: 'SyntheticPassword984 SyntheticApiKey984 SyntheticTotp984 sender@example.net 2001:db8::7',
    log: 'sender@example.net*SyntheticMaster984@mailcow.local',
  };
  const before = structuredClone(value);
  assert.deepEqual(sanitizeSyncResponse(value), {
    id: '1', address: 'sender@example.net', ip: '2001:db8::7', nested: [{ deeper: {} }],
    message: '*** *** *** sender@example.net 2001:db8::7', log: 'sender@example.net****@mailcow.local',
  });
  assert.deepEqual(value, before);
});

for (const name of secretParams) {
  for (const quoted of ['SyntheticArgument984', '"Synthetic Argument984"', "'Synthetic Argument984'", String.raw`\"Synthetic Argument984\"`]) {
    test(`common sanitizer masks exact argument ${name} ${quoted}`, () => {
      const value = { custom_params: `--${name.toUpperCase()}=${quoted} --dry`, error: `failed -${name} ${quoted} end` };
      assert.deepEqual(sanitizeSyncResponse(value), { custom_params: `--${name.toUpperCase()}=*** --dry`, error: `failed -${name} *** end` });
    });
  }
}

test('common sanitizer decodes nested JSON and API attr strings before masking related URL values', () => {
  const secret = 'SyntheticOauth984 with space';
  const value = {
    data: `attr='${JSON.stringify({ custom_params: `--oauthaccesstoken1="${secret}" --dry` })}', items='["1"]'`,
    uri: `/api/v1/edit/syncjob?echo=${secret}`,
    call: JSON.stringify(['syncjob', { password1: 'SyntheticNested984', host1: 'imap.example.net' }]),
    message: `failed ${secret} SyntheticNested984`,
  };
  const before = structuredClone(value);
  const result = sanitizeSyncResponse(value, [], ['data', 'uri']);
  assert.ok(!JSON.stringify(result).includes('Synthetic'));
  assert.equal(result.uri, '/api/v1/edit/syncjob?echo=***');
  assert.equal(result.message, 'failed *** ***');
  assert.deepEqual(JSON.parse(result.call), ['syncjob', { host1: 'imap.example.net' }]);
  assert.match(result.data, /--oauthaccesstoken1=/);
  assert.match(result.data, /--dry/);
  assert.deepEqual(value, before);
});

test('common sanitizer masks supplied header, cookie, mail and query canaries in selected text fields', () => {
  const secrets = ['SyntheticHeader984', 'SyntheticCookie984', 'SyntheticBody984', 'SyntheticSubject984', 'SyntheticQuery984'];
  const value = {
    headers: { authorization: `Bearer ${secrets[0]}`, cookie: `session=${secrets[1]}` },
    body: `메일 원문 ${secrets[2]}`, subject: `제목 ${secrets[3]}`, uri: `/search?q=${secrets[4]}`,
    message: secrets.join(' '), address: 'sender@example.net', ip: '192.0.2.7',
  };
  const result = sanitizeSyncResponse(value, secrets, ['authorization', 'cookie', 'body', 'subject', 'uri']);
  for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(result, {
    headers: { authorization: 'Bearer ***', cookie: 'session=***' }, body: '메일 원문 ***', subject: '제목 ***',
    uri: '/search?q=***', message: '*** *** *** *** ***', address: 'sender@example.net', ip: '192.0.2.7',
  });
});

test('common sanitizer preserves structural values and normal noncredential arguments', () => {
  const value = {
    id: '1', status: 'ok', address: 'ok@example.net', ip: '192.0.2.1',
    custom_params: '--folder="token inbox" --dry', message: '1 ok', notice: 'ok', password1: '1',
  };
  assert.deepEqual(sanitizeSyncResponse(value, ['ok']), {
    id: '1', status: 'ok', address: 'ok@example.net', ip: '192.0.2.1',
    custom_params: '--folder="token inbox" --dry', message: '*** ***', notice: '***',
  });
  const plain = 'password1: normal passwd=normal token inbox secret api_key=normal --password1extra=normal --token=normal';
  assert.equal(sanitizeSyncResponse(plain), plain);
});

test('common sanitizer handles top-level text, malformed JSON, arrays and primitives', () => {
  assert.equal(sanitizeSyncResponse('bad --password1=SyntheticPassword984 end'), 'bad --password1=*** end');
  assert.equal(sanitizeSyncResponse('{broken --password1=SyntheticPassword984 end'), '{broken --password1=*** end');
  assert.equal(sanitizeSyncResponse('[{"password1":"SyntheticPassword984","message":"SyntheticPassword984"}]'), '[{"message":"***"}]');
  for (const value of [null, undefined, 0, false]) assert.equal(sanitizeSyncResponse(value), value);
  assert.deepEqual(sanitizeSyncResponse([{ error: 'SyntheticExplicit984' }], ['SyntheticExplicit984', '', null]), [{ error: '***' }]);
});
