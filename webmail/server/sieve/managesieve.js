import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { AppError } from '../errors.js';
import { mailTlsOptions } from '../mail/imap-pool.js';
import { MAX_SCRIPT_BYTES } from './model.js';

const unavailable = () => new AppError(503, 'SIEVE_UNAVAILABLE', '필터 서버에 연결할 수 없어요.');
const protocolError = () => new AppError(502, 'SIEVE_PROTOCOL', '필터 서버 응답을 확인할 수 없어요.');
const invalid = () => new AppError(422, 'RULES_INVALID', '필터 이름이나 내용을 확인해 주세요.');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const MAX_RESPONSE_BYTES = 2 * MAX_SCRIPT_BYTES;

function nameString(value, allowEmpty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || (!allowEmpty && !value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalid();
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// One reader per socket; literal lengths count bytes, never JavaScript characters.
class Wire {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.consumed = 0;
    this.onData = data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > MAX_RESPONSE_BYTES) this.fail(protocolError());
      this.wake?.();
    };
    this.onFailure = () => this.fail(unavailable());
    socket.on('data', this.onData);
    socket.on('error', this.onFailure);
    socket.on('close', this.onFailure);
    socket.on('end', this.onFailure);
  }
  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onFailure);
    this.socket.off('close', this.onFailure);
    this.socket.off('end', this.onFailure);
  }
  fail(error) {
    this.failure ??= error;
    this.socket.destroy();
    this.wake?.();
  }
  async wait() {
    if (this.failure) throw this.failure;
    await new Promise(resolve => { this.wake = resolve; });
    this.wake = null;
  }
  take(length) {
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    this.consumed += length;
    return value;
  }
  async exact(length) {
    while (this.buffer.length < length) await this.wait();
    return this.take(length);
  }
  async line() {
    let end;
    while ((end = this.buffer.indexOf('\r\n')) < 0) await this.wait();
    const line = decode(this.take(end + 2).subarray(0, end));
    if (/[\u0000-\u001f\u007f]/u.test(line)) throw protocolError();
    return line;
  }
  async record() {
    const values = [];
    let firstAtom = false;
    let part = await this.line();
    for (;;) {
      let position = 0;
      let literal = false;
      while (position < part.length) {
        if (part[position] === ' ') { position++; continue; }
        const rest = part.slice(position);
        const quoted = /^"((?:[^"\\]|\\["\\])*)"/.exec(rest);
        if (quoted) {
          values.push(quoted[1].replace(/\\(["\\])/g, '$1'));
          position += quoted[0].length;
          continue;
        }
        const marker = /^\{(0|[1-9]\d*)\}$/.exec(rest);
        if (marker) {
          const length = Number(marker[1]);
          if (!Number.isSafeInteger(length) || length > MAX_SCRIPT_BYTES) throw protocolError();
          values.push(decode(await this.exact(length)));
          part = await this.line();
          literal = true;
          break;
        }
        const atom = /^(?:[()]|[^ ()"{}\\]+)/.exec(rest);
        if (!atom) throw protocolError();
        if (!values.length) firstAtom = true;
        values.push(atom[0]);
        position += atom[0].length;
      }
      if (!literal) break;
    }
    if (!values.length) throw protocolError();
    const status = firstAtom && ['OK', 'NO', 'BYE'].includes(values[0].toUpperCase()) ? values[0].toUpperCase() : null;
    return { values, status };
  }
  async response(command) {
    const start = this.consumed;
    const rows = [];
    for (;;) {
      const row = await this.record();
      if (this.consumed - start > MAX_RESPONSE_BYTES) throw protocolError();
      if (row.status === 'OK') return rows;
      if (row.status === 'BYE') { this.fail(unavailable()); throw this.failure; }
      if (row.status === 'NO') {
        const error = command === 'AUTHENTICATE'
          ? new AppError(403, 'SESSION_EXPIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.')
          : new AppError(502, 'SIEVE_REJECTED', '필터 서버가 요청을 거절했어요.');
        if (command === 'AUTHENTICATE') error.authenticationFailed = true;
        error.command = command;
        // Do not retain server messages: they may echo credentials or script data.
        if (row.values[1] === '(' && /^[A-Za-z0-9/-]+$/.test(row.values[2] ?? '')) error.responseCode = row.values[2].toUpperCase();
        throw error;
      }
      rows.push(row.values);
    }
  }
}

/** RFC 5804: STARTTLS and AUTHENTICATE are automatic; all commands serialize.
 * credentials.password is the session Buffer. No credentials are retained by the client.
 */
export async function connectManageSieve(config, credentials, { connectTimeoutMs = 10000, commandTimeoutMs = 60000 } = {}) {
  let wire;
  let tail = Promise.resolve();
  async function deadline(operation, ms) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => { wire?.fail(unavailable()); reject(unavailable()); }, ms);
      })]);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SIEVE_REJECTED') throw error;
      const safe = error instanceof AppError ? error : protocolError();
      wire?.fail(safe);
      throw safe;
    } finally { clearTimeout(timer); }
  }
  async function exchange(command, frame) {
    if (wire.failure) throw wire.failure;
    wire.socket.write(frame);
    return wire.response(command);
  }
  function send(command, argumentsText = '', script, transform = () => undefined) {
    let frame;
    if (script !== undefined) {
      if (typeof script !== 'string' || !script.isWellFormed() || Buffer.byteLength(script) > MAX_SCRIPT_BYTES) return Promise.reject(invalid());
      frame = Buffer.from(`${command}${argumentsText ? ` ${argumentsText}` : ''} {${Buffer.byteLength(script)}+}\r\n${script}\r\n`, 'utf8');
    } else frame = `${command}${argumentsText ? ` ${argumentsText}` : ''}\r\n`;
    const result = tail.then(() => deadline(async () => transform(await exchange(command, frame)), commandTimeoutMs));
    tail = result.catch(() => {});
    return result;
  }
  try {
    const tlsOptions = mailTlsOptions(config);
    if (typeof credentials.email !== 'string' || credentials.email.includes('\0') || !Buffer.isBuffer(credentials.password) || credentials.password.includes(0)) throw unavailable();
    wire = new Wire(net.createConnection({ host: config.sieveHost, port: config.sievePort }));
    const capabilities = await deadline(async () => {
      // The reader also consumes a greeting that arrives immediately with connect.
      await once(wire.socket, 'connect').catch(() => { throw unavailable(); });
      const initial = Object.fromEntries(await wire.response('GREETING'));
      if (!Object.hasOwn(initial, 'STARTTLS')) throw unavailable();
      await exchange('STARTTLS', 'STARTTLS\r\n');
      if (wire.buffer.length) throw protocolError();
      const plain = wire.socket;
      wire.detach();
      wire = new Wire(tls.connect({ socket: plain, ...tlsOptions }));
      await once(wire.socket, 'secureConnect').catch(() => { throw unavailable(); });
      const secure = Object.fromEntries(await wire.response('GREETING'));
      if (!secure.SASL?.split(' ').includes('PLAIN')) throw unavailable();
      const auth = Buffer.concat([Buffer.from(`\0${credentials.email}\0`, 'utf8'), credentials.password]);
      const frame = Buffer.from(`AUTHENTICATE "PLAIN" "${auth.toString('base64')}"\r\n`, 'utf8');
      auth.fill(0);
      try { await exchange('AUTHENTICATE', frame); } finally { frame.fill(0); }
      return secure;
    }, connectTimeoutMs);
    credentials = null;
    return {
      capabilities,
      listScripts: () => send('LISTSCRIPTS', '', undefined, rows => rows.map(row => {
        if (row.length < 1 || row.length > 2 || (row.length === 2 && row[1].toUpperCase() !== 'ACTIVE')) throw protocolError();
        return { name: row[0], active: row.length === 2 };
      })),
      getScript: name => send('GETSCRIPT', nameString(name), undefined, rows => {
        if (rows.length !== 1 || rows[0].length !== 1 || Buffer.byteLength(rows[0][0]) > MAX_SCRIPT_BYTES) throw protocolError();
        return rows[0][0];
      }),
      putScript: (name, script) => send('PUTSCRIPT', nameString(name), script),
      checkScript: script => send('CHECKSCRIPT', '', script),
      setActive: name => send('SETACTIVE', nameString(name, true)),
      deleteScript: name => send('DELETESCRIPT', nameString(name)),
      logout: async () => { try { await send('LOGOUT'); } finally { wire.fail(unavailable()); } },
      close: () => wire.fail(unavailable()),
    };
  } catch (error) {
    wire?.fail(unavailable());
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}
