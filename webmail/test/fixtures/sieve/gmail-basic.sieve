# Gmail 필터 → Sieve 변환 결과 (gmail2sieve)
# 생성 시각: 2026-10-15T00:00:00.000Z
# 원본 필터 수: 2
require ["fileinto", "copy", "mailbox", "body", "variables"];

# [1] from=sender@example.com => label=Archive, shouldArchive
if header :contains "from" "sender@example.com" {
  fileinto :create :copy "Archive";
  set "hc_archive" "1";
}

# [2] subject=회의 => label=Archive, shouldArchive
if header :contains "subject" "회의" {
  fileinto :create :copy "Archive";
  set "hc_archive" "1";
}

# 받은편지함 처리 — 위 필터들이 남긴 표시를 보고 한 번만 결정
if string :is "${hc_trash}" "1" {
  fileinto "Trash";
} elsif string :is "${hc_archive}" "1" {
  discard;   # 받은편지함 사본만 취소 — 위에서 넣은 폴더 사본은 그대로 배달됨
} elsif string :is "${hc_neverspam}" "1" {
  fileinto "INBOX";   # 받은편지함 명시 저장 → 이후 서버 전역 스팸→정크 규칙 건너뜀
}
