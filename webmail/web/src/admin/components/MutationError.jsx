import Notice from './Notice.jsx';
export default function MutationError({ error, reload }) { return error ? <Notice tone="danger"><p role="alert" data-error-code={error.code}>{error.message}</p>{error.reason && <small>{error.reason}</small>}{error.status === 409 && reload && <p><button class="btn" type="button" onClick={reload}>다시 읽기</button></p>}</Notice> : null; }
