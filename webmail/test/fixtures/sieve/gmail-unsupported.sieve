# Gmail 필터 → Sieve 변환 결과 (gmail2sieve)
# 생성 시각: 2026-10-15T00:00:00.000Z
# 원본 필터 수: 3
require ["fileinto", "copy", "mailbox", "body", "variables"];

# [1] hasTheWord=anywhere => label=Archive
if anyof (header :contains ["subject", "from", "to", "cc"] "anywhere", body :text :contains "anywhere") {
  fileinto :create :copy "Archive";
}

# [2] from=sender@example.com / size s_sl 10 s_skb => label=Archive
if allof (header :contains "from" "sender@example.com", size :over 10K) {
  fileinto :create :copy "Archive";
}

# [3] (변환 제외) to=-hidden@example.com => label=Archive

# 받은편지함 처리 — 위 필터들이 남긴 표시를 보고 한 번만 결정
if string :is "${hc_trash}" "1" {
  fileinto "Trash";
} elsif string :is "${hc_archive}" "1" {
  discard;   # 받은편지함 사본만 취소 — 위에서 넣은 폴더 사본은 그대로 배달됨
} elsif string :is "${hc_neverspam}" "1" {
  fileinto "INBOX";   # 받은편지함 명시 저장 → 이후 서버 전역 스팸→정크 규칙 건너뜀
}
