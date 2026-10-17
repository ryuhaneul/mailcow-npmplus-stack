export const authMessages = {
  ADMIN_PENDING_ACTION: '이 계정은 mailcow 에서 암호 변경이나 2단계 인증 등록이 먼저 필요해요. mailcow 관리 화면에서 끝낸 뒤 다시 로그인해 주세요.',
  ADMIN_2FA_UNSUPPORTED: '이 계정은 보안 키로만 2단계 인증을 해요. 관리 화면은 인증 앱(6자리 코드)만 지원해요. mailcow 에서 인증 앱을 추가해 주세요.',
  MAILCOW_SESSION_LOST: 'mailcow 로그인이 끝나 관리 화면도 로그아웃했어요. 다시 로그인해 주세요.',
  MAILCOW_UNAVAILABLE: '지금 mailcow 에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.',
};
export function safeFallbackUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function remainingTime(seconds) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
