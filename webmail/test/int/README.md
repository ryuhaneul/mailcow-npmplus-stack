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
- `team-sales`, `team-support`는 mailbox(person), `team-int`는 두 mailbox로 전달하는 활성 alias(team)다. 최근 자동완성 자료는 시험이 user3 Sent에 합성 메일을 넣고 원복한다.
- user1 외의 프로그램 접근/새 메일 수신을 시험 중 멈춘다. 암호·필터·설정을 바꾸며 모든 세션을 폐기하는 시험이 있다. 각 시험의 finally/정리 훅이 원복하고, 원복 실패도 시험 실패로 기록한다.

## IR1 → IR2 명령 순서 (main, VM)

저장소 루트에서:

```sh
docker compose -f webmail/test/int/compose.int.yml build int
docker compose -f webmail/test/int/compose.int.yml run --rm int --group core
```

core 마지막 XFF 시험은 실행 컨테이너의 소스 IP를 15분 제한하고 출발 IP와 남은 초를 출력한다. IR2 전에는 **실패 제한 만료(15분) 또는 main 판단의 웹메일 재시작**이 필수다. 새 컨테이너가 같은 IP를 재사용할 수 있다. 아래 R-XFF 수동 게이트까지 마친 뒤 진행한다. IP 제한 시험을 앞당기거나 병렬 실행하지 않는다.

```sh
docker compose -f webmail/test/int/compose.int.yml run --rm int --group mail,sieve,account
```

호스트 Node 24와 `cd webmail && npm ci`로 고정 의존성이 준비되어 있어야 한다. 같은 env 파일을 **출력하지 않고** Node에 로드해 T-SIEVE를 실행한다:

```sh
cd webmail
node --env-file=/home/rocky/webmail-int.env test/int/lib/sieve-host.js
```

T-SIEVE는 Docker 소켓을 시험 컨테이너에 열지 않기 위해 **VM 호스트에서 별도 실행**한다. 실제 `docker compose exec -T dovecot-mailcow sieve-test`로 40통 × 30규칙을 `match.js`와 비교한다. `doveconf -n`에서 번호가 붙은 전역 before/after와 디렉터리의 `.sieve`를 수집하고, 실제 실행 순서에 넣는다. 전역 before/after가 없거나 해석할 수 없으면 실패한다. [Pigeonhole sieve-test의 `-s` 순서](https://raw.githubusercontent.com/dovecot/pigeonhole/release-0.5.21/doc/man/sieve-test.1.in)를 사용한다. `-e`를 쓰지 않아 실제 저장/전달은 하지 않는다. 추가로 여러 규칙이 맞는 10건의 배달 위치 1개와 부재중 기간 안/밖·스팸 3건을 검사한다. 출력 형식을 인식하지 못해도 실패하며, 합성 임시 자료의 호스트/컨테이너 경로를 보고한다.

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

`npm run test:int -- --group core`는 Node 기본 테스트 실행기가 임의 인자를 받지 않으므로 사용하지 않는다. 그룹 인자는 위 실행기/compose entrypoint에 전달하거나 `WEBMAIL_INT_GROUP`을 사용한다. 전체 그룹도 한 파일에서 순서대로 실행하며 core의 실패 제한 시험이 마지막이다. VM 실측 없이 로컬 건너뜀 결과를 IR 통과로 기록하지 않는다.
