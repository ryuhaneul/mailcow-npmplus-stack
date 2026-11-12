export function createResourceLock() {
  const pending = new Map();
  async function run(target, operation) {
    const previous = pending.get(target) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    pending.set(target, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (pending.get(target) === current) pending.delete(target);
    }
  }
  return { run };
}
