# M02 합성 시험 데이터

시험 VM 전용. 계정은 미리 존재해야 한다. 실제 서버 접속·관리 설정 실행은 main이 한다.
모든 발신자는 합성 `sender@example.com`, 받는 주소는 인자로 받은 시험 도메인이다.

```sh
# 저장소 루트, Node 24. 암호 값은 명령행에 넣지 않는다.
# ~/webmail-int.env (600): WEBMAIL_SEED_PASSWORD=..., WEBMAIL_PROBE_EMAIL=...,
# WEBMAIL_PROBE_PASSWORD=... 를 시험 계정 값으로 준비한다.
set -a
. "$HOME/webmail-int.env"
set +a

# 접속 없이 역할표와 관리 요청 파일 생성
node webmail/test/int/seed/run.mjs --imap imaps://mail.example.com:993 \
  --domain mail.example.com --prefix '' --plan-only \
  --admin-output /tmp/seed-admin-tasks.json

# IMAP APPEND·폴더 생성 + 사용자 자격 ManageSieve(같은 호스트:4190, STARTTLS)
node webmail/test/int/seed/run.mjs --imap imaps://mail.example.com:993 \
  --domain mail.example.com --prefix '' \
  --admin-output /tmp/seed-admin-tasks.json

node webmail/test/int/waf-probe.mjs https://mail.example.com
```

`--prefix int-`면 `int-user1`…`int-user8`, `int-team-sales`, `int-team-support`를 사용한다.
기본 접두는 빈 값이다. `--domain`은 계정 도메인, `--imap`은 자격 정보 없는 TLS 접속 주소다.
IMAP·ManageSieve 인증서를 검증한다. 사설 CA는 Node의 `NODE_EXTRA_CA_CERTS`로 지정한다.
암호는 `WEBMAIL_SEED_PASSWORD` 환경변수 또는 `WEBMAIL_SEED_PASSWORD_FILE`이 가리키는
**암호 한 줄만 든 일반 파일(정확히 600)** 중 하나로 전달한다. 환경변수가 우선한다.
`webmail-int.env`처럼 셸 변수 선언이 든 파일은 직접 source하여 환경변수로 전달한다.
비밀 값은 인자·출력·오류 원문에 포함하지 않는다.

## 생성 항목과 재실행

- user1: INBOX 합성 메일 20,000통, 한글 폴더 `시험폴더01`~`시험폴더12`.
  IMAP QUOTA STORAGE의 현재 사용량·한도(바이트)로 부족한 메일의 크기를 계산해 80% 근처를 채운다.
  고정 Message-ID를 검색하여 이미 존재하는 번호를 건너뛴다. 중단 후 재실행해도 같은 번호를 추가하지 않는다.
  기존 메일은 세거나 삭제하지 않으므로 **전체 메일 수는 기존 메일 + seed 20,000통**이다.
  이미 80% 이상이거나, seed 20,000통이 이미 있고 사용량이 80% 미만이면 현재 사용량·한도·seed 개수를
  경고로 출력하고 해당 계정의 용량 보정을 중단한다. 삭제·한도 변경은 하지 않는다.
- user2: 팀 두 주소와 `@도메인` sender ACL의 **검토용 관리 요청**.
- user3: `seed-alias-one`, `seed-alias-two`의 수신 대상 별칭 **검토용 관리 요청**.
- user4: user1 INBOX 읽기 전용 Toolkit 공유의 **수동 설정·검증 항목**.
- user5: mailcow 2FA의 **수동 설정·검증 항목**. 비밀·복구 코드는 만들거나 출력하지 않는다.
- user6/7/8: 기존 합성 fixture의 gmail2sieve / rainloop.user / 모르는 형식 스크립트를
  사용자 자격 ManageSieve로 검사·등록·활성화한다. user6/7/8에 Archive 폴더를 만든다.
  같은 이름·같은 내용·이미 활성 상태면 건너뛴다. 다른 내용 또는 다른 활성 스크립트면 중단한다.
- 팀 계정 두 개: 이미 생성된 메일함·자기 주소 별칭·자동완성 팀 표시를 관리 파일에서 확인한다.

`seed-admin-tasks.json`에는 mailcow API의 GET 확인 + POST 요청 대상·본문과 병합/충돌 정책이 들어간다.
**스크립트는 관리자 API를 호출하지 않는다.** main이 기존값을 비교하고 sender ACL을 합집합으로 병합한 뒤
실행한다. API 키는 main의 실행 환경변수에서만 읽는다. 공유·2FA는 목표 상태, 확인 방법,
같으면 건너뛰는 규칙을 파일에 적으며 실제 설정은 main 수동 항목이다.

W08 대조 자료는 삭제하거나 수정하지 않는다. 기존 user2의 다른 도메인 ACL, user3의 전체 주소 발송권,
user4의 추가 발송권 등이 있어서 최소 권한만 있다고 가정한 시험에는 영향을 준다.
새 별칭 이름은 W08과 다르다. 같은 이름이 다른 대상으로 존재하면 main 판단 전 생성을 멈춘다.

예상 소요: 계획 출력은 수 초, 실제 20,000회 순차 APPEND는 **수 분~수십 분(미실측)**.
쿼터 크기·디스크·네트워크에 따라 달라지며 1,000번째 번호마다 진행량만 출력한다.
시험 후 main이 비밀 환경 파일을 삭제한다.

## 바깥 경로 WAF 시험

`WEBMAIL_PROBE_EMAIL`과 `WEBMAIL_PROBE_PASSWORD` 환경변수만 사용한다.
로그인 뒤 세션 쿠키·CSRF로 HTML(표·인라인 스타일·script 인용) 임시저장/발송,
SQL 모양 제목 발송, Sieve 기호 규칙 저장, 20MiB 첨부 업로드, 특수문자 검색,
암호 변경 요청을 보낸다. 발송 대상은 시험 계정 자신이다. 임시저장·발송은 실제 시험 자료를 남긴다.
첨부는 앱의 세션 임시 저장 정책에 따라 정리된다.

암호 요청은 현재 암호와 서로 다른 새 암호 확인값을 보내 `PW_MISMATCH` 앱 JSON 거절을 유도한다.
규칙은 GET 원본에 `${`·따옴표·`;` 조건을 추가한다(앱 검증 거절도 정상 출처 판정).
저장이 성공하면 마지막에 새 rev로 원본 문서를 PUT하여 복원하며, 실패는 `규칙 원복 실패`로 표시한다.

각 응답은 `웹메일 앱 JSON` / `앱 아닌 차단/응답`(403·HTML 등) / `연결 실패`로 분류하고
HTTP 상태와 업무 성공/앱 오류 코드를 별도로 표에 출력한다. 응답 원문·쿠키·CSRF·암호는 출력하지 않는다.
JSON이라는 이유만으로 앱이라고 보지 않으며 앱 오류 구조 또는 해당 API의 성공 필드가 필요하다.
종료 코드: 모든 요청 앱 JSON이면 0, 앱 아닌 응답이나 연결 실패가 하나라도 있으면 1,
로그인·규칙 원본 미확보로 필수 요청을 못 보내거나 규칙 원복 업무가 실패하면 2.
실제 계정·앱·앞단 프록시 검증은 main의 VM/바깥 경로 실행에서 수행한다.
