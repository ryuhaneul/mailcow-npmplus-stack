import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { installHeaders, securityHeaders } from '../../server/security/headers.js';

test('only the normalized starflow path permits same-origin framing', async t => {
  const app = Fastify();
  installHeaders(app);
  app.get('/*', (request, reply) => {
    if (request.url.startsWith('/api/messages/')) {
      return reply.header('content-disposition', 'attachment; filename="example.txt"').send(Buffer.from('Synthetic attachment'));
    }
    return reply.send('Synthetic document');
  });
  t.after(() => app.close());
  for (const path of ['/starflow/index.html', '/starflow/stars.js', '/starflow/stars.css?cache=1']) {
    const response = await app.inject(path);
    assert.equal(response.headers['content-security-policy'], securityHeaders['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), path);
  }
  for (const path of ['/', '/api/config', '/api/messages/ref/attachments/1', '/starflow-other/index.html', '/api/config?next=/starflow/index.html', '/starflow/../api/config', '/starflow/%2e%2e/api/config', '/starflow/%2e%2e%2fapi/config', '/starflow/%3f/../../api/config', '/starflow%5c..%5capi/config', '/starflow/%3f%2f..%2f..%2fapi/config']) {
    const response = await app.inject(path);
    assert.equal(response.headers['content-security-policy'], securityHeaders['content-security-policy'], path);
    for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers[name], value, `${path}: ${name}`);
  }
});
