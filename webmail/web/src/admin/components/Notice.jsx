export default function Notice({ tone = '', children }) { return <div class={`ac-notice alert ${tone}`}>{children}</div>; }
