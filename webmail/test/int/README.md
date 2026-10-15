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
