import { useEffect, useRef } from 'preact/hooks';
import { initStars } from '../theme/stars.js';
export default function Starflow() {
  const frame = useRef(null);
  useEffect(() => initStars(frame.current), []);
  return <iframe ref={frame} id="starflow-background" src="/starflow/index.html" tabIndex={-1} aria-hidden="true" title="장식용 별 배경" />;
}
