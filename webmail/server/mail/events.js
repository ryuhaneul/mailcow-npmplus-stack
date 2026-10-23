import { PassThrough } from 'node:stream';

export function createEventService({ imap, sessions, logger, listService, now = Date.now }) {
  function open(session) {
    const stream = new PassThrough();
    let stop, timer, busy = false, pending = false, closed = false;
    const previous = new Map();
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(timer); stop?.();
    };
    stream.once('close', cleanup);
    function write(value) {
      if (closed) return;
      // A disconnected/slow reader must not accumulate unbounded event data.
      if (!stream.write(value)) stream.destroy();
    }
    function send(type, data) {
      const value = JSON.stringify(data);
      if (previous.get(type) !== value) {
        if (type === 'mailbox') listService?.invalidate(session);
        previous.set(type, value); write(`event: ${type}\ndata: ${value}\n\n`);
      }
    }
    async function expired() {
      if (closed) return true;
      if (session.connection !== null && now() < Date.parse(sessions.expiresAt(session))) return false;
      send('session', { state: 'expired' }); cleanup(); stream.end();
      await sessions.destroy(session, 'SESSION_EXPIRED');
      return true;
    }
    async function refresh() {
      if (closed) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        do {
          pending = false;
          if (await expired()) return;
          const snapshot = await imap.withMailbox(session, 'INBOX', async client => {
            // The work connection does not IDLE; sync its selected mailbox before STATUS.
            await client.noop();
            const status = await client.status('INBOX', { messages: true, unseen: true });
            const quota = await client.getQuota('INBOX');
            return { status, quota };
          });
          if (closed) return;
          send('mailbox', { path: 'INBOX', unseen: snapshot.status.unseen, total: snapshot.status.messages });
          const storage = snapshot.quota?.storage;
          if (storage && Number.isFinite(storage.usage) && Number.isFinite(storage.limit)) send('quota', { usedBytes: storage.usage, limitBytes: storage.limit });
        } while (pending && !closed);
      } catch {
        if (!await expired()) logger?.warn({ code: 'EVENT_REFRESH_FAILED' }, '메일 알림 정보를 갱신하지 못했습니다.');
      } finally { busy = false; }
    }
    stop = imap.watch(session, () => { void refresh(); });
    timer = setInterval(() => {
      if (closed) return;
      void refresh(); write(': ping\n\n');
    }, 25_000);
    timer.unref?.();
    void refresh();
    return stream;
  }
  return { open };
}
