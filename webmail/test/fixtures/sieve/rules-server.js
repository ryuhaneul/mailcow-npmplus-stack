import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import assert from 'node:assert/strict';

export async function rulesServer(t, { certificate, privateKey, scripts = [], activeName = null }) {
  const state = { scripts: new Map(scripts), activeName, commands: [], reject: null };
  const sockets = new Set();
  const context = tls.createSecureContext({ cert: certificate, key: privateKey });
  const server = net.createServer(plain => {
    plain.setNoDelay(true); sockets.add(plain); plain.on('error', () => {});
    let socket = plain, input = Buffer.alloc(0), authenticated = false;
    const send = value => socket.write(value);
    function greeting(secure) { send(`"SASL" "PLAIN"\r\n"SIEVE" "fileinto imap4flags variables copy vacation date relational"\r\n${secure ? '' : '"STARTTLS"\r\n'}OK\r\n`); }
    function execute(line, literal) {
      const verb = line.split(' ')[0];
      if (verb === 'AUTHENTICATE') {
        const encoded = /^AUTHENTICATE "PLAIN" "([A-Za-z0-9+/=]+)"$/.exec(line)?.[1];
        authenticated = encoded && Buffer.from(encoded, 'base64').toString() === '\0user@example.com\0synthetic-sieve-password';
        assert.ok(socket.encrypted); assert.ok(authenticated);
        state.commands.push({ command: verb }); send('OK\r\n'); return;
      }
      const name = /^\w+ "((?:[^"\\]|\\["\\])*)"/.exec(line)?.[1].replace(/\\(["\\])/g, '$1');
      state.commands.push({ command: verb, ...(name === undefined ? {} : { name }), ...(literal === undefined ? {} : { script: literal }) });
      if (verb === 'STARTTLS') {
        plain.off('data', consume);
        plain.write('OK\r\n', () => {
          socket = new tls.TLSSocket(plain, { isServer: true, secureContext: context }); sockets.add(socket);
          socket.on('error', () => {}); socket.on('data', consume); socket.once('secure', () => greeting(true));
        });
        return;
      }
      assert.ok(authenticated);
      if (state.reject?.command === verb && (state.reject.name === undefined || state.reject.name === name)) { send('NO "synthetic rejection"\r\n'); return; }
      switch (verb) {
        case 'LISTSCRIPTS':
          for (const scriptName of state.scripts.keys()) send(`${JSON.stringify(scriptName)}${scriptName === state.activeName ? ' ACTIVE' : ''}\r\n`);
          send('OK\r\n'); break;
        case 'GETSCRIPT':
          if (!state.scripts.has(name)) send('NO (NONEXISTENT) "absent"\r\n');
          else { const script = state.scripts.get(name); send(`{${Buffer.byteLength(script)}}\r\n${script}\r\nOK\r\n`); }
          break;
        case 'CHECKSCRIPT': send('OK\r\n'); break;
        case 'PUTSCRIPT': state.scripts.set(name, literal); send('OK\r\n'); break;
        case 'SETACTIVE': state.activeName = name || null; send('OK\r\n'); break;
        case 'LOGOUT': send('OK\r\n'); socket.end(); break;
        default: assert.fail(`unexpected synthetic command ${verb}`);
      }
    }
    function consume(data) {
      input = Buffer.concat([input, data]);
      for (;;) {
        const end = input.indexOf('\r\n'); if (end < 0) return;
        const line = input.subarray(0, end).toString();
        const marker = /\{(\d+)\+\}$/.exec(line);
        if (marker) {
          const length = Number(marker[1]); if (input.length < end + 2 + length + 2) return;
          const script = input.subarray(end + 2, end + 2 + length).toString();
          assert.equal(input.subarray(end + 2 + length, end + 2 + length + 2).toString(), '\r\n');
          input = input.subarray(end + 2 + length + 2); execute(line, script);
        } else { input = input.subarray(end + 2); execute(line); }
      }
    }
    plain.on('data', consume); greeting(false);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { ...state, get activeName() { return state.activeName; }, set activeName(value) { state.activeName = value; }, get reject() { return state.reject; }, set reject(value) { state.reject = value; }, port: server.address().port };
}
