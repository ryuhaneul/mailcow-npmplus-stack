# 메일스택 웹메일

Node.js 24 + Fastify 5, 빌드 없는 ESM 백엔드와 별도 웹 빌드로 구성한다. W01은 공통 서버 골격이며 로그인·메일 기능·화면은 후속 단계에서 추가한다.

## 로컬 개발·검증

```sh
npm ci
npm test
npm run check
node --env-file=/절대/경로/webmail.env server/index.js
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/api/config
```

`server/config.js`가 컨테이너 환경변수의 누락·형식을 시작 시 검사한다. 환경변수 파일은 저장소 밖에 권한 600으로 보관한다. 내부 서버·DB 자격값을 포함하므로 공유하거나 커밋하지 않는다. 설정 파일 생성은 후속 스택 통합 단계에서 제공한다.

필수 키(빈 값 허용 키도 키 자체는 필요):

- 공개: `PUBLIC_HOSTNAMES`, `BRAND_NAME`, `ORG_NAME`, `BRAND_MARK`, `DEFAULT_THEME`, `DEFAULT_MODE`, `ATTACH_MAX_MB`, `AUTOEXPUNGE_DAYS`
- 세션·전달: `INTERNAL_DOMAINS`, `SESSION_IDLE_MIN`, `SESSION_MAX_HOURS`
- 메일: `IMAP_HOST`, `SIEVE_HOST`, `SMTP_HOST`, `MAIL_TLS_SERVERNAME`, `MAIL_TLS_MODE`, `MAIL_TLS_PIN_FILE`
- 디렉터리: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- 사용자 화면: `MAILCOW_UI_URL`, `MAILCOW_UI_SERVERNAME`, `MAILCOW_PUBLIC_URL`
- 프록시·로그: `TRUST_PROXY`, `LOG_LEVEL`

빈 값을 허용하는 키는 `ORG_NAME`, `BRAND_MARK`, `INTERNAL_DOMAINS`, `AUTOEXPUNGE_DAYS`, `MAIL_TLS_PIN_FILE`이다. `AUTOEXPUNGE_DAYS`는 빈 값이면 자동 삭제 문구를 숨기고, 값이 있으면 1~365일이다. `MAIL_TLS_MODE`는 `verify` 또는 `pin`만 허용하며, `pin`이면 읽을 수 있는 공개 인증서 절대경로가 필요하다. `verify`이면 핀 경로는 빈 값이다. IMAP·Sieve·SMTP 포트는 각각 993·4190·587로 고정한다. `PUBLIC_HOSTNAMES`, `INTERNAL_DOMAINS`, `TRUST_PROXY`는 쉼표 목록이다.

`GET /healthz`는 `{ok:true}`, 로그인 없는 `GET /api/config`는 브랜드·기본 테마/모드·첨부 상한·자동 삭제 일수·버전만 반환한다. 오류는 `{error:{code,message}}` 형식이다. 인증 실패 상태는 403으로 통일하며 인증 도전 응답 머리글을 제거한다. 앱 토큰은 인입 Authorization 머리글로 받지 않는다. 세션·CSRF 구현은 W02에서 추가한다.

정적 서빙 기본 경로는 `web/dist`다. 디렉터리가 없으면 서버는 정상 기동하고 화면 경로에는 404 JSON을 반환한다. 빌드 결과가 있으면 정적 파일과 SPA 대체 경로를 제공하며 `/api/*`는 JSON 404를 유지한다. `createApp({staticDir})`로 시험 디렉터리를 지정할 수 있다.

## 빌드·배포 (후속 단계)

`npm run build`는 F01의 `web/` 입력을 전제로 한다. W01에는 화면 파일이 없어 아직 실행할 수 없다. `test:int`·`e2e`도 해당 후속 단계에서 시험 파일을 제공한다.

Dockerfile은 웹 빌드 → 운영 의존성만 설치한 실행 단계로 구성한다. 이미지 기반은 Docker Hub `library/node:24-bookworm-slim`의 2026-10-15 UTC 조회 digest로 고정했다. F01 전에는 이미지 빌드와 기본 화면 실행이 미확인이다.

서버 설치 경로는 `/home/webmail`, 환경변수 파일은 `/home/webmail/webmail.env`다. compose는 기존 mailcow 외부 네트워크에 붙으며 포트를 호스트에 게시하지 않는다. NPMplus가 내부의 `webmail:8080`으로 연결한다. 읽기 전용 파일시스템, `node` 사용자, 1GB 메모리 상한과 `/tmp` tmpfs를 사용한다. `pin` 인증서 마운트·고정 IP는 setup/update의 override 생성 단계에서 추가한다.

```sh
cd /home/webmail
docker compose build
docker compose up -d
```

실제 서버 적용·스택 선택값·프록시 연결·업데이트·롤백 절차는 후속 통합 단계에서 추가한다. 세션은 메모리만 사용하므로 재시작하면 다시 로그인해야 한다.


## 관리자 계정 관리

운영 현황의 `mailcow 관리자` 표에서 관리자 추가·사용 켜기/끄기·다른 관리자 암호 재설정·삭제를 할 수 있다. 본인 암호는 상단의 `내 암호 변경`을 사용한다. 본인 삭제·끄기와 마지막 활성 관리자 제거는 서버에서도 거절한다. 좁은 화면에서는 표 안에서 가로로 스크롤해 행 동작에 접근한다.

목록 조회는 기존 읽기/전체 API 키 접근을 유지하지만 계정 변경은 사람 로그인 세션에서만 허용한다. 암호 변경과 계정 변경은 같은 잠금으로 처리하며 최신 강제 인증 플래그를 보존한다. TOTP 등록·해제, 강제 조치 설정, 계정 이름 변경은 제공하지 않는다.

계정 변경 시 이 관리 서버 프로세스가 보유한 해당 계정의 세션과 진행 중 로그인 확정을 차단한다. 원격 직접 mailcow 세션이나 다른 인스턴스까지 일괄 폐기하는 기능은 아니다. 변경 이력은 감사용이며 되돌리기를 지원하지 않는다. 삭제한 인증 정보나 이전 암호는 보관하지 않는다. 결과를 확인하지 못한 경우 목록을 다시 읽어 현재 상태를 확인하고, 암호 재설정은 자동 재시도하지 않는다.
