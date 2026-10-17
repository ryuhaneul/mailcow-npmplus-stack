import { AppError } from '../../errors.js';

const invalid = () => new AppError(422, 'INVALID_INPUT', '격리함 동작과 실행 확인을 살펴봐 주세요.');
const missing = () => new AppError(404, 'NOT_FOUND', '격리된 메일을 찾을 수 없어요.');
export function createQuarantineService({ mailcow, audit, lock }) {
  async function list(session) {
    const value = await mailcow.call(session, 'GET', '/api/v1/get/quarantine/all');
    if (value && typeof value === 'object' && !Object.keys(value).length) return { items: [] };
    if (!Array.isArray(value)) throw new AppError(502, 'MAILCOW_REJECTED', '격리함 목록을 읽을 수 없어요.');
    return { items: value.map(row => ({ id: String(row.id), qid: String(row.qid ?? ''), subject: String(row.subject ?? ''), sender: String(row.sender ?? ''), recipient: String(row.rcpt ?? ''), score: Number(row.score), created: Number(row.created), type: String(row.action ?? '') })) };
  }
  async function change({ session, actor, ip, id, data, remove = false }) {
    if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || !data || typeof data !== 'object' || Array.isArray(data) || data.confirm !== true || Object.keys(data).some(key => !(remove ? ['confirm'] : ['confirm', 'action']).includes(key))) throw invalid();
    const action = remove ? 'delete' : data.action;
    if (!(remove ? ['delete'] : ['release', 'learnham', 'learnspam']).includes(action)) throw invalid();
    return lock.run(`quarantine:${id}`, async () => {
      const row = (await list(session)).items.find(row => row.id === String(id)); if (!row) throw missing();
      const before = { id: row.id, qid: row.qid, action };
      return audit.run({ actor, ip, action: `quarantine.${action}`, target: `quarantine:${id}`, kind: 'irreversible', revertible: false, before, after: { id: row.id, action } }, async intent => {
        if (!(await list(session)).items.some(item => item.id === row.id)) throw missing();
        if (remove) await mailcow.call(session, 'POST', '/api/v1/delete/qitem', [row.id]);
        else await mailcow.call(session, 'POST', '/api/v1/edit/qitem', { items: [row.id], attr: { action } });
        if ((await list(session)).items.some(item => item.id === row.id)) throw new AppError(502, 'WRITE_VERIFY_FAILED', '격리함 동작 결과가 예상과 달라요. 목록을 다시 확인해 주세요.');
        return { id: row.id, action, auditId: intent.id, ...(['release', 'learnham'].includes(action) ? { notice: '격리된 메일을 실제로 배달했어요.' } : {}) };
      });
    });
  }
  return { list, change };
}
