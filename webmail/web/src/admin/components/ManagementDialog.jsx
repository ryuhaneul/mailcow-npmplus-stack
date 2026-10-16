import { useEffect, useRef } from 'preact/hooks';
export default function ManagementDialog({ title, close, busy, children }) {
  const node = useRef(null);
  useEffect(() => { node.current.showModal(); return () => node.current?.close(); }, []);
  return <dialog class="account-modal management-modal" ref={node} aria-label={title} onCancel={event => { if (busy) event.preventDefault(); else close(); }}><h2>{title}</h2>{children}</dialog>;
}
