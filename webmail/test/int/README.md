# 시험 VM 통합시험

W17a seed를 적용하고 모든 구현 레인(특히 W13b)을 병합한 시험 VM에서 실행한다.
시험은 HTTP API를 실제 호출하며, IMAP·ManageSieve는 원본 결과 확인과 합성 자료 준비/원복에만 사용한다.
`WEBMAIL_INT=1`이 없으면 모든 시험은 **건너뜀**, 종료 코드 0이다. 활성화한 시험의 API가 404여도 실패한다.

## 준비

- VM `/home/rocky/webmail-int.env`만 암호 전달에 사용한다(권한 600, 저장소에 복사하지 않는다).
- 필수 키: `WEBMAIL_INT=1`, `WEBMAIL_INT_DOMAIN`, `WEBMAIL_INT_PASSWORD`, `WEBMAIL_INT_ORIGIN`(허용된 https Origin), `WEBMAIL_INT_TLS_SERVERNAME`.
- 실제 암호 변경용 `WEBMAIL_INT_NEXT_PASSWORD`는 기존 암호와 다른 정책 적합 값으로 같은 env 파일에 보관한다. 없으면 암호 변경 시험만 '미실행(변수 없음)'이고, 현재 암호와 같으면 변경 전에 실패한다. 원복 실패 때 main이 NEXT 값으로 수동 복구해야 한다는 안내를 남기며 시험은 실패한다.
- 선택 키: `WEBMAIL_INT_URL`(기본 `http://webmail:8080`), `WEBMAIL_INT_IMAP_HOST`(기본 `dovecot-mailcow`), `WEBMAIL_INT_TLS_MODE`(기본 `verify`).
- 시험 VM의 자체서명 공개 인증서는 `/home/rocky/webmail-int-ca.pem`에 권한 644로 둔다(컨테이너에 읽기 전용 마운트, 개인키 제외). `WEBMAIL_INT_TLS_MODE=pin`, `WEBMAIL_INT_TLS_PIN_FILE=/run/webmail-int-ca.pem`을 env에 넣는다. 인증서 검증을 끄지 않는다.
- IR1 전에 main이 시험 VM 스택 `.env`에 `WEBMAIL_ALLMAIL_EXCLUDE=IntExcluded`를 설정하고 스택 `scripts/update.sh`를 실행해 Dovecot 정의를 다시 적용한다. 그 뒤 시험 env 파일에 `WEBMAIL_INT_ALLMAIL_EXCLUDE=IntExcluded`를 넣는다. 시험은 이 개인 폴더에 합성 sentinel을 넣고 원복한다. 시험 변수가 없으면 해당 T-VIRT/쿼터 시험만 이유를 출력하고 건너뛴다.
- 호스트 T-SIEVE용 `WEBMAIL_INT_MAILCOW_DIR`는 VM mailcow compose 디렉터리 절대경로다.
- `WEBMAIL_INT_NETWORK`를 compose 셸 환경에서 지정하면 기본 `mailcowdockerized_mailcow-network` 대신 그 내부망에 붙는다.
- M02: user1 20,000통/한글 폴더 12개, user2 두 sender ACL와 @도메인 권한, user3 sender 허용 별칭 2개, user4 user1 INBOX 읽기 전용 공유, user5 2FA, user6 Gmail/user7 rainloop/user8 모르는 형식의 활성 필터가 필요하다.
- seed의 user3 별칭 추가 JSON은 `sender_allowed: '1'`을 명시한다. [mailcow 2026-09a 별칭 추가 구현](https://github.com/mailcow/mailcow-dockerized/blob/2026-09a/data/web/inc/functions.mailbox.inc.php#L701-L705)은 해당 필드를 `intval`로 변환하므로 누락 값을 보낼 권한 1로 간주할 수 없다. 기존 별칭의 권한이 다르면 seed를 자동 덮어쓰지 않고 main이 판단한다.
- user5의 계정 암호 웹메일 로그인은 `403 AUTH_FAILED`가 기대값이다. [mailcow 2026-09a user_login](https://github.com/mailcow/mailcow-dockerized/blob/2026-09a/data/web/inc/functions.auth.inc.php#L363-L408)은 2FA 계정의 내부 인증에서 일반 암호 로그인을 허용하지 않는다(앱 암호는 별도 인증 경로). 암호 변경 대행의 `403 MAILCOW_2FA` 경로는 W15 단위 시험으로 확인하며 이 계정으로 통합 로그인 후 검사하지 않는다.
- `team-sales`, `team-support`는 mailbox(person)다. 자동완성의 team 판정은 seed `user3.aliases` 첫 번째 활성 별칭으로 확인한다(자기 도메인, catch-all 아님). 최근 자동완성 자료는 시험이 user3 Sent에 합성 메일을 넣고 원복한다.
- user1 외의 프로그램 접근/새 메일 수신을 시험 중 멈춘다. 암호·필터·설정을 바꾸며 모든 세션을 폐기하는 시험이 있다. 각 시험의 finally/정리 훅이 원복하고, 원복 실패도 시험 실패로 기록한다.

## IR1 → IR2 명령 순서 (main, VM)

저장소 루트에서:

```sh
cd webmail && bash bin/check-image-build.sh && cd ..
docker compose -f webmail/test/int/compose.int.yml build int
docker compose -f webmail/test/int/compose.int.yml run --rm int --group mail,sieve,account
```

통합시험 빌드는 `webmail/`을 context로 사용하고 `test/int/Dockerfile.int`를 선택한다.
같은 디렉터리의 `Dockerfile.int.dockerignore`는 배포용 `.dockerignore`에서 `test` 제외만 뺀 정책이다.
[Docker 공식 문서](https://docs.docker.com/build/concepts/context/#filename-and-location)에 따라 Dockerfile별 ignore가 context 루트의 ignore보다 우선한다(BuildKit 필요).
`dockerfile_inline` 대신 이름이 있는 Dockerfile을 선택해 이 연결을 명시했다.
Docker 없는 검사는 이 저장소의 리터럴 COPY 경로·시험 JS 입력 포함·배포 test 제외와 두 ignore 정책의 차이를 확인하고, 기존 배포 단계 모사 빌드도 실행한다.
ignore의 부정·이스케이프·문자 클래스 구문이나 COPY 형식을 바꾸면 검사도 검토해야 하며, 실제 Docker 빌드를 대체하지 않는다.

core 마지막 IP 제한 시험은 웹메일에 직접 요청하고, 위조 XFF를 보내지 않는다. 서로 다른 존재하지 않는 합성 주소로 5회 실패한 뒤 6회째 429인지 확인해 계정 제한과 구분한다. 실제 시험 계정에는 로그인 실패를 보내지 않는다. 출발 IP와 남은 초를 출력한다. IR2 전에는 **실패 제한 만료(15분) 또는 main 판단의 웹메일 재시작**이 필수다. 새 컨테이너가 같은 IP를 재사용할 수 있다. IP 제한 시험을 앞당기거나 병렬 실행하지 않는다.

IP 제한 시험의 시도 간격은 기본 17초다. [Dovecot 2.3 auth penalty](https://doc.dovecot.org/2.3/configuration_manual/authentication/auth_penalty/)의 상한 15초와 [auth_failure_delay](https://doc.dovecot.org/2.3/settings/core/#auth-failure-delay)의 기본 최대 간격 2초를 기준으로 둔다. 이 간격이 penalty 초기화를 보장하지는 않는다. W02b의 서버 인증 대기 수정이 선행되어야 하며, HTTP 제한 60초 안에서 5회 모두 `403 AUTH_FAILED`, 6회째 `429 RATE_LIMITED`여야 한다. 503 허용이나 재시도는 없다. `WEBMAIL_INT_AUTH_INTERVAL_MS`는 가짜 서버 단위 시험에서 간격을 줄이는 주입값(0~17000)이며 실제 VM env에서는 설정하지 않는다.

**위조 XFF 무시는 내부망 안에서 자동으로 확인 불가 — 수동 게이트 R-XFF(바깥 주소)로 확인.** 웹메일이 mailcow 내부망 전체를 신뢰하므로 그 망에서 보낸 위조 XFF가 신뢰되는 것은 배포 설계에 맞는다. NPMplus를 거쳐도 시험 컨테이너 주소까지 신뢰 목록에 포함되며, 다른 사설망을 써도 NPMplus가 사설 대역의 XFF를 신뢰한다. 자동 시험의 IP 제한 통과를 위조 차단 통과로 기록하지 않는다.

실행 순서는 다음을 지킨다. 실패 제한은 그룹별로 분리되지 않는다.

1. 위 `mail,sieve,account` 그룹을 먼저 실행한다. user5의 `AUTH_FAILED` 1회가 남는다.
2. **마지막 로그인 실패부터 15분이 지나 실패 제한이 풀릴 때까지 기다린다.** 또는 main 판단으로 웹메일을 재시작한다. 이 단계는 필수이며 시험이 자동 재시작하지 않는다.
3. 아래 `core`를 단독 실행한다. IP 실패 제한 시험이 맨 마지막이며 출발 IP가 다시 제한된다.
4. IR을 다시 실행하려면 2번 조건을 다시 채운 뒤 1번부터 시작한다.

```sh
docker compose -f webmail/test/int/compose.int.yml run --rm int --group core
```

호스트 Node 24와 `cd webmail && npm ci`로 고정 의존성이 준비되어 있어야 한다. 같은 env 파일을 **출력하지 않고** Node에 로드해 T-SIEVE를 실행한다:

```sh
cd webmail
node --env-file=/home/rocky/webmail-int.env test/int/lib/sieve-host.js
```

T-SIEVE는 Docker 소켓을 시험 컨테이너에 열지 않기 위해 **VM 호스트에서 별도 실행**한다. 실제 `docker compose exec -T dovecot-mailcow sieve-test`로 40통 × 30규칙을 `match.js`와 비교한다. `doveconf -n`에서 번호가 붙은 전역 before/after와 디렉터리의 `.sieve`를 수집하고, 실제 실행 순서에 넣는다. 전역 before/after가 없거나 해석할 수 없으면 실패한다. [Pigeonhole sieve-test의 `-s` 순서](https://raw.githubusercontent.com/dovecot/pigeonhole/release-0.5.21/doc/man/sieve-test.1.in)를 사용한다. `-e`를 쓰지 않아 실제 저장/전달은 하지 않는다. 추가로 여러 규칙이 맞는 10건의 배달 위치 1개와 부재중 기간 안/밖·스팸 3건을 검사한다. 출력 형식을 인식하지 못해도 실패한다. 일치 표시는 stdout·stderr 양쪽에서 판정하되 stderr 원문은 출력하지 않는다. 합성 임시 자료의 호스트/컨테이너 경로를 보고하고 성공·실패 모두 종료 시 해당 디렉터리를 정리한다. 정리 실패도 시험 실패다.

경로 수집은 `/`로 시작하는 파일/디렉터리만 대상으로 한다. `mysql:`·`dict:proxy::` 등의 저장소 항목은 `파일 아님 — 건너뜀`과 종류만 출력하며 원문은 출력하지 않는다. IR2의 mailcow 2026-09a에서는 전역 `global_sieve_before.sieve`·`global_sieve_after.sieve` 두 파일이 대상이고 사용자별 before/after는 0개다. 사용자별 dict 스크립트를 검증한 것으로 기록하지 않는다.

호스트에서 다음 실제 설정 검사도 IR2 기록에 포함한다(저장소 루트, VM `.env`의 설정을 적용한 상태):

```sh
bash scripts/apply-dovecot-webmail.sh --check
bash scripts/apply-dovecot-autoexpunge.sh --check
```

## 필수 수동 게이트

- **R-XFF(계획 7-1)**: dt의 첫 바깥 주소에서 틀린 암호 1회 → VM 웹메일 `AUTH_FAILED` 로그의 IP가 dt 바깥 주소인지 확인한다. `X-Forwarded-For: 1.2.3.4`를 붙여도 로그 IP가 같아야 한다. 총 5회 실패 후 6회째 429인지, 별도 바깥 주소에서 **다른 시험 계정**으로 로그인 가능한지 확인한다(계정별 실패 제한과 IP별 제한을 구분). 쿠키·암호를 출력하지 않고 IP/상태/판정만 남긴다. 내부망 자동시험만으로 이 항목을 통과 처리하지 않는다.
- **T-VIRT 쿼터 기준**: I01 적용 전 `doveadm quota get`의 기준값과 적용 후 값을 비교한다. 자동시험은 실제 GETQUOTAROOT와 API, 가상 폴더 조회 전/후 쿼터를 비교하지만 적용 전 상태를 재현하지 않는다.
- **R-WAF**: dt에서 W17a `waf-probe.mjs`를 별도 실행한다. 내부망 시험으로 앞단 AppSec을 통과 처리하지 않는다.
- **W13b STORE 실패**: 실서버 장애 주입은 하지 않음 — 플래그 실패 후 이동 안 함·`failed:[{ref,code}]`는 W13b/W13c 단위 시험으로 확인한다. 이 묶음은 정상 STORE의 메일당 flagged=1, MOVE 및 재적용 0과 W07의 공유 폴더 쓰기 거부/실제 ref의 UIDVALIDITY만 바꾼 부분 실패를 검증한다.
- **R-SECRET/R-RESTART**: VM 로그/컨테이너 임시 디스크에 암호가 없는지, 재시작 후 옛 쿠키의 session 조회가 403인지 main이 확인한다. 검사 명령에 암호를 인자로 펼치거나 검사 결과에 암호/쿠키 원문을 넣지 않는다.

## 로컬 실행

```sh
cd webmail
npm run test:int
node test/int/lib/run.js --group core
WEBMAIL_INT_GROUP=mail,sieve,account npm run test:int
```

`npm run test:int -- --group core`는 Node 기본 테스트 실행기가 임의 인자를 받지 않으므로 사용하지 않는다. 그룹 인자는 위 실행기/compose entrypoint에 전달하거나 `WEBMAIL_INT_GROUP`을 사용한다. 활성화한 전체 그룹은 **한 번에 실행 불가(실패 제한 공유)**다. user5의 로그인 실패가 core의 5회 실패 전제에 영향을 주므로 위 분리 실행과 필수 대기/재시작 단계를 따른다. VM 실측 없이 로컬 건너뜀 결과를 IR 통과로 기록하지 않는다.

## IR1 시험 수정과 잔여 자료 조회

W13b 시험은 첫 미리보기 응답이 5초 미만이고 `partial`이 불리언인지 확인한다. 중간 결과이면 완료 전 적용이 `409 PREVIEW_NOT_READY`인지 확인하고 1.5초 간격으로 다시 조회한다(첫 요청부터 상한 60초). 처음부터 완료면 완료 전 적용 확인은 건너뛴 이유를 남긴다. 각 미리보기 응답의 `partial`·`scanned`를 진단에 남기고, 완료 응답으로 25통·항목 수·검색 수·정렬을 검증한다.

가상 목록 동작 시험은 HTTP 스팸 이동 뒤 **새로 인증한 IMAP 연결**로 원 폴더의 STATUS MESSAGES=0을 확인한다. 기존 관찰 연결이 그 폴더를 SELECT한 상태에서 받은 값에 의존하지 않는다. [RFC 9051 STATUS](https://www.rfc-editor.org/rfc/rfc9051.html#section-6.3.11)도 선택된 폴더 상태 조회에는 STATUS를 쓰지 않도록 한다. IR1의 간헐적 60초 검색 지연은 이 수정으로 해결됐다고 간주하지 않으며 VM 재실행으로 확인한다.

영구 삭제 뒤 Trash 검색도 새 IMAP 연결에서 EXAMINE한 뒤 합성 제목 검색 결과가 빈 배열인지 확인한다. 같은 시험의 중간 이동 확인은 매번 다른 대상 폴더를 새로 SELECT한 뒤 검색하며, 첫 플래그 확인도 HTTP 작업 뒤 SELECT한다. 이 변경은 기존 연결의 선택 상태를 피하기 위한 것이며 서버 삭제 결함으로 단정하지 않는다.

WAF 프로브의 Sieve 값은 앱 검사를 통과하는 한글·따옴표·꺾쇠·세미콜론으로 구성하고, 저장 성공 뒤 원 문서를 복원한다. 필터 상태가 `ok`/`none`이 아니면 저장 행에 `건너뜀(상태: ...)`를 표시하며 미완료 종료 코드 2를 유지한다.

남은 자료는 최신 int 이미지를 빌드한 뒤 아래 명령으로 **목록만** 확인한다(저장소 루트, 같은 VM env/인증서 사용).

```sh
docker compose -f webmail/test/int/compose.int.yml run --rm --entrypoint node int test/int/list-artifacts.mjs
docker compose -f webmail/test/int/compose.int.yml run --rm --entrypoint node int test/int/list-artifacts.mjs --users user1,user7 --subject '별도 진단 제목'
```

기본 대상은 M02 계정 10개다. `Int-<uuid>`/`Int-<uuid>-한글`·`IntExcluded` 폴더와 Drafts의 `Int-<uuid>`, `합성 WAF` 접두 제목 및 정확히 `plain`/`full`/`noscript`인 제목을 후보로 출력한다. `--subject`는 추가 정확한 제목이며 여러 번 지정할 수 있다. 이름으로 찾은 **후보**이므로 삭제 여부는 main이 판단한다. 명령은 삭제·플래그 변경을 하지 않으며 Drafts는 EXAMINE, 본문 없이 UID/제목만 조회한다. 앱 임시 첨부 파일은 IMAP 목록 대상이 아니다.

출력은 계정·종류·경로·메일 수 또는 UIDVALIDITY/UID/제목의 JSON Lines와 계정별 합계다. 일치 항목이 없어도 합계 0을 출력한다. 조회 실패는 `LIST_FAILED` 행과 종료 코드 1로 표시하고, 암호·쿠키·메일 본문·연결 오류 원문은 출력하지 않는다.


## 웹메일 OTP 격리 VM 시험

`otp.test.js`는 기본 실행에서 미실행이며 `WEBMAIL_INT=1`과 `WEBMAIL_INT_OTP=1`을 모두 명시해야 한다. 기존 그룹 선택과 runner를 변경하지 않는다. 그룹을 명시하면 account 그룹에 속하며 core 단독 실행에서는 제외된다. 다른 통합시험과 동시 실행하지 않는다. 전용 합성 계정만 사용하며 원래 정책이 OFF·계정 OTP 미등록이 아니면 변경 전에 중단한다.

추가 runtime 변수는 `WEBMAIL_INT_OTP_EMAIL`, `WEBMAIL_INT_OTP_ADMIN_URL`, `WEBMAIL_INT_OTP_ADMIN_ORIGIN`, `WEBMAIL_INT_OTP_ADMIN_KEY`(full 권한)다. 기존 `WEBMAIL_INT_URL`, `WEBMAIL_INT_ORIGIN`, `WEBMAIL_INT_PASSWORD`도 필요하다. env 파일은 VM `/dev/shm`에0600, 상위0700으로 준비하고 값/원문을 출력하지 않는다. Node24와 고정 의존성이 있는 VM 환경에서 다음 파일만 실행한다.

```sh
node --env-file=/dev/shm/webmail-otp-test.env --test test/int/otp.test.js
```

두 세션의 등록 경쟁(성공1·후발 거부), 등록 확인 코드 재사용 거부, 동일 step20개 검증의 성공1, 관리자 reset을 검사한다. 계산은 production OTP 모듈을 import하지 않는 독립 RFC6238 계산이며 QR의 수동 입력 키를 사용한다. 실제 인증 앱 QR스캔을 검증했다고 표시하지 않는다. 기본 암호의 OTP 로그인 대기 진입을 확인하며 POP3/IMAP/SMTP 영향은 별도 D-live 프로토콜 시험이 필요하다.

실패 시 finally에서 관리자 reset으로 등록을 해제한다. 정리 실패도 실패다. 정책은 변경하지 않는다. 전용 계정의 기존 행을 삭제하거나 세대/last_step을 과거로 되돌리지 않는다. 성공/실패 뒤 남은 대기 세션은 만료 또는 승인된 VM 앱 재시작으로 폐기한다. 시험 후 관리자 상태에서 미등록·정책OFF를 확인하고 `/dev/shm` 파일을 `sudo shred -u`로 제거한다. 코드·시드·쿠키·암호·API 키·QR 원문은 결과/로그에 남기지 않는다.

V01~V12 중 VM 장애주입, 키누락 격리기동, 실제 GRANT negative test, lifecycle/ABA, rollback/reupgrade, HTTPS WAF 및 목록 성능(각10회 warmup+100회 median/p95)은 별도 수동 게이트다. 자동시험의 opt-in 미설정 건너뜀을 통과로 보고하지 않는다. 실제 인증 앱을 독립 계산기로 대체한 경우 그 승인과 수동 키 사용 사실을 D-live 기록에 명시한다. 등록/정책/키는 함께 백업하고 구버전 rollback 시 공개 앱 정지를 유지해 OTP 우회를 막는다.

## 계정별 사내 IP 제한 — 격리 VM D-live

`protocol-netlimit.test.js`는 독립 opt-in runner이다. 다른 int 그룹과 동시에 실행하지 않는다.
`NETLIMIT_INT=1` 또는 필수 입력이 없으면 **V01–V16 전부 skip와 사유**를 기록한다.
skip는 인증 성공이나 VM 검증 통과가 아니다. 활성 실행은 아래 자동 항목만 수행하며,
수동 항목의 결과를 대신 만들지 않는다. main이 자동 결과와 수동 RECORD를 합쳐 V01–V16의
미실행0을 확인해야 한다. 운영 VM·다른 lane이 쓰는 VM에서 실행하지 않는다.

### 입력·실행·원복 계약

Node24와 현재 고정 의존성이 설치된 승인 VM만 사용한다. main은 VM snapshot ID·기준 HEAD·
image ID를 비공개 RECORD에 먼저 기록한다. secret 파일과 RECORD 상위는0700, 파일은0600이다.
파일을 저장소에 넣거나 `cat`, shell trace, 환경 전체 덤프를 하지 않는다.

모든 키는 `NETLIMIT_INT_` 접두사다. 값은 VM 전용 private env에 준비한다.

| 키 | 의미 |
|---|---|
| `NETLIMIT_INT=1`, `SYNTHETIC=1` | 명시적 실행·전용 합성 자원 확인 |
| `EMAIL`, `PASSWORD` | 기존 전용 `netlimit-int-…@… .test` 계정(공백 없는 `.test` 도메인), 기본 암호. active=1, OTP 미등록, 동시 사용0 |
| `HOST`, `SMTP_HOST`, `SMTP588_HOST` | IMAP993/POP3 995, SMTP465/587/25, 내부 SMTP588의 실제 TCP 목적지. DNS명/주소를 각각 지정 |
| `TLS_SERVERNAME`, `CA_FILE` | 인증서 이름, 선택 CA 파일. TLS 검증을 끄지 않음. HTTP용 사설 CA는 Node 시작 전 `NODE_EXTRA_CA_CERTS`로 지정 |
| `SOURCE_A`, `SOURCE_B` | runner 프로세스 network namespace에 이미 있는 서로 다른 IP. 실제 socket `localAddress`로 bind. A만 목록에 둠 |
| `RELAY_IP` | compose에서 확인한 실제 trusted relay 주소. V08 위조 입력용이며 접속 source를 대체하지 않음 |
| `ADMIN_URL`, `ADMIN_ORIGIN`, `ADMIN_KEY` | HTTPS 관리 API와 Origin, full key. read key 불가 |
| `MAILCOW_URL`, `MAILCOW_KEY` | HTTPS mailcow API와 쓰기 key. 임시 app password 생성·폐기에 사용 |
| `SMTP588_MODE` | `starttls` 또는 VM에서 확인한 내부 전용 `plain`. 다른 SMTP 포트는465 TLS,587/25 STARTTLS |
| `CONDITION` | 기본 `baseline`, 또는 `policy503`, `refused`, `blackhole`, `coldstart` |
| `OFF_EMAIL`, `DISABLED_EMAIL` | 장애 실행 전 별도로 seed한 전용 합성 계정. 기본 암호는 PASSWORD와 같음. OFF_EMAIL은 flagOFF+프로토콜ON, DISABLED_EMAIL은 flagON+IMAP/POP3/SMTP OFF |
| `PRESEEDED=1`, `BASELINE_MS` | 장애 실행 전 main이 세 계정 상태와 A-only 목록을 확인했다는 표식, 직전 정상 V12 median(ms). 장애 실행에 필수 |

공통 표의 `SYNTHETIC`는 실제 env 이름 `NETLIMIT_INT_SYNTHETIC`이고, 첫 opt-in만
`NETLIMIT_INT`이다. runner는 private env 파일을 직접 생성하거나 secret store를 탐색하지 않는다.
mailcow app password 계약은 [공식 구현](https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/inc/functions.app_passwd.inc.php)의
`username/app_name/app_passwd/app_passwd2/protocols`를 사용한다. 3b에서 시험 이미지의 같은 API를 확인한다.

```sh
# 승인 VM의 저장소 webmail 디렉터리. 아래 파일에는 값 대신 실제 VM secret을 안전하게 주입한다.
umask 077
install -d -m 700 /dev/shm/netlimit-record
export RECORD=/dev/shm/netlimit-record
# main이 준비한0600 env: /dev/shm/netlimit-test.env
node --env-file=/dev/shm/netlimit-test.env --test --test-concurrency=1 \
  test/int/protocol-netlimit.test.js > "$RECORD/baseline.tap" 2>&1
```

baseline은 flag/protocol 값과 목록의 IP·note를 메모리에 저장하고 finally에서 복원·재조회한다.
임시 app password는 고유 이름으로 생성하고 finally에서 ID를 재조회해 삭제·부재 확인한다.
임시 lifecycle 주소는 UUID로 만들고 mailbox/alias 부재 확인 뒤에만 소유 자원으로 등록한다.
finally에서 mailbox와 alias를 모두 정리한다. 기존 암호·기존 앱 암호는 바꾸지 않는다.
원래 행이 없던 flag의 version이나 목록 created_at/actor까지 API로 과거 값에 되돌리지는 않는다.
이 metadata까지 정확한 복구는 V16의 DB backup/snapshot restore로 확인한다. API 원복 실패는
시험 실패이며 RESTORE 성공으로 표시하지 않는다. timeout·SIGKILL·프로세스 종료로 finally를
보장할 수 없는 경우 snapshot으로 복구하고 미완료로 기록한다.

장애 실행은 설정·목록·앱 암호를 **변경하지 않는다**. DB 불가 cold start에도 TCP AUTH가
가능하도록 main이 healthy 상태에서 세 계정/목록을 먼저 준비하고 snapshot을 만든다.
runner는 조건 이름만 보고 장애를 증명하지 않는다. 실제 주입 및 첫503·로그는 아래 수동 증거가 필요하다.
포트가 연결 불가하거나 STARTTLS/AUTH가 없으면 거부 성공으로 세지 않고 실패한다.
SMTP465/587/588은 AUTH235/535만 판정하고 MAIL/RCPT를 보내지 않는다.25는 V05에서
STARTTLS 뒤 EHLO에 AUTH가 광고되지 않음을 확인하며, 광고되면 실패한다.

### source A/B 만들기 — VM 호스트에서만

예시는 RFC5737 문서 주소다. main이 사용되지 않는 두 주소와 routing을 먼저 확인한다.
Dovecot `login_trusted_networks`에 속하지 않고 relay/SOGo 주소와 겹치지 않아야 한다.
runner를 VM 호스트에서 실행하면 host의 lo에 두 /32를 임시로 붙일 수 있다.
container에서 실행하면 동일 명령을 **그 client의 network namespace 안에서** 실행한다.

```sh
sudo ip address add 192.0.2.10/32 dev lo
sudo ip address add 192.0.2.11/32 dev lo
# private env SOURCE_A/B를 위 주소로 설정. 목적지에는 각 컨테이너의 routable 주소를 사용한다.
ip route get "$NETLIMIT_VM_DOVECOT_IP" from 192.0.2.10 > "$RECORD/route-a.private"
ip route get "$NETLIMIT_VM_DOVECOT_IP" from 192.0.2.11 > "$RECORD/route-b.private"
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -h login_trusted_networks) > "$RECORD/trusted.private"
# 끝나면 이번에 추가한 주소만 제거한다.
sudo ip address del 192.0.2.10/32 dev lo
sudo ip address del 192.0.2.11/32 dev lo
```

실행 중 Dovecot의 비공개 auth 로그/packet capture에서 A/B가 각각 관측되는지 확인한다.
SNAT되어 둘 다 gateway로 보이거나 trusted subnet에 들어가면 중단한다. body의 remote 값만
바꾼 시험은 V02/V08 증거가 아니다. 반복 거부로 VM의 rate limiter/fail2ban이 개입하면
실패를 IP 제한의 성공으로 세지 않는다. 승인된 격리 VM에서만 두 정확 주소를 기존 netfilter
allowlist에 임시 등록하고 원복한다. 현재 VM 이미지의 netfilter 동작을 확인하며,
[공식 netfilter](https://github.com/mailcow/mailcow-dockerized/blob/master/data/Dockerfiles/netfilter/modules/Netfilter.py)의
allowlist는 Redis `F2B_WHITELIST` hash를 읽는다. 원래 hash는 private snapshot에 보존하고
기존 항목을 지우지 않는다. 비밀번호 실패 횟수 보호를 운영에서 끄지 않는다.

사전 준비에서 fail2ban 항목을 추가해야 하면 다음처럼 이번에 없던 두 항목만 추가·제거한다.
`STACK_DIR`는 승인 VM의 이 저장소 위치다. 기존 목록은 변경하지 않는다.

```sh
source "$STACK_DIR/scripts/lib/webmail-env.sh"
REDISCLI_AUTH=$(webmail_mailcow_value REDISPASS)
export REDISCLI_AUTH
redis_vm() { (cd "$MAILCOW_DIR" && docker compose exec -T -e REDISCLI_AUTH redis-mailcow redis-cli --raw "$@") 2>"$RECORD/redis-error.private"; }
for label in A B; do
    variable="NETLIMIT_INT_SOURCE_$label"
    address="${!variable}"
    redis_vm HEXISTS F2B_WHITELIST "$address" > "$RECORD/f2b-$label.existed.private"
    if [ "$(tr -d '\r\n' < "$RECORD/f2b-$label.existed.private")" = 0 ]; then
        redis_vm HSET F2B_WHITELIST "$address" netlimit-int > /dev/null
    fi
done
# VM netfilter가 목록을 다시 읽은 것을 확인한 뒤 시험한다. 끝난 뒤 이번에 추가한 항목만 제거한다.
for label in A B; do
    variable="NETLIMIT_INT_SOURCE_$label"; address="${!variable}"
    if [ "$(tr -d '\r\n' < "$RECORD/f2b-$label.existed.private")" = 0 ]; then redis_vm HDEL F2B_WHITELIST "$address" >/dev/null; fi
done
unset REDISCLI_AUTH
```

private env-file 값은 부모 shell에 자동 export되지 않는다. 위 source A/B와 VM 경로 같은
비시크릿 변수만 main이 검증해 shell에 지정하고, secret 파일 전체를 source하거나 출력하지 않는다.

### V01 — migration·grants·hook (수동)

`MAILCOW_DIR`, `WEBMAIL_DIR`, `WEBMAIL_ENV_FILE`은 main이 검증한 VM 경로만 쓴다.
아래 명령은 저장소 루트에서 실행한다. 전체 설정/SHOW GRANTS는 stdout으로 출력하지 않는다.

```sh
umask 077
cp -p "$MAILCOW_DIR/data/conf/dovecot/extra.conf" "$RECORD/extra.conf.before.private"
chmod 600 "$RECORD/extra.conf.before.private"
(cd "$MAILCOW_DIR" && docker compose exec -T mysql-mailcow sh -c \
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb-dump -uroot --single-transaction mailstack_webmail') > "$RECORD/webmail-db.before.private"
# 새 schema 전 snapshot에서는 첫 check 실패를 기록하고 apply한다. 이미 적용된 VM이면 check부터 성공해야 한다.
bash scripts/apply-webmail-notices-db.sh --check > "$RECORD/schema-before.private" 2>&1
bash scripts/apply-webmail-notices-db.sh apply > "$RECORD/schema-apply.private" 2>&1
bash scripts/apply-webmail-notices-db.sh --check > "$RECORD/schema-check.private" 2>&1
bash scripts/apply-webmail-dbuser.sh apply > "$RECORD/grants-apply.private" 2>&1
bash scripts/apply-webmail-dbuser.sh --check > "$RECORD/grants-check.private" 2>&1
# 정상 업데이트 경로의 env/admin readiness 확인 후 hook을 적용한다.
bash scripts/apply-dovecot-auth-policy.sh apply -y > "$RECORD/hook-1.private" 2>&1
cp "$MAILCOW_DIR/data/conf/dovecot/extra.conf" "$RECORD/extra.conf.applied.private"
bash scripts/apply-webmail-notices-db.sh apply > "$RECORD/schema-reapply.private" 2>&1
bash scripts/apply-dovecot-auth-policy.sh apply -y > "$RECORD/hook-2.private" 2>&1
cmp -s "$RECORD/extra.conf.applied.private" "$MAILCOW_DIR/data/conf/dovecot/extra.conf"
bash scripts/apply-dovecot-auth-policy.sh --check > "$RECORD/hook-check.private" 2>&1
bash scripts/verify.sh > "$RECORD/verify.private" 2>&1
```

RECORD에는 표1개, seed 행 증가0, 공개 webmail의 새 표 grant0, owned block1개, nonce 재발급0,
재apply 전후 행수 변화0을 기록한다. exact grant script의 check 결과를 쓰고 인증 hash가 포함된
SHOW GRANTS 원문은 공개하지 않는다. `mariadb-dump`가 없는 이미지에서는 기존 `mysqldump`를 사용한다.
admin이 healthy여도 DB query probe가 실패하면 hook을 적용하지 않는다.

표/행수와 공개 계정의 새 표 권한은 다음 읽기 쿼리 결과를 apply 전후에 비교한다.
결과는 숫자뿐이며 private RECORD에 보관한다.

```sh
(cd "$MAILCOW_DIR" && docker compose exec -T mysql-mailcow sh -c \
 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb -uroot --batch --skip-column-names') <<'SQL' > "$RECORD/schema-counts.private"
SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='mailstack_webmail' AND TABLE_NAME='account_protocol_netlimit';
SELECT COUNT(*) FROM mailstack_webmail.account_protocol_netlimit;
SELECT COUNT(*) FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA='mailstack_webmail' AND TABLE_NAME='account_protocol_netlimit' AND GRANTEE LIKE '%webmail_ro%';
SQL
```

### V11/V12/V13 — policy만의 장애·cold start·로그 (수동 준비＋runner)

정상 상태에서 EMAIL=flagON/전체protocolON, OFF_EMAIL=flagOFF/전체protocolON,
DISABLED_EMAIL=flagON/대상3protocolOFF를 관리 API로 준비하고 SOURCE_A만 목록에 둔다.
각 상세 GET 결과를 private RECORD에 저장하고 PRESEEDED=1을 지정한다.
baseline V12 median을 BASELINE_MS에 넣는다. baseline finally가 복원한 상태가 이 사전 준비와
일치하는지 다시 확인한 다음 장애를 주입한다.

policy URL만 변경하는 공통 절차다. 변경값은 private env의 `NETLIMIT_VM_FAULT_URL`에 둔다.
원본은 초기 extra.conf와 별도로 **현재 hook 적용이 끝난 정상 파일**을 저장한다.

```sh
cp -p "$MAILCOW_DIR/data/conf/dovecot/extra.conf" "$RECORD/extra.conf.healthy.private"
# URL은 http://<VM 내부 stub IPv4>:10041/auth-policy 등 VM 안의 목적지만 지정한다.
python3 - "$MAILCOW_DIR/data/conf/dovecot/extra.conf" <<'PY'
import os,re,ipaddress
from pathlib import Path
p=Path(__import__('sys').argv[1]);v=os.environ['NETLIMIT_VM_FAULT_URL']
m=re.fullmatch(r'http://([0-9.]+):([0-9]+)/auth-policy',v);assert m;ipaddress.IPv4Address(m[1])
b=p.read_bytes();b,n=re.subn(rb'(?m)^auth_policy_server_url = [^\n]*$',('auth_policy_server_url = '+v).encode(),b);assert n==1
p.write_bytes(b)
PY
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -n >/dev/null && docker compose exec -T dovecot-mailcow doveadm reload)
# 각 condition 뒤 다음 장애로 넘어가기 전에 반드시 복원한다.
cp -p "$RECORD/extra.conf.healthy.private" "$MAILCOW_DIR/data/conf/dovecot/extra.conf"
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -n >/dev/null && docker compose exec -T dovecot-mailcow doveadm reload)
```

refused는 VM 안의 미사용 port URL을 지정하고 `ss -ltn`의 private 기록으로 listener 부재를 확인한다.
503/blackhole은 기존 Python 지원 image를 사용한다. 새 install/pull을 하지 않는다.
다음 stub은 인증DB/nginx/admin을 중단하지 않고 VM의 private network에서만 실행한다.

```sh
# NETLIMIT_VM_FAULT_MODE=policy503 또는 blackhole. stub IP/network는 main이 검증한다.
docker run --rm --name netlimit-policy-fault --network "$NETLIMIT_VM_NETWORK" \
  --ip "$NETLIMIT_VM_FAULT_IP" -e MODE="$NETLIMIT_VM_FAULT_MODE" \
  --entrypoint python3 "$NETLIMIT_VM_PYTHON_IMAGE" -u -c '
import os,time,http.server
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  if os.environ["MODE"]=="blackhole":time.sleep(30);return
  self.send_response(503);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(b"{\"error\":\"POLICY_UNAVAILABLE\"}")
 def log_message(self,*args):pass
http.server.ThreadingHTTPServer(("0.0.0.0",10041),Handler).serve_forever()
' > "$RECORD/fault-stub.private" 2>&1
# 별도 VM 터미널에서 URL 변경 후 각 조건을 따로 실행한다. env-file은 부모 shell에 export되지 않는다.
NETLIMIT_INT_CONDITION=policy503 node --env-file=/dev/shm/netlimit-test.env --test \
  --test-concurrency=1 test/int/protocol-netlimit.test.js > "$RECORD/policy503.tap" 2>&1
# refused/blackhole/coldstart도 각각 CONDITION을 지정한다. 종료 뒤 URL 복원→stub 정지.
docker stop netlimit-policy-fault >/dev/null
```

각 실행에서 올바른 암호의 ON/OFF 성공, 틀린 암호 거부, protocolOFF 거부와
5회 min/median/max를 기록한다. blackhole 추가 median은 baseline 대비2500ms 이하여야 한다.
503/refused/blackhole 시험 때문에 NPM/nginx/기존 mailcow 인증DB를 중단하지 않는다.

coldstart는 URL을 정상으로 복원하고 **policy 표 SELECT만** 잠시 회수한다.
관리 DB 계정의 host는 generated AUTH_POLICY_BIND에서 읽고 SQL 사용 전 IPv4로 검증한다.
MYSQL_ROOT_PASSWORD는 container 안에서만 참조한다.

```sh
# BIND는 private generated env에서 읽고 IPv4 검증을 마친 값만 사용한다.
BIND=$(node --env-file="$WEBMAIL_DIR/webmail-admin.env" --input-type=module -e 'import {isIP} from "node:net";const ip=process.env.AUTH_POLICY_BIND;if(isIP(ip)!==4)throw Error("BIND_INVALID");process.stdout.write(ip)')
printf "REVOKE SELECT ON mailstack_webmail.account_protocol_netlimit FROM 'webmail_notices_admin'@'%s';\n" "$BIND" | \
 (cd "$MAILCOW_DIR" && docker compose exec -T mysql-mailcow sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb -uroot')
(cd "$WEBMAIL_DIR" && docker compose --profile admin restart webmail-admin) > "$RECORD/coldstart.private" 2>&1
# Dovecot peer의 첫 POST가 HTTP503이며 body에 status가 없는지 private 기록으로 확인한다.
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow curl -sS --max-time 3 \
 -H 'Content-Type: application/json' --data '{"login":"netlimit-int-probe@example.test","requested_username":"netlimit-int-probe@example.test","remote":"192.0.2.11","real_remote":"192.0.2.11","protocol":"imap"}' \
 -w '\n%{http_code}' "$NETLIMIT_VM_HEALTHY_POLICY_URL?command=allow") > "$RECORD/first-policy.private"
NETLIMIT_INT_CONDITION=coldstart node --env-file=/dev/shm/netlimit-test.env --test \
 --test-concurrency=1 test/int/protocol-netlimit.test.js > "$RECORD/coldstart.tap" 2>&1
bash scripts/apply-webmail-dbuser.sh apply > "$RECORD/grants-restore.private" 2>&1
bash scripts/apply-webmail-dbuser.sh --check > "$RECORD/grants-restored-check.private" 2>&1
```

복원 뒤 baseline V02/V03에서 다음 ON+B 인증이 거부되는지 확인한다. DB 복구 전에는
AUTH_POLICY_DENY=0, 처리한 요청마다 FAIL_OPEN=1이어야 한다. 정상 V03의 인증 요청마다
before 호출1회, after/report0회도 별도 관측한다. 원문 로그는 private 파일에 보관하고
다음 명령의 고정 event 개수만 공유한다.

```sh
(cd "$WEBMAIL_DIR" && docker compose --profile admin logs --no-color --since "$NETLIMIT_VM_LOG_SINCE" webmail-admin) > "$RECORD/admin-log.private" 2>&1
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
const rows=readFileSync(process.env.RECORD+'/admin-log.private','utf8').split('\n').filter(line=>/AUTH_POLICY_(DENY|FAIL_OPEN)/.test(line));
const sentinels=['EMAIL','PASSWORD','SOURCE_A','SOURCE_B','ADMIN_KEY','MAILCOW_KEY'].map(key=>process.env['NETLIMIT_INT_'+key]).filter(Boolean);
if(rows.some(row=>sentinels.some(value=>row.includes(value))))throw Error('POLICY_LOG_LEAK');
console.log(JSON.stringify({deny:rows.filter(x=>x.includes('AUTH_POLICY_DENY')).length,failOpen:rows.filter(x=>x.includes('AUTH_POLICY_FAIL_OPEN')).length}));
JS
```

### V07/V09/V10 — 기존 경로 (수동)

main은 flagON, 목록에는 A만, 브라우저 접속은 목록 밖 B로 준비한다. 직접 TCP B 인증이
거부되는 것을 V02로 먼저 확인한다. 관리 API로 상태만 조회한 결과를 webmail/SOGo의
실제 IMAP 로그인·읽기·발송 시험으로 세지 않는다.

V07: 같은 합성 계정으로 공개 webmail HTTP 로그인·목록·읽기·자기 자신에게 발송한다.
추가 private 입력은 `NETLIMIT_INT_WEBMAIL_URL`, `NETLIMIT_INT_WEBMAIL_ORIGIN`이다.
보낸 메일은 고유 Message-ID로 INBOX/Sent에서 찾아 그 메일만 정리한다.

```sh
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import {ImapFlow} from 'imapflow';
const e=process.env,subject='netlimit-int-'+randomUUID();let cookie='',csrf='',ok=true;
const direct=new ImapFlow({host:e.NETLIMIT_INT_HOST,port:993,secure:true,tls:{localAddress:e.NETLIMIT_INT_SOURCE_A,servername:e.NETLIMIT_INT_TLS_SERVERNAME,rejectUnauthorized:true,...(e.NETLIMIT_INT_CA_FILE?{ca:readFileSync(e.NETLIMIT_INT_CA_FILE)}:{})},auth:{user:e.NETLIMIT_INT_EMAIL,pass:e.NETLIMIT_INT_PASSWORD},logger:false,emitLogs:false,disableAutoIdle:true});direct.on('error',()=>{});
async function api(method,path,body){const r=await fetch(new URL(path,e.NETLIMIT_INT_WEBMAIL_URL),{method,signal:AbortSignal.timeout(60000),headers:{origin:e.NETLIMIT_INT_WEBMAIL_ORIGIN,cookie,'x-webmail-csrf':csrf,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.status!==200)throw Error('WEBMAIL_STATUS');const v=await r.json();if(path==='/api/auth/login'){cookie=(r.headers.get('set-cookie')||'').split(';')[0];csrf=v.csrf;}return v;}
try{await direct.connect();const login=await api('POST','/api/auth/login',{email:e.NETLIMIT_INT_EMAIL,password:e.NETLIMIT_INT_PASSWORD});if(login.step!=='done')throw Error('WEBMAIL_LOGIN');
 await api('GET','/api/folders');const sent=await api('POST','/api/send',{from:e.NETLIMIT_INT_EMAIL,to:[e.NETLIMIT_INT_EMAIL],subject,html:'<p>Synthetic network policy regression</p>'});if(!sent.ok)throw Error('WEBMAIL_SEND');
 const list=await api('GET','/api/messages?view=folder&folder=INBOX&q='+encodeURIComponent(subject));if(list.items.length!==1)throw Error('WEBMAIL_RECEIVE');await api('GET','/api/messages/'+encodeURIComponent(list.items[0].ref));
 if(e.NETLIMIT_INT_SHARED_FOLDER){const shared=await api('GET','/api/messages?view=folder&folder='+encodeURIComponent(e.NETLIMIT_INT_SHARED_FOLDER));if(!shared.items.length)throw Error('SHARED_EMPTY');await api('GET','/api/messages/'+encodeURIComponent(shared.items[0].ref));}
 console.log('WEBMAIL_LOGIN_READ_SEND_OK');
}catch{ok=false;}finally{try{if(direct.usable)for(const folder of ['INBOX','Sent']){await direct.mailboxOpen(folder);const found=await direct.search({subject},{uid:true});if(found.length)await direct.messageDelete(found,{uid:true});}}catch{ok=false;}finally{direct.close();}
 if(cookie)try{const r=await fetch(new URL('/api/auth/logout',e.NETLIMIT_INT_WEBMAIL_URL),{method:'POST',headers:{origin:e.NETLIMIT_INT_WEBMAIL_ORIGIN,cookie,'x-webmail-csrf':csrf},signal:AbortSignal.timeout(60000)});if(r.status!==204)ok=false;}catch{ok=false;}}
if(!ok)throw Error('WEBMAIL_OR_CLEANUP_FAILED (details omitted)');
JS
```

SOGo는 승인 VM 브라우저에서 같은 합성 계정으로 로그인→INBOX 열기→자기 자신에게
고유 `netlimit-int-<uuid>` 제목1통 발송→새 메일 읽기→그 메일만 삭제한다.
기존 브라우저 환경을 사용하고 HAR/trace/콘솔 응답은 공개하지 않는다. 다음은
`NETLIMIT_INT_SOGO_URL`에 대한 로그인 확인 명령이며 읽기·발송 수동 확인을 대체하지 않는다.

```sh
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import {chromium} from '@playwright/test';
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try {const page=await browser.newPage();await page.goto(process.env.NETLIMIT_INT_SOGO_URL);
 await page.locator('input[ng-model="app.creds.username"]').fill(process.env.NETLIMIT_INT_EMAIL);
 await page.locator('#passwordField').fill(process.env.NETLIMIT_INT_PASSWORD);
 await page.locator('form[name="loginForm"]').evaluate(form=>form.requestSubmit());
 await page.waitForURL(/\/so\/.*\/Mail\//,{timeout:30000});console.log('SOGO_LOGIN_OK');
 // 읽기/발송은 위 UI 절차로 확인해 RECORD에 남긴다. login만으로 V07을 완료하지 않는다.
} catch {throw Error('SOGO_LOGIN_FAILED (details omitted)');}finally{await browser.close();}
JS
```

[공식 SOGo 로그인 template](https://github.com/Alinto/sogo/blob/master/UI/Templates/MainUI/SOGoRootPage.wox)의
selector를 썼다. VM 버전에서 바뀌었으면 3b에서 실제 selector를 기록하고 추측으로 통과시키지 않는다.
webmail/SOGo의 real_remote가 정확한 relay/SOGo 주소인지 private 관측으로 대조한다.
같은 subnet의 다른 IP가 예외가 아닌지는 V08로 확인한다.

V09: master actor flagOFF/targetON에서 암호를 명령 인자나 로그에 넣지 않고 A/B의 실제
IMAP master 로그인을 시험한다. 다음 명령은 응답 원문 없이 성공/거부만 검사한다.

```sh
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import tls from 'node:tls';import {readFileSync} from 'node:fs';
for(const [key,expected] of [['SOURCE_A',true],['SOURCE_B',false]])await new Promise((resolve,reject)=>{
 const socket=tls.connect({host:process.env.NETLIMIT_INT_HOST,port:993,localAddress:process.env['NETLIMIT_INT_'+key],servername:process.env.NETLIMIT_INT_TLS_SERVERNAME,rejectUnauthorized:true,...(process.env.NETLIMIT_INT_CA_FILE?{ca:readFileSync(process.env.NETLIMIT_INT_CA_FILE)}:{})});let buffer='',sent=false;
 socket.setTimeout(12000,()=>socket.destroy());socket.on('error',()=>reject(Error('MASTER_IO')));socket.on('close',()=>reject(Error('MASTER_EOF')));
 socket.on('data',chunk=>{buffer+=chunk; if(!sent&&/^\* OK/m.test(buffer)){sent=true;buffer='';socket.write('a LOGIN '+JSON.stringify(process.env.NETLIMIT_INT_MASTER_LOGIN)+' '+JSON.stringify(process.env.NETLIMIT_INT_MASTER_PASSWORD)+'\r\n');}
 if(/^a (OK|NO)\b/m.test(buffer)){const ok=/^a OK\b/m.test(buffer);socket.destroy();if(ok!==expected)reject(Error('MASTER_RESULT'));else resolve();}});
});console.log('MASTER_A_ALLOW_B_DENY');
JS
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveadm user "$NETLIMIT_INT_EMAIL") > "$RECORD/doveadm-user.private"
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveadm acl get -u "$NETLIMIT_INT_EMAIL" INBOX) > "$RECORD/doveadm-acl.private"
```

MASTER_LOGIN에는 VM의 실제 separator를 쓰는 target/master 형식을, MASTER_PASSWORD에는
master 암호를 private env로 넣는다. 기존 읽기 전용 공유 fixture에서 공유 폴더 EXAMINE·읽기가
성공하는지 VM 공유 화면 또는 아래 명령으로 확인한다. doveadm exit0은 실제 공유 읽기의 대체가 아니다.

V10: LMTP는 기존 nodemailer, Sieve는 기존 client를 사용해 합성1통을 배달·검색·삭제한다.
목적지는 EMAIL 자신만 사용한다. 외부로 발송하지 않는다.

```sh
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import nodemailer from 'nodemailer';import {ImapFlow} from 'imapflow';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';
import {connectManageSieve} from './server/sieve/managesieve.js';
const e=process.env,id='netlimit-int-'+randomUUID(),messageId='<'+id+'@example.test>';
const tls={localAddress:e.NETLIMIT_INT_SOURCE_A,servername:e.NETLIMIT_INT_TLS_SERVERNAME,rejectUnauthorized:true,...(e.NETLIMIT_INT_CA_FILE?{ca:readFileSync(e.NETLIMIT_INT_CA_FILE)}:{})};
const client=new ImapFlow({host:e.NETLIMIT_INT_HOST,port:993,secure:true,tls,auth:{user:e.NETLIMIT_INT_EMAIL,pass:e.NETLIMIT_INT_PASSWORD},logger:false,emitLogs:false,disableAutoIdle:true});client.on('error',()=>{});let sieve;
try{await client.connect();await client.mailboxOpen('INBOX');const transport=nodemailer.createTransport({lmtp:true,host:e.NETLIMIT_INT_LMTP_HOST,port:24,ignoreTLS:true});
 try{await transport.sendMail({from:e.NETLIMIT_INT_EMAIL,to:e.NETLIMIT_INT_EMAIL,messageId,subject:id,text:'Synthetic network policy regression'});}finally{transport.close();}
 const found=await client.search({header:{'Message-ID':messageId}},{uid:true});if(found.length!==1)throw Error('LMTP_DELIVERY_COUNT');
 sieve=await connectManageSieve({sieveHost:e.NETLIMIT_INT_HOST,sievePort:4190,mailTlsServername:e.NETLIMIT_INT_TLS_SERVERNAME,mailTlsMode:e.NETLIMIT_INT_CA_FILE?'pin':'verify',mailTlsPinFile:e.NETLIMIT_INT_CA_FILE||''},{email:e.NETLIMIT_INT_EMAIL,password:Buffer.from(e.NETLIMIT_INT_PASSWORD)});await sieve.listScripts();console.log('LMTP_ONE_SIEVE_OK');
}catch{throw Error('LMTP_SIEVE_CHECK_FAILED');}finally{try{if(client.usable){const found=await client.search({header:{'Message-ID':messageId}},{uid:true});if(found.length)await client.messageDelete(found,{uid:true});}}finally{client.close();sieve?.close();}}
JS
```

LMTP 직후 검색 결과가0이면 VM 배달 queue/로그를 private으로 확인하고 미완료로 기록한다.
Sieve/LMTP 시험의 IMAP 관찰 연결은 A가 있는 client 또는 검증된 relay 경로에서 실행한다.
목록을 넓혀서 통과한 결과를 V10 근거로 사용하지 않는다.

### V14 DB 부분 실패·rename 보상 실패 (수동, 3b)

대상은 runner 주 계정과 별개인 빈 전용 합성 계정이다. 정상 상태에서 ON→OFF로 flag 행을
만들고 detail/flag/name/etag/관련 alias를 private 보관한다. 다음은 VM에서만 사용하는
한정된 실패 주입이며 전체 DB 중단이나 운영 변경이 아니다.

1. settings 성공→flag 실패: 해당 관리 계정의 새 표 UPDATE만 잠시 REVOKE한다.
   `REVOKE UPDATE ON mailstack_webmail.account_protocol_netlimit FROM 'webmail_notices_admin'@'<검증된 BIND>';`
   관리 PATCH에 fresh etag, 새 name, 반전 flag, private 새 password를 보낸다.
   result=partial, settings=ok, protocol-netlimit=failed, password 시도0, 원래 암호 인증 성공을 확인한다.
   apply/check로 grants를 복원하고 fresh etag로 원래 name/flag를 복원한다. 시험 암호는 폐기한다.
2. flag 성공→password 실패: 정상 상태에서 fresh etag, 반전 flag, mailcow 암호 정책을 만족하지 않는
   비어 있지 않은 `password:"x"`를 PATCH한다. flag=ok/password=failed인 partial과 실제 flag 유지,
   stage별 감사를 확인하고 fresh etag로 flag를 복원한다. 앱 입력422로 먼저 막혔다면 이 분기를 통과한 것이 아니다.
3. rename 보상 실패: 빈 old/사용하지 않는 new를 준비한다. old rename만 거부하는 mailbox BEFORE UPDATE
   trigger와 new flag DELETE만 거부하는 trigger를 잠시 만든 뒤 preview/run한다. mailcow rename 실패와
   선행 target flag 복사에 대한 보상 DELETE 실패를 만든다. old mailbox 유지/new mailbox 부재,
   partial, `mailbox.rename.protocol-netlimit.restore` 실패 감사와 new flag 잔존을 private으로 확인한다.
   다른 기존 mailbox에 영향을 주는 trigger는 만들지 않는다.

settings 실패 주입은 위 SELECT 회수 명령과 같은 방식으로 UPDATE만 회수한다.
이 명령은 정상 baseline과 같은 BIND 검증을 마친 뒤 실행한다.

```sh
printf "REVOKE UPDATE ON mailstack_webmail.account_protocol_netlimit FROM 'webmail_notices_admin'@'%s';\n" "$BIND" | \
 (cd "$MAILCOW_DIR" && docker compose exec -T mysql-mailcow sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb -uroot')
```

각 주입 뒤 실제 API를 보내는 명령이다. private env의 `NETLIMIT_INT_FAILURE_CASE`는
`settings`, `password`, `rename` 중 하나이고, `NETLIMIT_INT_FAILURE_OLD/NEW`는 위 SQL과
동일한 전용 합성 주소다. password 사례에는 UPDATE 회수를 사용하지 않는다.
원래 상태는 case별0600 파일에 보관하며 같은 파일이 있으면 덮어쓰지 않고 중단한다.

```sh
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import {writeFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';
const e=process.env,kind=e.NETLIMIT_INT_FAILURE_CASE,old=e.NETLIMIT_INT_FAILURE_OLD,next=e.NETLIMIT_INT_FAILURE_NEW;
if(!['settings','password','rename'].includes(kind)||![old,next].every(x=>/^netlimit-int-[a-z0-9-]+@[^@]+\.test$/i.test(x||'')))throw Error('FAILURE_FIXTURE_INVALID');
async function api(method,path,body){const r=await fetch(new URL(path,e.NETLIMIT_INT_ADMIN_URL),{method,headers:{origin:e.NETLIMIT_INT_ADMIN_ORIGIN,'x-mailadmin-api-key':e.NETLIMIT_INT_ADMIN_KEY,...(body?{'content-type':'application/json'}:{})},signal:AbortSignal.timeout(60000),...(body?{body:JSON.stringify(body)}:{})});if(r.status!==200)throw Error('API_STATUS');return r.json();}
try{const path='/api/admin/mailboxes/'+encodeURIComponent(old),before=await api('GET',path);
 writeFileSync(e.RECORD+'/partial-'+kind+'-before.private',JSON.stringify({address:old,name:before.name,protocolInternalOnly:before.protocolInternalOnly}),{mode:0o600,flag:'wx'});
 let result;
 if(kind==='rename'){const body={action:'preview',newLocal:next.split('@')[0],keepOldAsAlias:true};const preview=await api('POST',path+'/rename',body);result=await api('POST',path+'/rename',{...body,action:'run',etag:preview.etag});}
 else result=await api('PATCH',path,{etag:before.etag,protocolInternalOnly:!before.protocolInternalOnly,...(kind==='settings'?{name:before.name+' synthetic partial',password:'Int-'+randomUUID()+'!aA9'}:{password:'x'})});
 if(result.result!=='partial')throw Error('PARTIAL_NOT_OBSERVED');
 if(kind==='settings'&&(!result.steps.some(x=>x.stage==='settings'&&x.status==='ok')||!result.steps.some(x=>x.stage==='protocol-netlimit'&&x.status==='failed')||result.steps.some(x=>x.stage==='password')))throw Error('STAGE_ORDER');
 if(kind==='password'&&(!result.steps.some(x=>x.stage==='protocol-netlimit'&&x.status==='ok')||!result.steps.some(x=>x.stage==='password'&&x.status==='failed')))throw Error('PASSWORD_STAGE');
 const audit=await api('GET','/api/admin/history');if(!audit.items.some(x=>x.result==='partial'&&[old,next].includes(x.target)))throw Error('PARTIAL_AUDIT');
 if(kind==='rename'&&!audit.items.some(x=>x.action==='mailbox.rename.protocol-netlimit.restore'&&x.result==='failed'&&x.target===next))throw Error('COMPENSATION_AUDIT');
 writeFileSync(e.RECORD+'/partial-'+kind+'-result.private',JSON.stringify({result,observed:await api('GET',path)}),{mode:0o600,flag:'wx'});console.log('V14_PARTIAL_AND_AUDIT_VERIFIED');
}catch{throw Error('V14_MANUAL_FAILED (details omitted)');}
JS
```

settings/password 사례의 grants를 복원한 뒤 원래 name/flag/password를 복구하는 명령이다.
rename 사례는 먼저 아래 두 trigger 제거와 guide의 orphan CAS 정리를 끝내고 실행한다.

```sh
bash scripts/apply-webmail-dbuser.sh apply > "$RECORD/partial-grants-restore.private" 2>&1
bash scripts/apply-webmail-dbuser.sh --check > "$RECORD/partial-grants-check.private" 2>&1
node --env-file=/dev/shm/netlimit-test.env --input-type=module <<'JS'
import {readFileSync} from 'node:fs';const e=process.env,k=e.NETLIMIT_INT_FAILURE_CASE;
if(!['settings','password','rename'].includes(k))throw Error('RESTORE_CASE');
try{const original=JSON.parse(readFileSync(e.RECORD+'/partial-'+k+'-before.private','utf8')),url=new URL('/api/admin/mailboxes/'+encodeURIComponent(original.address),e.NETLIMIT_INT_ADMIN_URL);
 const headers={origin:e.NETLIMIT_INT_ADMIN_ORIGIN,'x-mailadmin-api-key':e.NETLIMIT_INT_ADMIN_KEY};const r=await fetch(url,{headers,signal:AbortSignal.timeout(60000)});if(r.status!==200)throw Error('RESTORE_ACCOUNT');const current=await r.json();
 const saved=await fetch(url,{method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({etag:current.etag,name:original.name,protocolInternalOnly:original.protocolInternalOnly,password:e.NETLIMIT_INT_PASSWORD}),signal:AbortSignal.timeout(60000)});if(saved.status!==200||(await saved.json()).result!=='ok')throw Error('RESTORE_PARTIAL');
 const verify=await fetch(url,{headers,signal:AbortSignal.timeout(60000)});if(verify.status!==200)throw Error('RESTORE_VERIFY');const value=await verify.json();if(value.name!==original.name||value.protocolInternalOnly!==original.protocolInternalOnly)throw Error('RESTORE_VALUE');console.log('V14_RESTORE_VERIFIED');
}catch{throw Error('V14_RESTORE_FAILED (details omitted)');}
JS
```

VM SQL 명령 예시다. mailbox의 OLD/NEW username과 netlimit의 email을 구분한다.

```sql
-- VM SQL client stdin으로 전달한다. schema/test 값은 안전하게 quote하고 stdout에 출력하지 않는다.
DELIMITER //
CREATE TRIGGER mailcow.netlimit_int_fail_rename BEFORE UPDATE ON mailcow.mailbox FOR EACH ROW
BEGIN
  IF OLD.username = 'netlimit-int-old@example.test' AND NEW.username <> OLD.username THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic rename failure';
  END IF;
END//
CREATE TRIGGER mailstack_webmail.netlimit_int_fail_restore BEFORE DELETE ON mailstack_webmail.account_protocol_netlimit FOR EACH ROW
BEGIN
  IF OLD.email = 'netlimit-int-new@example.test' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic compensation failure';
  END IF;
END//
DELIMITER ;
```

이 상태에서 위 API preview/run과 partial/감사를 확인한 뒤 다음 정리 SQL을 반드시 실행한다.

```sql
-- finally 원복: 두 trigger 제거 뒤 grants 복원, API/flag 복구를 수행한다.
DROP TRIGGER IF EXISTS mailcow.netlimit_int_fail_rename;
DROP TRIGGER IF EXISTS mailstack_webmail.netlimit_int_fail_restore;
```

SQL은 VM의 MYSQL_DATABASE가 `mailcow`인지 확인한 뒤 사용한다. 다르면 실제 schema를 private
절차에 기록한다. `docker compose exec -T mysql-mailcow sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mariadb -uroot'`
의 stdin으로 전달하고 출력은0600 RECORD에 둔다. 같은 이름의 기존 trigger가 있으면 만들지 않고 중단한다.
도중 실패해도 finally에 해당하는 정리에서 두 trigger를 제거하고 grants를 복원한다.
남은 new flag는 guide의 version CAS 절차로 mailbox 부재를 다시 확인하고 해당 행만 정리한다.
old의 name/flag/alias를 fresh API 상태로 복원하고 합성 old/new를 정리한다. partial 감사는 보존한다.
schema/grants/trigger/flag 원복이 불확실하면 snapshot으로 복구하고 미완료로 기록한다.

### V16 rollback·재적용·최종 원복 (수동)

```sh
bash scripts/apply-dovecot-auth-policy.sh --revert -y > "$RECORD/revert.private" 2>&1
# Dovecot policy URL이 비었고 기존 AUTH가 성공하는지 확인한다.
(cd "$MAILCOW_DIR" && docker compose exec -T dovecot-mailcow doveconf -h auth_policy_server_url) > "$RECORD/url-reverted.private"
cmp -s "$RECORD/extra.conf.before.private" "$MAILCOW_DIR/data/conf/dovecot/extra.conf"
# admin 정지는 hook 제거 뒤 수행한다. DB 표/flag는 DROP하지 않는다.
bash scripts/apply-dovecot-auth-policy.sh apply -y > "$RECORD/reapply.private" 2>&1
bash scripts/apply-dovecot-auth-policy.sh --check > "$RECORD/reapply-check.private" 2>&1
```

재적용하면 기존 ON값이 다시 제한하므로 V02를 재검증한다. nonce 원문·전체 설정을 출력하지 않는다.
마지막에 main이 사전 snapshot으로 VM을 복원하고 schema/grants check, 원래 image ID,
extra.conf bytes, flag/list, 합성 자원0을 확인한다. snapshot 작업은 runner의 권한 밖이며
승인된 hypervisor 작업과 snapshot ID를 RECORD에 기록한다. DB dump만 복원할 때는 consumer를
중단한 격리 VM에서 위 private dump를 mysql stdin으로 전달한다. 전체 DB 삭제나 운영 dump restore는
이 runner의 자동 동작이 아니다.

### V01–V16 분담과 산출물

| ID | 실행 |
|---|---|
| V01 | README 수동: migration/grants/hook/nonce/표 행수 |
| V02–V06 | runner baseline: source matrix/cache/fresh DB/SMTP AUTH/app password |
| V07 | README 수동: webmail/SOGo 로그인·읽기·발송과 real peer |
| V08 | runner baseline: name/originating IP 위조 |
| V09 | README 수동: master/shared/doveadm |
| V10 | README 수동: LMTP1통/Sieve |
| V11 | README에서3장애 주입→runner 각 condition의 ON/OFF/틀린 암호/protocolOFF |
| V12 | runner 각 condition5회 시간. baseline 대비 blackhole median≤2500ms |
| V13 | README에서 DB cold start/첫503/로그→runner coldstart AUTH→복구 뒤 baseline |
| V14 | runner 실제 API 성공/422/409/감사undo/rename/delete/convert/recreate. DB/보상 실패는 README 수동 |
| V15 | runner protocolOFF/defaultOFF/empty list API 경고 상태. 장애 시 protocolOFF는 condition matrix |
| V16 | README 수동: hook rollback/reapply/unrelated bytes, DB/VM snapshot restore |

공유 산출물은 V ID, pass/fail/미실행, min/median/max, restore 결과만 포함한다.
RECORD에는 각 condition TAP, private backup/dump, 변경 전후 check exit, 수동 V ID의 확인 결과를 보관한다.
URL·실IP·계정·key·password·nonce·body·HAR·SQL 오류 원문을 공유 보고서에 복사하지 않는다.
하나라도 미실행/skip/원복 불명이 남으면 VM 검증은 미완료다.