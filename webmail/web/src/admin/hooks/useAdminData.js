import { useEffect, useState } from 'preact/hooks';
import { adminApi } from '../api.js';
export function useAdminData(path) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, data: null, error: null });
    adminApi(path, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setState({ loading: false, data, error: null }); }, error => { if (!controller.signal.aborted) setState({ loading: false, data: null, error }); });
    return () => controller.abort();
  }, [path, version]);
  return { ...state, reload: () => setVersion(value => value + 1) };
}
