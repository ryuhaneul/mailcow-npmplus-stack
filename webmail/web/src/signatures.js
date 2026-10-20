import { endSession } from './api.js';
import { session } from './state/session.js';

const messages = {
  SIGNATURE_INVALID: '서명 이름과 기본 서명 설정을 확인해 주세요.',
  SIGNATURE_NOT_FOUND: '서명을 찾을 수 없어요. 목록을 다시 불러와 주세요.',
  SIGNATURE_CONFLICT: '다른 곳에서 서명을 바꿨어요. 입력을 보관하고 최신 정보를 다시 불러와 주세요.',
  SIGNATURE_REVISION_REQUIRED: '최신 서명 정보를 먼저 불러와 주세요.',
  SIGNATURE_DATA_IMAGE: '이미지는 보관함에서 넣어 주세요.',
  SIGNATURE_IMAGE_INVALID: '보관함 이미지 또는 PNG, JPEG, GIF, WebP 파일을 확인해 주세요.',
  SIGNATURE_IMAGE_NOT_FOUND: '서명 이미지가 보관함에 없어요. 다시 넣어 주세요.',
  SIGNATURE_IMAGE_IN_USE: '사용 중인 이미지예요. 서명에서 이미지를 뺀 뒤 지워 주세요.',
  SIGNATURE_IMAGE_TOO_LARGE: '이미지는 한 개 200KiB, 보관함 전체 1MiB, 20개까지 올릴 수 있어요. 이미지 크기와 개수를 줄여 주세요.',
  SIGNATURES_TOO_LARGE: '서명 저장 용량을 넘었어요. 서명 크기를 줄여 주세요.',
  SIGNATURE_MIRROR_TOO_LARGE: '기본 서명 저장 용량을 넘었어요. 새 메일 기본 서명이나 HTML 크기를 줄여 주세요.',
  SIGNATURE_MIGRATION_TOO_LARGE: '예전 서명을 가져올 공간이 부족해요. 원본은 보존돼 있어요. 관리자에게 알려 주세요.',
  SIGNATURE_SYNC_FAILED: '서명 저장 상태를 확인하지 못했어요. 원본을 유지하고 관리자에게 알려 주세요.',
  SIGNATURE_SAVE_RETRY: '서명을 저장하지 못했어요. 입력을 유지하고 다시 시도해 주세요.',
};

export function signatureError(error) {
  const result = new Error(messages[error?.code] || error?.message || '서명 정보를 불러오지 못했어요. 다시 시도해 주세요.');
  Object.assign(result, error);
  result.message = error?.code === 'SIGNATURE_IMAGE_IN_USE' && error.message ? error.message : messages[error?.code] || result.message;
  result.reloadRequired = ['SIGNATURE_CONFLICT', 'SIGNATURE_REVISION_REQUIRED'].includes(result.code);
  return result;
}

export function signatureSessionChanged() {
  return signatureError({ code: 'SIGNATURE_SESSION_CHANGED', message: '로그인 정보가 바뀌었어요. 다시 불러와 주세요.' });
}

export async function signatureRequest(path, { method = 'GET', body, ...options } = {}) {
  const owner = session.value, headers = new Headers(options.headers);
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && owner?.csrf) headers.set('X-Webmail-CSRF', owner.csrf);
  try {
    // Match api.js transport, but discard old-account responses before auth side effects.
    const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
    const value = response.status === 204 ? null : await response.json();
    if (session.value !== owner) throw signatureSessionChanged();
    if (!response.ok) {
      const error = value.error;
      if (['NO_SESSION', 'SESSION_EXPIRED'].includes(error.code)) endSession(error.code);
      throw { ...error, status: response.status };
    }
    return value;
  } catch (error) { throw signatureError(error); }
}

export function getSignatures() { return signatureRequest('/api/signatures'); }
export function putSignatures(value, revision) {
  // Server timestamps and import metadata are read-only; PUT accepts exactly these fields.
  const body = { items: value.items.map(({ id, name, html }) => ({ id, name, html })), defaults: structuredClone(value.defaults) };
  return signatureRequest('/api/signatures', { method: 'PUT', headers: revision == null ? {} : { 'If-Match': revision }, body });
}
export function normalizeSignature(html) {
  return signatureRequest('/api/signatures/normalize', { method: 'POST', body: { html } });
}
