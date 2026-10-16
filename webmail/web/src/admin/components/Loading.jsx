import { useEffect, useState } from 'preact/hooks';
export default function Loading() { const [visible, setVisible] = useState(false); useEffect(() => { const timer = setTimeout(() => setVisible(true), 300); return () => clearTimeout(timer); }, []); return visible ? <p class="state" role="status">불러오는 중…</p> : null; }
