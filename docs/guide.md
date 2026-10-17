# Mailcow + NPMplus + CrowdSec 구성 가이드

> NPMplus(리버스 프록시) + CrowdSec(WAF)를 Mailcow 앞단에 배치하고,
> 도메인별로 서비스를 분리하는 최종 구성 가이드.
>
> **이 문서는 git clone 후 base 도메인만 변경하면 동일 구성을 재현할 수 있도록 작성됨.**

---

## 아키텍처

```
[인터넷]
    │
    ├── :80/443 ──→ [NPMplus + CrowdSec WAF]
    │                  │
    │                  ├── mail.DOMAIN ─────→ snappymail:8888 (웹메일)
    │                  ├── mailcow.DOMAIN ──→ nginx-mailcow:8443 (관리 UI)
    │                  │     └── /toolkit/ ─→ toolkit-mailcow:5000
    │                  └── mail-npm.DOMAIN ─→ 127.0.0.1:81 (NPM 대시보드)
    │
    ├── :25/465/587 ──→ [postfix-mailcow] (직접 노출)
    └── :143/993 ─────→ [dovecot-mailcow] (직접 노출)
```

### 핵심 설계

| 항목 | 결정 | 이유 |
|------|------|------|
| MAILCOW_HOSTNAME | `mail.DOMAIN` 유지 | Postfix HELO, Autodiscover, SPF/DKIM에 사용 |
| Mailcow HTTP 포트 | `127.0.0.1:8080/8443` | 외부 직접 접근 차단, NPM 경유만 허용 |
| SSL 인증서 | NPM이 발급, 볼륨 공유로 Mailcow에 전달 | acme-mailcow 비활성화, 단일 인증서 관리 |
| acme-mailcow | `sleep infinity` + `restart: "no"` | NPM이 인증서 담당하므로 비활성화 |
| Snappymail | 전용 도메인 루트 서빙 | 서브패스 symlink 해킹 제거 |

---

## 사전 요구사항

### DNS 레코드

```
mail.DOMAIN         A    SERVER_IP
mailcow.DOMAIN      A    SERVER_IP
mail-npm.DOMAIN     A    SERVER_IP
```

`mail.DOMAIN`은 기존 MX 레코드와 동일. 나머지 2개 추가.

### 디렉토리 구조

```
/home/
├── mailcow-dockerized/     # Mailcow (git clone)
├── npmplus/                 # NPMplus + CrowdSec
├── snappymail/              # Snappymail
└── mailcow-toolkit/         # Toolkit (optional)
```

---

## 1. NPMplus + CrowdSec

### 외부 이미지 버전 고정·변경

스택 외부 이미지는 태그와 다이제스트를 함께 고정합니다. 현재 고정판은 NPMplus `2026-07-24-r1`, CrowdSec `v1.7.8`, SnappyMail `v2.38.2`이며, 정확한 다이제스트는 아래 예시와 레포의 `npmplus/docker-compose.yml`·`snappymail/docker-compose.yml`에 있습니다. `docker compose pull`은 이 다이제스트의 이미지만 받으므로 유지합니다.

update는 pull 전에 런타임 compose의 대상 서비스 `image:`가 예전 기본 이미지의 `:latest` 또는 태그 없는 값일 때만 백업 후 레포 고정값으로 바꿉니다. 백업은 같은 폴더의 `docker-compose.yml.bak-<날짜시각>.<고유값>`이며 경로와 변경 내용을 로그에 남깁니다. 다른 설정·주석·들여쓰기는 보존합니다. 운영자가 다른 특정 태그나 다이제스트를 지정했다면 **“레포 고정값과 다름 — 그대로 둠, 맞추려면 docs 절차”** 경고만 남기고 그 값을 유지합니다.

판을 올릴 때에는 **시험 서버에서 먼저 변경·검증 → 레포 compose의 태그·다이제스트와 이 문서 예시 갱신 → 운영 update** 순서로 진행합니다. 운영자는 update 전에 `/home/npmplus/docker-compose.yml`·`/home/snappymail/docker-compose.yml`의 `image:`를 레포와 비교하세요. 다른 버전을 직접 지정해 둔 서버를 레포와 맞추려면 먼저 런타임 compose를 별도 백업하고, 대상 서비스의 `image:` 값만 레포 값으로 직접 옮긴 뒤 update를 실행합니다. 설치 경로를 바꾼 서버는 해당 경로를 사용합니다. **현재 실행 중인 판이 레포 고정판보다 새로우면, 이 동기화·update로 낮은 판이 기동될 수 있습니다.** 변경 전 백업과 호환성을 확인하며 자동 버전 판단은 하지 않습니다.

Toolkit도 시험 서버에서 먼저 확인한 뒤 `toolkit/Dockerfile`의 Python 태그·다이제스트와 `toolkit/requirements.txt`의 15개 정확한 판을 함께 갱신합니다(현재 Python `3.12.15-slim-trixie`, 다이제스트 `sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1`, Docker Hub 갱신 2026-10-09). 새 설치는 이 파일들을 복사하며, update는 실제 빌드 폴더의 예전 기본 FROM 줄·범위 지정 4줄 requirements만 각각 백업 후 이전하고 운영자 수정은 경고만 남겨 보존합니다. 경고가 난 서버를 수동으로 맞추려면 `/home/mailcow-toolkit`의 두 파일을 백업하고 FROM 줄과 requirements만 레포 고정값으로 옮긴 뒤 update를 실행하세요. 기반 다이제스트가 바뀌면 기반 레이어가, requirements 내용이 바뀌면 COPY와 pip 설치 레이어가 무효화되어 다음 `docker compose build --pull toolkit-mailcow`에 반영됩니다. 이미 같은 기반 다이제스트라면 해당 기반 캐시를 재사용해도 같은 판입니다.

### 1.1 Bouncer 키 생성

```bash
openssl rand -hex 32 > /home/npmplus/.env.key
echo "CROWDSEC_BOUNCER_KEY=$(cat /home/npmplus/.env.key)" > /home/npmplus/.env
rm /home/npmplus/.env.key
```

### 1.2 docker-compose.yml

```yaml
# /home/npmplus/docker-compose.yml
services:
  npmplus:
    image: zoeyvid/npmplus:2026-07-24-r1@sha256:f7f6ca26082036ee6387a7da336267fe61f16b1eb8087dd964237238b59479ef
    container_name: npmplus
    restart: always
    ports:
      - "80:80"         # NPMplus 내부 리스닝 포트는 80/443 (8080 아님)
      - "443:443"
      - "127.0.0.1:81:81"  # 관리 UI — localhost only
    environment:
      TZ: Asia/Seoul
      INITIAL_ADMIN_EMAIL: "${NPM_ADMIN_EMAIL}"
      INITIAL_ADMIN_PASSWORD: "${NPM_ADMIN_PASSWORD}"
      LOGROTATE: "true"
    volumes:
      - npmplus-data:/data
    networks:
      - npmplus-net
      - mailcow-network
    depends_on:
      - crowdsec

  crowdsec:
    image: crowdsecurity/crowdsec:v1.7.8@sha256:2f527c9bb8b367120eb08b82890aa912ce96bfa1ada93dda0721700e4b4e0dde
    container_name: crowdsec
    restart: always
    environment:
      TZ: Asia/Seoul
      COLLECTIONS: "crowdsecurity/nginx crowdsecurity/http-cve ZoeyVid/npmplus crowdsecurity/appsec-crs"
      BOUNCER_KEY_npmplus: "${CROWDSEC_BOUNCER_KEY}"
      DISABLE_SCENARIOS: "crowdsecurity/http-generic-bf crowdsecurity/appsec-native crowdsecurity/crowdsec-appsec-outofband"
      DISABLE_ONLINE_API: "true"
    volumes:
      - npmplus-data:/npmplus-data:ro    # NPM 로그 읽기 전용
      - crowdsec-data:/var/lib/crowdsec
      - crowdsec-config:/etc/crowdsec
    networks:
      - npmplus-net

    healthcheck:
      test: ["CMD", "cscli", "lapi", "status"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 30s
volumes:
  npmplus-data:
  crowdsec-data:
  crowdsec-config:

networks:
  npmplus-net:
  mailcow-network:
    external: true
    name: mailcowdockerized_mailcow-network
```

### 1.3 주의사항

- **포트 매핑**: NPMplus 컨테이너 내부에서 80/443/81을 리스닝한다 (8080/8443 아님).
- **인증서 저장 경로**: `/data/tls/certbot/live/npm-{ID}/` (표준 `/etc/letsencrypt/` 아님). NPMplus가 자동으로 마이그레이션함.
- **`/etc/letsencrypt` 볼륨 불필요**: 마운트하면 NPMplus가 마이그레이션 후 제거를 요구함.
- **Mailcow 네트워크 참여 필수**: `mailcow-network`에 연결해야 `nginx-mailcow`, `snappymail`, `toolkit-mailcow` 등 내부 컨테이너에 접근 가능.

### 1.4 CrowdSec 보안 필터

CrowdSec는 NPMplus의 `npmplus` 형식 접근 로그를 수집해 반복 공격 IP를 차단하고, AppSec(CRS PL1, 임계 5)로 요청을 검사합니다. setup·update가 리스너·규칙·프로필·바운서 설정을 적용합니다. CAPI 연결과 외부 결정 수신은 끄며, 로컬 경보에서만 IP 차단 결정을 만듭니다. AppSec 장애 시 요청은 통과합니다(`passthrough`). `LOGROTATE=true`는 접근 로그 생성·순환에 필요합니다. 환경변수만으로 바운서는 켜지지 않으므로 NPMplus `/data/crowdsec/crowdsec.conf`도 스택이 관리합니다. stream 시간 초과를 피하도록 `REQUEST_TIMEOUT=10000`을 사용합니다.

| `.env` 키 | 기본값 | 설명 |
|---|---|---|
| `WAF_ENABLE` | `true` | 키가 없어도 켬. `false`면 스택 관리 설정을 원복하고 바운서를 끔 |
| `WAF_MODE` | `block` | `block`: 공격 요청 403. `detect`: 요청을 통과시키고 경보만 기록(튜닝용) |
| `WAF_ALLOWLIST` | 빈 값 | 쉼표로 나눈 IP·CIDR. IP 차단 결정만 제외하며 AppSec 요청 403은 유지 |

setup·update는 이 세 키를 `.env`에 쓰거나 변경하지 않습니다. 운영 기본값은 `block`입니다. 기존 설치도 키가 없으면 다음 update부터 켜집니다. 튜닝 전 이를 막거나 필터를 해제하려면 서버 `.env`에 `WAF_ENABLE=false`를 직접 적고 update를 실행하세요. 스택이 관리하던 설정만 원복하고 기존 profiles를 복구합니다. 웹메일이 켜져 있으면 정규화한 웹메일 호스트에만 본문·검색·암호 필드 예외를 적용하며, 다른 호스트와 메서드에는 적용하지 않습니다. NPM 관리 `/api/nginx/`에는 필요한 규칙 두 개만 제외합니다. `appsec-default`와 `generic-rules`를 중복으로 싣지 않으며(중복 rule ID는 기동 실패), 403 반복을 다시 밴으로 키우지 않는 로컬 시나리오를 사용합니다. 설정이 같으면 파일 쓰기와 CrowdSec SIGHUP을 생략합니다. setup은 Phase7에서 설정을 적용하고 Phase10 마지막의 기존 NPMplus 재시작 한 번으로 읽힙니다. 그 사이 실패하면 파일만 적용된 상태일 수 있으며 다음 setup의 마지막 재시작이나 update 재시작에서 반영됩니다. update의 기존 NPMplus 재시작은 DNS 캐시 갱신을 위해 한 번 유지합니다.


다음 메일 서비스 예외는 `mailcow.${DOMAIN}` 호스트에만 적용합니다. NPM 관리 API 예외는 표에 적은 두 Host에만 적용합니다. AppSec 규칙 제거는 block의 in-band·detect의 out-of-band에서만 실행하며, 다른 호스트·메서드·경로에는 적용하지 않습니다.

| 요청 | 예외 | 근거 |
|---|---|---|
| Host `127.0.0.1:81`·`mail-npm.${DOMAIN}`의 POST `/api/nginx/{proxy-hosts,redirection-hosts,streams}`·PUT 같은 경로의 `/<숫자ID>` | `forward_*`·`forwarding_*` 키 오탐인 930120만 제외. 920350·다른 공격 검사는 유지 | [고정 NPMplus 모델](https://github.com/ZoeyVid/NPMplus/blob/a30a95471e667a8207c2a349422e4ce9492fcc95/frontend/src/api/backend/models.ts#L95-L237), [JSON 키 변환](https://github.com/ZoeyVid/NPMplus/blob/a30a95471e667a8207c2a349422e4ce9492fcc95/frontend/src/api/backend/base.ts#L36-L40) |
| POST `/Microsoft-Server-ActiveSync` | Content-Type이 `application/vnd.ms-sync.wbxml`·`message/rfc822`일 때만 920420·920180·932260 제외 | ActiveSync WBXML·MIME 발송·빈 본문 실측, [MS-ASHTTP](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-ashttp/f1dda4f4-5a06-4761-8ae6-38189eb649a8) |
| PROPFIND `/.well-known/caldav`·`/.well-known/carddav` | 끝 `/` 유무 두 형태에서만 911100 제외 | DAV 클라이언트 계정 발견 실측 |
| PROPFIND·REPORT·PROPPATCH·MKCOL·MKCALENDAR·MOVE `/SOGo/dav/…` | 911100 제외. PUT·DELETE는 기존 허용 메서드 유지. COPY는 [SOGo 구현](https://github.com/Alinto/sogo/blob/master/SoObjects/SOGo/SOGoContentObject.m#L452-L465)이 405를 반환하므로 예외 없음 | [CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791.html#section-5.3), [CardDAV RFC 6352](https://www.rfc-editor.org/rfc/rfc6352.html#section-6.3.1), [WebDAV RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html#section-9) |
| PUT `/SOGo/dav/…` | Content-Type이 `text/calendar`·`text/vcard`일 때만 920420 제외 | 일정·연락처 업로드 실측. CRS가 이 MIME 본문을 파싱하지 않아 `.ics`·`.vcf` 본문 값은 검사하지 않음 |
| POST `/inc/ajax/sieve_validation.php` | 리터럴 폼 필드 `script`만 CRS 검사 제외 | Sieve `require [...]`·기본 프리셋 실측 |
| POST `/api/v1/add/filter`·`/api/v1/edit/filter` | 리터럴 폼 필드 `attr`만 CRS 검사 제외 | Sieve를 담은 JSON 문자열, [mailcow 필터 수정](https://github.com/mailcow/mailcow-dockerized/blob/master/data/web/templates/edit/filter.twig) |
| POST `/SOGo/so/<사용자>/Preferences/save` | 사용자 경로 한 구간으로 한정해 942220·930120만 제외 | 기본값 `CDefaultsSize=4294967295`와 `Forward` 필드명 오탐. `.forward`가 `ARGS_NAMES`의 소문자 필드명과 매치하며 배열 키도 있어 리터럴 필드 예외로 처리할 수 없음 |

CalDAV·CardDAV의 위 PUT 예외는 원래 MIME 규칙이 요청 전체를 막던 것을 허용합니다. `text/calendar`·`text/vcard` 본문의 명령 문자열·HTML 값도 CRS 검사 대상이 아닙니다. 쓰기에는 SOGo 로그인 인증이 필요하며, 저장한 일정·연락처를 화면에 표시할 때의 이스케이프는 SOGo가 담당합니다. 인증 없는 PUT의 401 거절은 이번 로컬 CrowdSec 시험에서 미확인입니다. 허용하지 않은 MIME(`application/x-custom`)으로 보낸 같은 원시 공격 본문은 403이고, 유효한 JSON으로 감싼 공격도 403이며, Preferences/save에서도 다른 SQLi·XSS·RCE·경로 이동 검사는 유지됩니다. 다만 `Content-Type: application/json`에 JSON이 아닌 원문을 보내면 본문이 해석되지 않아 호스트·경로와 관계없이 본문 값은 검사되지 않습니다(이 예외 추가 전부터 같은 동작 — 알려진 한계).

시험 VM에서는 합성 데이터로 `WAF_MODE=detect`를 설정하고 update → 정상 동작·공격 재현 → `cscli alerts list`·`cscli alerts inspect ID`로 확인 → 필요한 호스트·경로·필드만 예외 조정 → `WAF_MODE=block`으로 update → 정상 요청 통과와 공격 403을 다시 확인하세요. 예외 변경은 스택의 렌더 원본을 수정해 검토·검증한 뒤 배포합니다. 컨테이너 파일만 직접 수정하면 다음 update가 다시 적용할 수 있습니다. Coraza v1.7.8에서는 예외를 리터럴 필드 키 → 개별 규칙 → 요청 단위 순으로 좁혀 적용합니다. 정규식·`ARGS` 전체·`ARGS_NAMES` 예외는 기대대로 작동하지 않습니다. 본문 검사 한도 10MiB를 넘는 첨부는 업로드 경로에서만 본문 검사를 제외합니다.

block은 스캐너 규칙 913100 외의 일반 AppSec 경보를 취소하므로 무엇이 막았는지 경보에 남지 않을 수 있습니다. **운영에서 detect를 쓰면 경보와 CrowdSec DB에 사용자 입력이 남을 수 있습니다.** block에서 오탐 신고가 오면 필요한 짧은 시간만 detect로 내려 같은 동작을 재현하고, 경보를 확인해 예외를 조정한 다음 block으로 복귀하세요. 종료 후 `docker exec crowdsec cscli alerts delete --all`로 경보를 삭제하세요. 이 명령은 모든 경보를 지우므로 필요한 조사 내용을 먼저 확인합니다. 스택은 경보를 자동 삭제하지 않습니다.

- **IP 밴**: `docker exec crowdsec cscli decisions list --ip 203.0.113.10`으로 확인하고 `docker exec crowdsec cscli decisions delete --ip 203.0.113.10`으로 해제합니다. 반복 오탐이면 로컬 시나리오와 allowlist를 검토합니다.
- **AppSec 요청 오탐**: 밴을 해제하거나 allowlist에 넣어도 요청 403은 유지됩니다. 해당 규칙과 호스트·메서드·경로·필드를 확인해 좁은 예외를 추가합니다.

NPMplus 호스트 필드 `npmplus_crowdsec_appsec`는 **이름과 반대로 `true`면 AppSec 꺼짐**입니다. 관리·웹메일 호스트에서 이 값이 켜져 있으면 verify가 WARN을 냅니다. verify는 바운서 최근 pull·AppSec 응답·로그 파싱·CAPI 비활성·모드를 확인하고, 비관리 웹메일 호스트에 `--resolve <호스트>:443:127.0.0.1`로 로컬 CRS XSS 요청을 보내 헤어핀 문제를 피합니다. block은 403, detect는 앱 도달과 실제 로그 IP의 결정 0을 확인합니다. 정상 요청도 403이면 판정 불가로 실패하고, 비관리 호스트나 detect의 요청 로그가 없으면 이유를 표시해 SKIP합니다.

---

## 2. Mailcow 설정 변경

### 2.1 mailcow.conf

```bash
# 변경하는 항목만 (나머지는 기본값 유지)
MAILCOW_HOSTNAME=mail.DOMAIN          # 변경하지 않음!
HTTP_PORT=8080                        # 기본 80 → 8080
HTTPS_PORT=8443                       # 기본 443 → 8443
HTTP_BIND=127.0.0.1                   # 기본 빈값 → localhost only
HTTPS_BIND=127.0.0.1                  # 기본 빈값 → localhost only
SKIP_LETS_ENCRYPT=n                   # 기본값 유지 (acme는 override에서 비활성화)
```

> `HTTP_BIND=127.0.0.1`이 핵심. 빈값이면 0.0.0.0 바인딩으로 WAF 우회 경로가 됨.

### 2.2 docker-compose.override.yml

```yaml
# /home/mailcow-dockerized/docker-compose.override.yml
services:
  # --- NPM 인증서 볼륨 공유 ---
  nginx-mailcow:
    volumes:
      - npmplus-data:/npm-data:ro
  dovecot-mailcow:
    volumes:
      - npmplus-data:/npm-data:ro
  postfix-mailcow:
    volumes:
      - npmplus-data:/npm-data:ro

  # --- acme-mailcow 비활성화 ---
  acme-mailcow:
    restart: "no"
    entrypoint: ["sleep", "infinity"]

  # --- Toolkit (optional) ---
  toolkit-mailcow:
    build: /home/mailcow-toolkit
    container_name: toolkit-mailcow
    restart: always
    working_dir: /app
    command: ["gunicorn", "-b", "0.0.0.0:5000", "-w", "2", "--access-logfile", "-", "main:app"]
    volumes:
      - /home/mailcow-toolkit/config.yml:/config/config.yml:ro
      - /home/mailcow-toolkit/data:/data      # 팀 분배 변경 전 필터 백업 (4.2)
    networks:
      mailcow-network:
    labels:
      - "com.docker.compose.project=mailcowdockerized"

volumes:
  npmplus-data:
    external: true
    name: npmplus_npmplus-data
```

### 2.3 SSL 인증서 심볼릭 링크

NPM이 발급한 인증서를 Mailcow가 사용하도록 심볼릭 링크 생성.

```bash
cd /home/mailcow-dockerized/data/assets/ssl/

# 기존 인증서 백업
cp cert.pem cert.pem.bak.acme
cp key.pem key.pem.bak.acme

# 심볼릭 링크 생성 (컨테이너 내부 경로로!)
rm -f cert.pem key.pem
ln -s /npm-data/tls/certbot/live/npm-{CERT_ID}/fullchain.pem cert.pem
ln -s /npm-data/tls/certbot/live/npm-{CERT_ID}/privkey.pem key.pem
```

> **중요**: 심볼릭은 **컨테이너 내부 경로** `/npm-data/...`를 가리켜야 한다.
> 호스트에서는 dangling symlink이지만, `npmplus-data` 볼륨이 `/npm-data:ro`로
> 마운트된 컨테이너(nginx, dovecot, postfix) 안에서는 정상 resolve된다.

> `{CERT_ID}`는 NPM에서 `mail.DOMAIN` 인증서 발급 후 확인. NPM API로 조회:
> ```bash
> curl -skL -b cookies http://127.0.0.1:81/api/nginx/proxy-hosts | python3 -m json.tool
> ```
> 해당 proxy host의 `certificate_id`가 cert 디렉토리명 (`npm-2`, `npm-3` 등).

### 2.4 Mailcow 업데이트 시 주의

`update.sh`가 `cert.pem`/`key.pem`에 `cp`를 시도하는데, dangling symlink에는
쓸 수 없어서 경고가 뜬다 (`cp: not writing through dangling symlink`).
**이 경고는 무시해도 된다** — 심볼릭 자체는 유지되고 컨테이너 안에서 정상 동작한다.

---

## 3. Snappymail

### 3.1 docker-compose.yml

```yaml
# /home/snappymail/docker-compose.yml
services:
  snappymail:
    image: djmaze/snappymail:v2.38.2@sha256:5e3d990438809a8a49f8ac5758db03e858e6e9fc0e369e1f9e474f7664079905
    container_name: snappymail
    restart: always
    command:
      - /bin/sh
      - -c
      - |
        VER=$$(ls /snappymail/snappymail/v/ | head -1)
        KO_DIR=/snappymail/snappymail/v/$${VER}/app/localization/ko
        if [ -f /var/lib/snappymail/admin_ko.json ] && [ ! -f $${KO_DIR}/admin.json ]; then
          cp /var/lib/snappymail/admin_ko.json $${KO_DIR}/admin.json
        fi
        exec /entrypoint.sh
    volumes:
      - snappymail-data:/var/lib/snappymail
    networks:
      mailcow-network:
        aliases:
          - snappymail
    environment:
      - SECURE_COOKIES=true

volumes:
  snappymail-data:

networks:
  mailcow-network:
    external: true
    name: mailcowdockerized_mailcow-network
```

### 3.2 도메인 설정

`setup.sh`가 자동으로 도메인 설정 JSON을 생성한다.
수동 설정 시 아래 사항을 반드시 준수:

| 항목 | 값 | 이유 |
|------|-----|------|
| IMAP host | `dovecot-mailcow` | Docker 내부 네트워크 (DNS 불필요) |
| IMAP port | `993` (SSL) | |
| SMTP host | `postfix-mailcow` | Docker 내부 네트워크 |
| SMTP port | `465` (SSL) | |
| `shortLogin` | `false` | Dovecot lua passdb는 `user@domain` 형식 필수. `true`이면 `@domain`이 잘려서 인증 실패 |
| `security_level` | `0` | self-signed 인증서 환경에서 `1` 이상이면 SSL 핸드셰이크 실패 |
| Sieve type | `2` (STARTTLS) | |
| `disabled_capabilities` | `[]` (빈 배열) | 값이 있으면 IMAP 기능 제한으로 오동작 가능 |

도메인 설정 파일 경로: `/var/lib/snappymail/_data_/_default_/domains/{DOMAIN}.json`

**주의:**
- 파일 소유자가 `www-data:www-data`여야 한다. 잘못되면 Snappymail이 읽지 못함.
- `application.ini`의 `default_domain`을 도메인으로 설정하면 로그인 시 `@domain` 생략 가능.

### 3.3 인증 흐름

```
Snappymail → IMAP LOGIN user@domain password
  → dovecot (lua passdb)
    → POST https://nginx:9082 (mailcowauth.php)
      → MariaDB 비밀번호 검증
```

Dovecot은 자체적으로 비밀번호를 검증하지 않고, lua 스크립트가 PHP 엔드포인트를 호출한다.
`mailcow.conf`의 `API_KEY`가 설정되어 있어야 이 체인이 동작한다.

### 3.4 변경 포인트

- 서브패스용 `ln -sf` symlink 제거 (루트 서빙이므로 불필요)
- Mailcow nginx의 `site.snappymail.custom` 삭제 (NPM이 직접 라우팅)
- 한국어 패치 자동 복구 로직 유지

---

## 4. Toolkit 설정 (optional)

### 4.1 config.yml

```yaml
# /home/mailcow-toolkit/config.yml
mailcow:
  api_url: "https://nginx-mailcow:8443"    # 포트 8443 필수!
  api_key: "YOUR_MAILCOW_API_KEY"

toolkit:
  secret_key: "RANDOM_SECRET"
  modules:
    - groups
    - syncjobs
    - shares
```

> `api_url` 포트를 `8443`으로 맞춰야 한다. Mailcow nginx가 기본 443이 아닌
> 8443에서 리스닝하기 때문.

화면 오른쪽 위 해/달 버튼으로 라이트·다크 테마를 전환한다(선택은 브라우저에 저장, 저장 전에는 시스템 설정을 따른다). 다크 테마에서만 배경에 별 장식이 로드된다.

### 4.2 팀 분배 관리 (groups 모듈)

"팀"은 메일박스의 mailcow **prefilter**(활성, 메일박스당 1개)에서 맨 앞 단계(`{ }` 밖)에 있는 `redirect :copy "<주소>";` 줄로 정해진다. 그 줄의 주소가 **구성원**이고, 팀 메일함으로 온 메일의 사본을 받는다. 구성원이 1명 이상인 메일함이 팀이다. 별칭(alias)은 쓰지 않으며 서버의 별칭은 건드리지 않는다.

**그룹 관리 화면**: 팀 카드(팀 주소·구성원 수·구성원 이름/주소), 검색(팀·구성원), [구성원 추가](메일박스를 검색해 선택, 이미 구성원인 사람은 제외), [빼기](확인 후; 마지막 1명은 비활성). 받은 메일을 통째로 다른 메일함으로 넘기는 메일함(`redirect "<주소>";` 만 있는 경우)은 아래에 읽기 전용으로 나온다. 내용을 해석할 수 없거나 안전하게 고칠 수 없는 필터(활성 prefilter 2개 이상, 구성원 앞에 `stop`/`discard`/이동 명령, 구성원 줄에 다른 명령이 같이 있음 등)는 편집 버튼 없이 "mailcow 필터 화면에서 직접 수정"으로 표시된다.

**메일박스 생성 화면**: 일괄 생성 위의 팀 버튼(여러 개 선택 가능)을 고르면, **생성에 성공한 계정만** 선택한 팀에 구성원으로 추가된다. 결과 표에 "생성 결과"와 팀별 "팀 분배" 결과가 따로 나오고, 분배에 실패한 칸은 [다시 시도]로 분배만 다시 한다(이미 구성원이면 변경 없이 성공). 분배가 실패해도 메일박스는 삭제되지 않는다. 팀 목록을 못 불러오면 안내 한 줄만 나오고 생성은 그대로 된다.

**저장 방식**: 넣기·빼기는 그 줄 하나만 추가·삭제하고 나머지 원문은 그대로 둔다. 저장할 때마다 파일 잠금 → 조회 → 백업 기록 → 저장 직전 재조회(다르면 "다른 곳에서 바뀌었습니다" 409) → `edit/filter`(script_data 만 변경) → 재조회 확인 순서로 처리한다. mailcow 필터 화면에서 동시에 저장하는 경우까지 막아 주지는 않는다.

**백업**: `/home/mailcow-toolkit/data/filter-backups/YYYY-MM.jsonl` (컨테이너 안 `/data/filter-backups/`, 디렉터리 0700·파일 0600). 변경마다 `{id, ts, mailbox, filter_id, action, address, before, after}` 한 줄을 mailcow 호출 **전에** 기록하고, 시도가 끝나면 `{id, result: "saved"|"conflict"|"error", ts}` 한 줄을 이어 쓴다. 필터를 되돌릴 때는 해당 줄의 `before` 를 그 메일함 필터의 스크립트로 복원한다.

**기존 설치에 마운트 추가** (메일 서비스는 건드리지 않는다. 전체 `update.sh` 와 별개):

```bash
sudo <스택 레포>/scripts/apply-toolkit-data-mount.sh   # 멱등: 디렉터리 생성 + override 에 마운트가 없을 때만 한 줄 추가(.bak 백업)
cd /home/mailcow-dockerized && docker compose up -d --build toolkit-mailcow
```

신규 설치는 `setup.sh` 가, 전체 업데이트는 `update.sh` 5단계가 같은 일을 한다. Toolkit 디렉터리를 백업본으로 복원(롤백)할 때도 `data/filter-backups` 는 지우거나 덮어쓰지 말고 보존한다(변경 전 필터 원문의 유일한 사본이다).

`config.yml` 의 `toolkit.modules` 에 `groups` 가 있어야 노출된다. 생성 화면의 팀 버튼은 `groups` 모듈이 꺼져 있으면 안내 한 줄로 대체된다.

### 4.3 공유 권한 (shares 모듈)

다른 메일박스의 **받은편지함(INBOX) 하나**를 읽기 전용(`lookup` `read`)으로 공유한다.
Toolkit → "공유 권한" 에서 주인 메일박스를 고르고, 공유받을 사람을 선택해 [공유] / [회수].
권한 처리는 mailcow dockerapi 의 `doveadm acl` 로 수행하며, 부여·회수 직후 `get_acl` 로 다시 읽어
반영되지 않았으면 화면에 빨간 알림을 띄운다. 권한(`lookup` `read`)·폴더(INBOX)는 코드 고정이다.

`config.yml` 의 `toolkit.modules` 에 `shares` 가 있어야 노출된다.

#### 공유 폴더 첫 열기 지연 제거 (`apply-dovecot-shared-index.sh`)

mailcow 기본 설정은 공유 namespace 의 INDEX 를 주인 메일함 안(`~/Maildir/Shared/%%u`)에 따로 만들어,
공유받은 폴더를 처음 열 때 인덱스를 처음부터 다시 만들어 오래 걸린다. 이 스크립트는 공유 namespace 의
INDEX 를 주인 본인 INDEX 와 같은 위치(`/var/vmail_index/%%u`)로 옮긴다.

```bash
sudo scripts/apply-dovecot-shared-index.sh            # 적용 (바뀐 게 있을 때만 반영, 아래 참고)
sudo scripts/apply-dovecot-shared-index.sh --check    # 적용 여부만 확인 (공유 INDEX·캐시 설정 모두 적용됨=0, 아니면 1)
sudo scripts/apply-dovecot-shared-index.sh --revert   # mailcow 원본 설정으로 복구 (공유 INDEX + 캐시 설정 블록)
```

- `MAILCOW_DIR` 환경변수로 mailcow 경로 지정 (기본 `/home/mailcow-dockerized`).
- `data/conf/dovecot/shared_namespace_hc.conf` 를 만들고 `dovecot.conf` 의 include 한 줄을 교체한다.
  변경 전 `dovecot.conf.bak-shared-index-<날짜시각>` 로 백업.
- 공유 namespace 설정이 바뀌면 `dovecot-mailcow` 를 재시작한다. 캐시 설정(아래)만 바뀌면 컨테이너 재시작 없이
  `doveadm reload` 로 설정을 다시 적용한다(활성 IMAP/POP 세션은 재접속).
- `setup.sh` 는 설치 시, `update.sh` 는 Phase 4 에서 자동으로 `apply` 를 호출한다
  (mailcow 업데이트가 `dovecot.conf` 를 덮어쓴 경우 재적용).

#### 정렬 캐시 보존 (`mail_cache_unaccessed_field_drop`)

Dovecot(2.3.11+)은 캐시 정리(purge) 때 `mail_cache_unaccessed_field_drop` 기간(기본 `30 days`) 동안 접근 없는 캐시 필드를
`YES`→`TEMP` 로 내리고, 그 기간의 2배가 지나면 제거한다. 제거된 필드(날짜 정렬 등에 쓰는 정보)는 다음에 필요할 때 다시 만들어야
해서 오래 안 연 폴더의 첫 열기가 느려질 수 있다. 같은 스크립트가 mailcow 영구 설정 파일
`data/conf/dovecot/extra.conf`(mailcow 업데이트로 덮이지 않음)에 관리 블록을 넣어 이 값을 `3650 days` 로 올린다(전역, 모든 메일함).
이 값은 사실상 보존(약 10년 뒤 `TEMP`, 20년 뒤 제거)이지 "영구"나 "절대 삭제 안 함"이 아니다. 이미 사라진 캐시를 되살리지는 않는다.

```
# BEGIN mailcow-npmplus-stack (apply-dovecot-shared-index.sh)
mail_cache_unaccessed_field_drop = 3650 days
# END mailcow-npmplus-stack
```

- 블록 밖의 기존 `extra.conf` 내용은 수정하지 않는다. 파일이 있으면 변경 전 `extra.conf.bak-shared-index-<날짜시각>` 로 백업.
- 블록 밖에 같은 키가 이미 있거나 BEGIN/END 표식이 불완전·중복이면 **아무것도 바꾸지 않고** 오류로 종료한다(출력된 문제를 직접 정리 후 재실행).
- 적용 후 `doveconf -h mail_cache_unaccessed_field_drop` 로 `3650 days` 를 확인한다.
- `--revert` 는 `extra.conf` 의 관리 블록 제거(`30 days` 로 돌아왔는지 확인)와 함께 **공유 namespace include 도 mailcow 원래대로 되돌린다.**
- 캐시 설정만 빼려면 `--revert` 를 쓰지 말고 `extra.conf` 의 관리 블록만 지운 뒤 `docker compose exec -T dovecot-mailcow doveadm reload` 를 실행한다(공유 INDEX 설정은 유지).
- `doveadm reload` 가 실패하거나 중단된 뒤에는 파일이 이미 같아서 `apply` 를 다시 실행해도 reload 를 다시 하지 않는다.
  그 경우 `docker compose exec -T dovecot-mailcow doveadm reload`(또는 dovecot 재시작)를 직접 실행한다.

### 4.4 Gmail 필터 변환 도구 (`tools/gmail-filter-to-sieve.html`)

Gmail 설정 → 필터에서 내보낸 `mailFilters.xml` 을 웹메일(SnappyMail)에 붙여 넣을 Sieve 스크립트로 바꾸는 단일 HTML 파일이다. 서버에 설치하는 것이 아니라 **이 파일 하나를 직원에게 전달**하면 된다. 더블클릭으로 열어 XML 을 끌어다 놓으면 브라우저 안에서만 변환하고(외부 요청·업로드 없음), 필터별 변환 결과·경고, 만들어질 폴더, 생성된 스크립트(복사 버튼)가 한 화면에 나온다. 사용자는 웹메일 설정 → 필터 → `Add a Script` 에 붙여 넣고 목록에서 새 스크립트를 켠다(한 번에 하나만 켜지므로 기존 스크립트나 웹메일 필터 화면에서 만든 필터는 꺼진다 — 붙여 넣기 전에 기존 스크립트를 복사해 두면 되돌릴 수 있다). 자세한 단계와 주의사항은 화면 아래 안내에 있다.

- 소스는 `tools/gmail2sieve/`(`core.js` 변환 엔진, `app.html` 화면). 산출물은 `node tools/gmail2sieve/build.js` 로 다시 만들고, `--check` 로 커밋본이 최신인지 확인한다.
- 테스트: `node tools/gmail2sieve/core.test.js`, `node tools/gmail2sieve/app.test.js`.

---

---

## 5. NPM Proxy Host 설정

Mailcow를 먼저 기동한 후 NPMplus를 올리고, NPM 관리 UI에서 설정.

### 5.1 초기 계정

`docker-compose.yml`의 `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` 환경변수로
첫 기동 시 관리자 계정이 자동 생성된다. `setup.sh`는 이 방식을 사용하므로 수동 생성 불필요.

> 로그인 시 토큰은 response body가 아닌 **쿠키 `access_token`**으로 전달된다.

### 5.2 Proxy Host 구성

| 설정 | 기본값 | 동작 |
|---|---|---|
| `ADMIN_ACCESS_LIST` | 빈 값 | NPM에 있는 IP 접근 목록 이름. `mailcow.DOMAIN`·`mail-npm.DOMAIN`에만 적용 |

NPM에서 인증 사용자 없이 IP `allow` 항목이 하나 이상 있는 목록을 먼저 만들고, 서버 `.env`에 `ADMIN_ACCESS_LIST=admin-ips`를 적으세요. setup은 관리 호스트 생성 전에, update는 변경을 시작하기 전에 목록을 검증하며 실패하면 중단합니다. 비우면 setup·update의 관리 목록 사전 점검·적용 경로는 NPM 요청을 하지 않고, 새 설치는 공개입니다. update 마지막의 verify는 별도로 읽기 조회를 하며 공개 관리 화면을 WARN으로 알려 줍니다. 같은 목록은 변경하지 않고, 공개 호스트에는 접근 필드만 적용하며, 다른 접근 제한은 경고하고 보존합니다. update는 없는 호스트를 만들지 않습니다.

NPMplus 기본 신뢰 범위에 포함된 사설 IP 클라이언트가 스택에 직접 연결하면 X-Forwarded-For로 허용 IP를 사칭할 수 있습니다. 사내 적용 전 내부 직접 접근 경로를 확인하세요.

관리 IP 밖에서는 mailcow 사용자 화면과 Toolkit도 막힙니다. 웹메일의 암호 변경 대행은 내부 `nginx-mailcow:8443`을 사용하므로 이 제한의 영향을 받지 않습니다. 접근 거절은 403이며 인증 사용자 목록은 거부하므로 기본 인증 창을 추가하지 않습니다.

자기 IP를 빠뜨리면 NPM 관리 화면에도 들어갈 수 없으므로, 적용 전에 허용 IP를 확인하고 [잠김 복구 절차](#관리-화면-접근-제한-뒤-403)를 준비하세요.

**되돌리기:** 키를 지워도 이미 붙은 목록은 자동으로 떼지 않습니다. NPM 화면에서 두 호스트를 공개로 바꾸거나, 적용 전 `/root/mailcow-admin-access-backup-<날짜시각>-<고유값>/hosts-before.json`에 저장된 접근 목록 값으로 되돌리세요. 백업은 디렉터리 700·파일 600으로 저장합니다. 다른 호스트·전달 설정은 변경하지 마세요. verify는 읽기 전용으로 검사하며 키가 비었을 때 공개 호스트는 WARN, 호스트가 없으면 SKIP입니다.

#### mail.DOMAIN → Snappymail

| 항목 | 값 |
|------|-----|
| Forward Scheme | `http` |
| Forward Host | `snappymail` |
| Forward Port | `8888` |
| SSL Certificate | Let's Encrypt (신규 발급) |
| Force SSL | Yes |
| Advanced Config | (없음) |

#### mailcow.DOMAIN → Mailcow Admin + Toolkit

| 항목 | 값 |
|------|-----|
| Forward Scheme | `https` |
| Forward Host | `nginx-mailcow` |
| Forward Port | `8443` |
| SSL Certificate | Let's Encrypt (신규 발급) |
| Force SSL | Yes |

> Toolkit은 NPM이 아닌 Mailcow 내부 nginx에서 프록시한다 (`site.toolkit.custom`).
> `setup.sh`가 자동으로 설치하므로 NPM Advanced Config에 추가할 필요 없음.

#### mail-npm.DOMAIN → NPM Dashboard

| 항목 | 값 |
|------|-----|
| Forward Scheme | `https` |
| Forward Host | `127.0.0.1` |
| Forward Port | `81` |
| SSL Certificate | Let's Encrypt (신규 발급) |
| Force SSL | Yes |

### 5.3 ACME Challenge 주의사항

NPMplus는 **모든 proxy host에 `/.well-known/acme-challenge/` location을 자동 생성**한다.
Advanced Config에 같은 location을 수동으로 추가하면 `duplicate location` 에러가 발생한다.

→ acme-mailcow로의 챌린지 프록시는 **불가능**. 그래서 인증서는 NPM이 담당하고,
볼륨 공유 + 심볼릭으로 Mailcow에 전달하는 방식을 사용한다.

---

## 6. 작업 순서 (신규 구축)

```
1. Mailcow 설치 + mailcow.conf 패치
   └── HTTP_PORT=8080, HTTPS_PORT=8443, *_BIND=127.0.0.1
   └── docker compose up -d → 네트워크 생성됨

2. docker-compose.override.yml 설치
   └── npmplus-data 볼륨 공유, acme 비활성화, toolkit 추가

3. NPMplus + CrowdSec 설치
   └── INITIAL_ADMIN_EMAIL/PASSWORD로 관리자 자동 생성

4. Snappymail 설치 + 도메인 설정 자동화
   └── mailcow-network 참여, IMAP/SMTP 도메인 설정 자동 적용

5. NPM Proxy Host 생성 + SSL 인증서 발급
   └── mail.DOMAIN, mailcow.DOMAIN, mail-npm.DOMAIN

6. SSL 심볼릭 링크 생성
   └── mail.DOMAIN 인증서의 cert ID 확인 후 symlink

7. 인증서 리로드 크론 설치 + 검증
```

> `setup.sh`가 위 순서를 자동으로 수행한다. 수동 구축 시 참고.

### 기존 Mailcow에 추가 구축 시

```
1. Mailcow 중지 (80/443 포트 해제)
2. mailcow.conf + override 수정
3. NPMplus + CrowdSec 설치 → 80/443 점유
4. Mailcow 재기동 (내부 포트)
5. NPM에서 인증서 발급 + Proxy Host 생성
6. SSL 심볼릭 링크 생성
7. 검증
```

---

## 7. 인증서 갱신 후 서비스 리로드

NPM이 인증서를 자동 갱신하지만, Mailcow의 dovecot/postfix는 갱신된 인증서를
자동으로 리로드하지 않는다. 서버 크론으로 주기적 리로드 필요:

```bash
# /etc/cron.d/mailcow-cert-reload (또는 서버 crontab)
0 4 * * * root /usr/local/sbin/mailcow-cert-reload
```

> 매일 04:00에 postfix/dovecot 리로드. 인증서가 변경되지 않아도 리로드는 무해함.

setup·update는 cron이 없으면 설치하고, 스택의 옛 두 줄과 정확히 같으면 `.bak.<날짜시각>`으로 백업 후 교체합니다. 다른 사용자 내용은 보존하고 경고합니다. reload 도구는 실행 시 compose 서비스 라벨로 대상을 각각 하나씩 찾으며, 실패와 성공을 `logger -t mailcow-cert-reload`로 기록합니다. update는 로컬 993·465 중 하나라도 `cert.pem`과 만료일이 다른 것으로 확인되면 레포의 reload 도구를 한 번 자동 실행합니다(IMAP·POP 연결이 한 번 끊깁니다). 확인 불가인 포트는 경고하며, 불일치가 확인되지 않으면 자동 실행하지 않습니다. 그 밖에는 매일 04:00 cron으로 리로드합니다. verify는 대상의 개수와 로컬 993·465 인증서의 만료일이 `cert.pem`과 같은지 확인합니다.
> nginx-mailcow은 심볼릭을 통해 매 요청 시 읽으므로 별도 리로드 불필요.

### 7.1 옛 호스트별 SNI 인증서 정리

자동 정리는 CA가 발급한 일반 인증서를 전제로 하며, DNS 값 안에 구분자를 흉내 낸 비정상 인증서는 구별하지 못합니다.

`data/assets/ssl/<호스트>/`에 `domains`·`cert.pem`·`key.pem`이 모두 남아 있으면 Dovecot이 시작할 때 그 인증서를 SNI 설정에 넣습니다. 기본 `cert.pem`을 NPM 인증서로 바꾸거나 reload만 해서는 이 경로가 바뀌지 않아, update마다 reload가 반복될 수 있습니다. verify는 기본 인증서와 만료일이 다른 디렉터리를 FAIL로 표시합니다. update는 해당 디렉터리의 `domains` 이름이 모두 기본 NPM 인증서의 DNS SAN에 포함되면 자동 정리합니다. 대소문자를 무시한 정확 일치와 맨 왼쪽 라벨 전체의 와일드카드(예: `*.example.com`은 `mail.example.com`만, `a.b.example.com`·`example.com`은 제외)를 지원합니다. 부분 와일드카드·IP SAN은 인정하지 않습니다. 조건을 충족하지 못하거나 검사할 수 없는 디렉터리는 이유를 경고하고 보존합니다. 파일이 미완비인 디렉터리는 INFO로 표시하며 검사에서 제외합니다.

자동 정리는 디렉터리를 SSL 디렉터리 밖 `/root/mailcow-sni-backup-<날짜시각>-<임의값>/`(700)로 이동하고 Dovecot·Postfix를 한 번에 재시작합니다. Dovecot master를 최대 60초 기다린 뒤, 남은 옛 디렉터리가 원래 보존하기로 한 목록과 같은지 재검사합니다. 실패하면 이동한 디렉터리를 모두 원위치하고 두 서비스를 다시 재시작하며 경고합니다. update는 계속 진행하고 verify가 남은 문제를 표시합니다. 정리 뒤 기존 993·465 대조를 하므로 이미 일치하면 추가 reload를 하지 않습니다. 이동 경로·백업·재시작 시각은 update 로그와 `mailcow-cert-reload` 시스템 로그에 남습니다.

자동 정리 조건을 충족하지 못한 경우, 검사에 표시된 디렉터리가 NPM 인증서로 대체할 옛 설정인지 확인한 뒤, 해당 디렉터리만 SSL 디렉터리 **밖으로** 백업 이동하고 두 서비스를 재시작합니다. 재시작 중 메일 연결이 끊길 수 있습니다. 백업에는 개인키가 있으므로 아래처럼 접근 권한이 제한된 위치를 사용합니다.

```bash
cd /home/mailcow-dockerized
SNI_DIR=mail.example.com  # verify에 표시된 디렉터리 이름으로 변경
backup_dir=$(mktemp -d /root/mailcow-sni-backup.XXXXXX)
mv -- "data/assets/ssl/$SNI_DIR" "$backup_dir/"
docker compose restart dovecot-mailcow postfix-mailcow

# mailcow.conf의 MAILCOW_HOSTNAME을 사용해 두 포트를 확인
source ./mailcow.conf
openssl s_client -connect 127.0.0.1:993 -servername "$MAILCOW_HOSTNAME" </dev/null 2>/dev/null | openssl x509 -noout -enddate
openssl s_client -connect 127.0.0.1:465 -servername "$MAILCOW_HOSTNAME" </dev/null 2>/dev/null | openssl x509 -noout -enddate
docker compose exec -T dovecot-mailcow openssl x509 -in /etc/ssl/mail/cert.pem -noout -enddate
```

세 만료일이 같은지 확인하고 스택의 `scripts/verify.sh`를 다시 실행합니다. 되돌려야 하면 백업한 디렉터리를 원래 위치로 옮기고 같은 두 서비스를 재시작합니다. `domains`에 여러 이름이 있으면 해당 이름들의 SNI 응답도 각각 확인합니다. 자동 정리 백업도 되돌릴 때에는 로그에 표시된 백업의 해당 디렉터리를 `data/assets/ssl/`로 `mv`한 뒤 두 서비스를 재시작합니다. 원래 위치에 같은 이름이 이미 있으면 덮어쓰지 말고 먼저 확인하세요. 인증서 파일은 삭제하지 않습니다.

---

## 8. 트러블슈팅

### 관리 화면 접근 제한 뒤 403

자기 IP가 목록에 없으면 SSH로 `ssh -L 8181:127.0.0.1:81 <서버>`를 실행한 뒤 브라우저에서 `https://127.0.0.1:8181`에 로그인해 목록에 자기 IP를 추가하세요. 키를 지우는 것만으로 제한이 풀리지는 않습니다. 해제하려면 NPM 화면에서 두 관리 호스트를 공개로 바꾸거나 [5.2의 백업 절차](#52-proxy-host-구성)로 접근 목록 값만 되돌리세요.

### unbound-mailcow unhealthy

Docker 재시작/업데이트 후 `mailcow-network`의 iptables MASQUERADE 규칙이
누락되면 unbound가 외부 DNS를 resolve하지 못해 unhealthy 상태가 된다.

```bash
# 확인
docker exec mailcowdockerized-unbound-mailcow-1 ping -c1 1.1.1.1

# 해결: Docker 데몬 재시작 (iptables 규칙 재생성)
systemctl restart docker
# 모든 컨테이너가 restart: always이므로 자동 복구됨
```

### Mailcow update.sh 인증서 경고

```
cp: not writing through dangling symlink 'data/assets/ssl/cert.pem'
```

무시 가능. 업데이트 스크립트가 인증서를 복사하려 하지만 dangling symlink라
실패한다. 심볼릭 자체는 유지되고 컨테이너 안에서 정상 resolve됨.

### NPM proxy host 생성 시 duplicate location

NPMplus가 `/.well-known/acme-challenge/`를 자동 생성하므로 Advanced Config에
같은 location을 넣으면 에러. **Advanced Config에 ACME challenge location을 넣지 말 것.**

### NPM proxy host가 conf를 생성하지 않음

DB의 `meta` 컬럼에 `nginx_online: false`가 캐싱되면 conf가 생성되지 않는다.
해당 host를 API로 삭제 후 재생성하면 해결:

```bash
curl -skL -b cookies -X DELETE http://127.0.0.1:81/api/nginx/proxy-hosts/{ID}
curl -skL -b cookies -X POST http://127.0.0.1:81/api/nginx/proxy-hosts \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

### Snappymail AUTHENTICATIONFAILED

Snappymail에서 메일 계정 로그인 시 `AUTHENTICATIONFAILED Authentication failed` 에러.

**확인 순서:**

1. **shortLogin 확인**: 도메인 설정 JSON에서 IMAP/SMTP/Sieve 모두 `"shortLogin": false`인지 확인.
   `true`이면 `@domain`을 제거하여 dovecot lua passdb가 도메인을 인식하지 못함.

2. **security_level 확인**: `"security_level": 0`인지 확인. self-signed 인증서 환경에서
   `1` 이상이면 SSL 연결 실패.

3. **파일 소유자 확인**: 도메인 설정 파일이 `www-data:www-data` 소유인지 확인.
   ```bash
   docker exec snappymail ls -la /var/lib/snappymail/_data_/_default_/domains/
   ```

4. **IMAP 직접 테스트**: Snappymail 컨테이너에서 직접 IMAP 로그인 시도.
   ```bash
   docker exec snappymail php -r "
   \$ctx = stream_context_create(['ssl' => ['verify_peer'=>false,'allow_self_signed'=>true,'security_level'=>0]]);
   \$fp = stream_socket_client('ssl://dovecot-mailcow:993', \$e, \$es, 10, STREAM_CLIENT_CONNECT, \$ctx);
   echo fgets(\$fp);
   fwrite(\$fp, \"A1 LOGIN user@domain password\r\n\");
   echo fgets(\$fp);
   "
   ```

5. **dovecot 로그 확인**: `docker logs mailcowdockerized-dovecot-mailcow-1 --tail 20 2>&1 | grep auth`
   - `HTTP request failed with 400`: `doveadm auth test`에서는 정상 (real_rip 미제공)
   - 실제 IMAP 연결에서도 400이면 `mailcow.conf`의 `API_KEY` 설정 확인

### 메일 발송 후 수신 서버에서 거부 (554 5.7.1)

DNS 미설정 시 수신 서버의 rspamd 스코어가 임계값을 초과하여 거부된다.

| 항목 | 감점 | 해결 |
|------|------|------|
| PTR(rDNS) 미설정 | ~10.5 | ISP에 PTR 설정 요청 |
| MX 레코드 없음 | ~4.0 | MX 레코드 추가 |
| A 레코드 없음 (HELO 호스트) | ~1.3 | mail.DOMAIN A 레코드 추가 |
| DKIM 서명 실패 | ~0.0-1.0 | DKIM DNS 레코드 추가 |

SPF만으로는 감점 상쇄가 불충분. 최소 **MX + A + PTR** 설정이 필요하다.

### firewalld + Docker iptables 충돌

firewalld가 active인 서버에서 Docker 네트워크가 추가/재생성될 때
MASQUERADE 규칙이 누락될 수 있다. Docker 데몬 재시작으로 해결.

---

## 9. 검증 체크리스트

> `scripts/verify.sh`가 아래 항목을 자동으로 확인합니다.

### 웹 서비스

- [ ] `https://mail.DOMAIN` → Snappymail 로그인 페이지 (200)
- [ ] `https://mail.DOMAIN/?admin` → Snappymail 관리자
- [ ] `https://mailcow.DOMAIN` → Mailcow 관리 UI (200)
- [ ] `https://mailcow.DOMAIN/toolkit/` → Toolkit (200)
- [ ] `https://mail-npm.DOMAIN` → NPM 대시보드 (200)

### 메일 프로토콜

- [ ] IMAP (993 SSL) 로그인 정상
- [ ] SMTP (465 SSL) 발송 정상
- [ ] 외부 발송/수신 테스트

### 보안

- [ ] `curl http://SERVER_IP:8080` → Connection refused (외부 차단)
- [ ] `curl http://SERVER_IP:8443` → Connection refused (외부 차단)
- [ ] CrowdSec WAF: `scripts/verify.sh`의 바운서·AppSec·로그 파싱·모드별 요청 검사 확인
- [ ] SSL 인증서 유효성 (웹 + 메일 프로토콜)

### 인증서

- [ ] NPM에서 3개 도메인 인증서 발급 확인
- [ ] Mailcow SSL 심볼릭 resolve 확인: `docker exec nginx-mailcow ls -la /npm-data/tls/certbot/live/`
- [ ] `openssl s_client -connect mail.DOMAIN:993` → 유효한 인증서
- [ ] `openssl s_client -connect mail.DOMAIN:465` → 유효한 인증서


## 10. 웹메일

메일스택 웹메일은 `/home/webmail`에 설치되는 별도 컨테이너입니다. 개인 메일 자격으로 IMAP·SMTP·ManageSieve를 사용하며, 주소록·보낼 주소·사내 도메인은 열 단위 SELECT만 허용한 `webmail_ro` 계정으로 읽습니다. 세션은 메모리에 있으므로 웹메일 재시작·업데이트 후에는 사용자 전원이 다시 로그인해야 합니다.

### 전용 망과 TCP 중계

```text
인터넷 → NPMplus (.2)
           ├─ mailstack-webmail-edge → 웹메일 (자동 주소)
           │                           └→ mailrelay-webmail (.3)
           │                              → mailcow: IMAPS 993, Sieve 4190,
           │                                SMTP 587, MySQL 3306, HTTPS 8443
           └─ mailstack-snappymail-edge → SnappyMail (자동 주소)
                                       └→ mailrelay-snappymail (.3)
                                          → mailcow: IMAPS 993, Sieve 4190, SMTP 465
```

`.2`·`.3`은 각 전용 서브넷 시작 주소에서의 오프셋입니다. 전용 망은 `internal: true`, IPv6 끔, isolated bridge이며 Docker 서버 28 이상이 필요합니다. 앱은 자기 전용 망에만 붙고, mailcow 망에는 앱별 중계만 붙습니다. 중계는 전용 망 주소에서 정해진 TCP 포트만 받으며 호스트 포트를 열지 않습니다. NPMplus의 기존 mailcow 망 연결은 유지합니다.

중계는 공식 HAProxy 3.4.7 Alpine을 태그·다이제스트로 고정하며 비루트·읽기 전용·capability 제거로 실행합니다. 중계 백엔드는 mailcow 망 전용 별칭 `dovecot`, `postfix`, `mysql`, `nginx`를 Docker DNS로 다시 해석합니다. 전용 망에서는 기존 전체 서비스명 별칭을 제공하므로 웹메일 연결 대상·TLS 검증 이름은 바뀌지 않습니다.

### 선택값과 주소

| WEBMAIL_ENABLE | SNAPPYMAIL_ENABLE | 설치·업데이트 대상 | mail.DOMAIN 연결 |
|---|---|---|---|
| false | true | SnappyMail(기존 기본값) | snappymail:8888 |
| true | true | 둘 다 | snappymail:8888 |
| true | false | 웹메일 | webmail:8080 |
| false | false | 둘 다 생략 | 새 프록시 생성 안 함 |

`.env.example`의 새 설정값을 스택 `.env`에 넣습니다. 레포 기본값은 `WEBMAIL_ENABLE=false`, `SNAPPYMAIL_ENABLE=true`, `MAIL_AUTOEXPUNGE_ENABLE=false`이며 대체 후에도 유지합니다. 선택값 키가 없는 기존 서버에서는 새 기능을 실행하지 않습니다. setup·update는 선택값을 쓰거나 바꾸지 않으며, 켜진 기능에 필요한 비밀값이 비어 있을 때만 생성하고 기존 비밀값은 보존합니다. setup/update에서 앱을 끄면 그 앱의 망·중계·설정을 새로 만들지 않고 NPMplus override에서도 제외합니다. 이미 있던 앱 컨테이너·데이터·전용 망·중계는 자동 제거하지 않으며 남은 자원은 경고합니다. 제거는 아래 명시적 절차를 따릅니다.

| 설정 | 기본값·뜻 |
|---|---|
| `WEBMAIL_HOSTNAMES` | 빈 값이면 `newmail.${DOMAIN}`. 쉼표 목록의 첫 주소가 대표 주소 |
| `WEBMAIL_ACCESS_LIST` | 빈 값이면 공개. NPM 접근 목록 이름. IP 항목만 허용하며 인증 사용자가 든 목록·없는 목록이면 프록시 생성을 건너뜀 |
| `WEBMAIL_BRAND_NAME`, `WEBMAIL_ORG_NAME`, `WEBMAIL_BRAND_MARK` | `메일`, 빈 값, 빈 값. 로고 글자는 1~2글자 |
| `WEBMAIL_DEFAULT_THEME`, `WEBMAIL_DEFAULT_MODE` | `ink`, `system`. 테마 ink/seland/terra/amber/olive, 모드 system/light/dark |
| `WEBMAIL_INTERNAL_DOMAINS` | 빈 값이면 활성 메일 도메인·별칭 도메인 자동 조회 |
| `WEBMAIL_ALLMAIL_EXCLUDE` | 전체편지함에서 더 뺄 폴더 이름의 쉼표 목록 |
| `WEBMAIL_ATTACH_MAX_MB` | `25`. 프록시 본문 한도는 이 값 + 5MiB |
| `WEBMAIL_SESSION_IDLE_MIN`, `WEBMAIL_SESSION_MAX_HOURS` | `480`분 유휴, `24`시간 최대 세션 |
| `WEBMAIL_RELAY_IPV4` | 빈 값이면 `<IPV4_NETWORK>.240`. 웹메일 중계의 mailcow 쪽 고정 출발 주소 |
| `SNAPPYMAIL_RELAY_IPV4` | 빈 값이면 `<IPV4_NETWORK>.239`. SnappyMail 중계의 고정 출발 주소 |
| `WEBMAIL_EDGE_SUBNET` | `172.22.10.0/24`. 웹메일 전용 RFC1918 서브넷, /24~/29 |
| `SNAPPYMAIL_EDGE_SUBNET` | `172.22.11.0/24`. SnappyMail 전용 RFC1918 서브넷, /24~/29 |
| `WEBMAIL_IPV4` | 폐기. `.env`에 남아 있으면 경고만 하며 값을 바꾸지 않음 |
| `WEBMAIL_TRUSTED_PROXIES` | 추가 신뢰 프록시 IP/CIDR 쉼표 목록. 기본 신뢰는 NPMplus의 웹메일 전용 망 주소 하나(`/32`) |
| `WEBMAIL_MAIL_TLS_MODE` | `verify` 또는 `pin`. 검증을 끄는 모드는 없음 |
| `WEBMAIL_DB_PASSWORD` | 비면 32자 무작위 생성 후 스택 `.env`에 저장. 출력·로그 금지 |

웹메일만 켜면 `mail.${DOMAIN}`을 생성 환경의 로그인 허용 주소에도 자동 추가하고 중복을 제거합니다. SnappyMail이 켜져 있을 때 `mail.${DOMAIN}`, 그리고 항상 `mailcow.${DOMAIN}`·`mail-npm.${DOMAIN}`은 명시 웹메일 주소로 사용할 수 없습니다. `DOMAIN` 자체는 사용할 수 있습니다. 기존 프록시 호스트는 덮어쓰지 않으며 다른 대상으로 연결돼 있으면 경고 후 건너뜁니다. 변경은 별도 주소 전환 절차로 진행합니다.

### 설치·업데이트·TLS

새 설치는 `.env` 설정 후 `sudo ./scripts/setup.sh`를 실행합니다. 기존 서버는 사용자 공지·설정/데이터 백업 후 `sudo ./scripts/update.sh -y --skip-mailcow-update`로 스택만 전환할 수 있습니다. 웹메일 주소의 DNS A 레코드는 서버를 가리켜야 합니다.

두 명령은 ① Docker 판·다른 Docker 망/호스트 경로와의 겹침 검사 및 앱 설정 생성 → ② 앱 프로젝트 전환 → ③ NPMplus 전용 망 연결 → ④ Dovecot·DB·Postfix 신뢰 변경 → ⑤ verify 순서로 처리합니다. 옛 mailcow 망에 붙은 앱만 처음 한 번 `compose down` 후 올라옵니다(볼륨 보존). 이미 전용 망 구조이면 내리지 않으며, 같은 생성 파일은 다시 쓰지 않습니다. 1~4단계 실패 시 중단하고 바뀐 단계와 재시도 안내를 출력하며, 5단계 verify 실패는 경고합니다.

처음 전환할 때 웹메일·SnappyMail 재로그인이 필요하고, NPMplus 재생성과 Postfix 재시작으로 웹·SMTP가 각각 몇 초 끊길 수 있습니다. 반복 실행에서는 변경이 없는 앱·중계·NPMplus를 재생성하지 않고 Postfix 재시작·Dovecot reload도 하지 않습니다. 웹메일 DB 계정의 암호·권한은 매번 다시 맞춥니다(값이 같으면 결과는 그대로). 다만 기존 NPMplus DNS 캐시 초기화 재시작과 Toolkit의 php/nginx 재시작은 계속 실행됩니다. 프로그램·이미지·인증서가 실제로 바뀌면 해당 서비스는 다시 뜹니다.
로컬 이미지 빌드의 기본 attestation을 끄는 변경을 처음 반영하면 이미지 ID가 한 번 바뀌어 웹메일·Toolkit 컨테이너가 1회 재생성될 수 있습니다.

SnappyMail 런타임 compose가 옛 레포 구조이면 원본을 `docker-compose.yml.bak.<날짜>.*`로 백업하고 중계 구조로 바꿉니다. 운영자가 고정한 SnappyMail 이미지 값은 유지합니다. 다른 구조를 직접 편집한 파일이면 차이의 줄 범위를 출력하고 중단하므로 레포 구조에 맞춘 뒤 다시 실행합니다.

추가 주소 프록시는 `bash scripts/webmail-cutover.sh add-host`로 생성합니다. 선택한 주소만 추가하려면 뒤에 호스트 이름을 지정합니다. 기존 호스트는 변경하지 않으며, 접근 목록이 없거나 인증 사용자를 포함하면 공개로 생성하지 않고 건너뜁니다. 시험 주소의 upstream은 `http://webmail:8080`, HTTP/2 켬, 웹소켓·block_exploits 끔, `client_max_body_size`는 첨부 한도 + 5m입니다.

일반 업데이트는 `sudo ./scripts/update.sh -y`입니다. 선택된 서비스만 갱신하고 Dovecot·DB 정책을 다시 적용합니다. 웹메일 환경 파일은 `/home/webmail/webmail.env`(600)이며 관리자 키·DB root 암호는 넣지 않습니다. 이 파일과 스택 `.env`를 출력하거나 저장소에 넣지 마세요.

mailcow 판을 고정해 둔 서버에서는 `sudo ./scripts/update.sh -y --skip-mailcow-update`를 사용하세요. Phase 3의 mailcow 공식 `./update.sh -f` 호출만 건너뛰며, 나머지 스택 소스 갱신·설정 재적용·Toolkit/웹메일 재빌드·서비스 재시작과 Phase 7 검증은 그대로 실행합니다. Phase 1에서도 mailcow 저장소를 git pull하지 않습니다. 이 옵션은 mailcow 릴리스를 유지하는 용도이며 무중단 옵션은 아닙니다. 플래그를 생략하면 기존 동작을 유지합니다. 대화형 Phase 3 확인에서 아니오를 선택하면 기존처럼 전체 작업이 중단되므로, mailcow만 건너뛰려면 이 플래그로 실행하세요.

TLS 이름은 mailcow.conf의 `MAILCOW_HOSTNAME`입니다. 자체서명 메일 서버는 `pin`을 선택합니다. 공개 인증서만 실제 IMAP TLS 접속에서 추출하며 개인 키를 읽거나 복사하지 않습니다. 공개 인증서는 `/home/webmail/mail-tls-pin.pem`이고 마운트는 `:ro,z`로 SELinux 공유 문맥을 적용합니다. setup의 Phase 8에서 인증서가 바뀌면 pin을 다시 추출합니다. update도 mailcow 업데이트 뒤 재추출하며 지문이 달라졌을 때 pin 변경에 따른 재기동을 수행합니다. 웹메일 이미지·환경 업데이트 자체에 따른 재기동은 별개입니다.

### 웹메일 고정 주소와 IP 변경

`WEBMAIL_IPV4`는 더 이상 사용하지 않습니다. 중계 IPv4 두 개는 mailcow /24 안에서 서로 달라야 하며 `.0`·`.1`·`.248`~`.255`는 사용할 수 없습니다. 다른 컨테이너가 쓰는 주소인지도 전환 전에 확인하세요. mailcow IPv6가 켜졌다면 두 중계에 mailcow /64의 `::240`·`::239`를 고정합니다. Postfix는 두 중계의 IPv4·IPv6를 `mynetworks` 맨 앞에서 제외하므로 중계 경유 SMTP도 로그인이 필요합니다. Dovecot 사용자 IP 신뢰와 DB 접근은 웹메일 중계 주소에만 허용합니다.

전용 망의 자동 IPAM 범위는 서브넷 위쪽 절반입니다(`/24` 기본값은 `.128/25`, `/29`는 시작 주소 +4부터의 `/30`). NPMplus +2와 중계 +3의 고정 주소를 앱이 먼저 할당받지 않게 합니다. 생성 파일은 기본 `/home/webmail/`·`/home/snappymail/`의 `haproxy.cfg`·`docker-compose.override.yml`, `/home/npmplus/docker-compose.override.yml`입니다. 웹메일 소스 동기화는 이 파일들을 보존합니다. 다른 사람이 만든 override는 덮어쓰지 않습니다.

NPMplus는 앱 이름을 그대로 사용합니다. 수동 재생성으로 앱의 자동 주소가 바뀌어 502가 남으면 기존 update의 NPMplus DNS 초기화 재시작을 확인하세요. 수동 `docker restart npmplus`는 모든 앞단 웹에 영향을 줍니다.

### 검증·되돌리기

`sudo ./scripts/verify.sh`는 선택 서비스의 컨테이너 상태, 주소별 `/healthz`, Dovecot·DB 계정, 비로그인 logout의 403 및 WWW-Authenticate 부재를 확인합니다. 접근 목록이 있는 주소의 외부 HTTP 검사는 건너뜀으로 표시합니다. pin 모드는 저장한 인증서와 현재 메일 서버의 SHA-256 지문도 비교합니다.

verify는 앱 안에서 TCP 열림·막힘, 중계의 백엔드 DNS가 mailcow 망으로만 풀리는지, Dovecot 신뢰·DB 단일 호스트·Postfix 제외를 검사합니다. 웹메일은 Node, SnappyMail은 이미지의 PHP CLI를 쓰며 TCP 연결 제한은 3초입니다. 중계 DNS 검사는 Alpine BusyBox `nslookup`을 사용합니다. 전체 차단 목록·인증 없는 SMTP 발송 거부·실제 로그인/보내기·재부팅 복구는 별도 서버 시험이 필요합니다.

#### 웹메일 끄기

사용자 공지·백업 후 추가 프록시 주소를 `webmail-cutover.sh remove-host <주소>`로 제거하고, 서버 `.env`의 `WEBMAIL_ENABLE=false`를 선택합니다. 데이터 볼륨은 지우지 않습니다. Dovecot 원복은 IMAP/POP 연결을 한 번 끊을 수 있습니다.

```bash
(cd /home/webmail && docker compose down)
source scripts/lib/webmail-env.sh
webmail_load_config "$PWD/.env" /home/mailcow-dockerized
edge_reconcile_npmplus /home/npmplus
bash scripts/apply-dovecot-webmail.sh --revert -y
bash scripts/apply-webmail-dbuser.sh --revert
# 남아 있을 때만 제거. NPMplus 연결이 먼저 빠져야 합니다.
if docker network inspect mailstack-webmail-edge >/dev/null 2>&1; then
  docker network rm mailstack-webmail-edge
fi
rm -f /home/webmail/haproxy.cfg /home/webmail/docker-compose.override.yml
```

DB 원복 명령은 호스트와 상관없이 `webmail_ro` 계정을 모두 제거하며 옛 계정을 다시 만들지 않습니다. Postfix 제외는 SnappyMail을 위해 남깁니다. 전체 데이터를 지우는 `teardown.sh`는 별도 확인 후 실행합니다.

#### 망 분리 전체 되돌리기

운영자가 변경 커밋 ID와 SnappyMail 전환 백업을 확인한 뒤 실행합니다. 아래 변수에는 실제 커밋 ID와 확인한 백업 경로를 넣습니다. 레포의 다른 미커밋 변경이 있으면 먼저 정리하세요. 이 명령은 스크립트가 자동 실행하지 않습니다.

```bash
set -e
source scripts/lib/webmail-env.sh
webmail_load_config "$PWD/.env" /home/mailcow-dockerized
# 검증된 중계 주소를 같은 셸에 보관(암호는 출력하지 않음).
RELAY_TO_DROP="$WEBMAIL_RELAY_IPV4"
bash scripts/apply-postfix-edge.sh --revert -y
# 설치된 앱 프로젝트만 실행. -v는 쓰지 않습니다.
for dir in /home/webmail /home/snappymail; do
  if [ -f "$dir/docker-compose.yml" ]; then (cd "$dir" && docker compose down); fi
done
ROLLBACK_BACKUP="/root/mailstack-edge-rollback-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$ROLLBACK_BACKUP"
for app in webmail snappymail npmplus; do
  file="/home/$app/docker-compose.override.yml"
  if [ -f "$file" ]; then
    grep -qFx '# Generated by scripts/lib/edge.sh' <(head -n1 "$file") || { echo '표식이 다른 override: 수동 검토 필요' >&2; exit 1; }
    cp -p "$file" "$ROLLBACK_BACKUP/$app.override.yml"
    rm "$file"
  fi
done
# 출력된 전환 백업 경로를 찾고, 내용을 검토한 한 파일을 선택합니다.
find /home/snappymail -maxdepth 1 -name 'docker-compose.yml.bak.*' -print
# SNAPPY_COMPOSE_BACKUP에 확인한 전환 백업의 절대 경로를 지정한 뒤:
cp -p "$SNAPPY_COMPOSE_BACKUP" /home/snappymail/docker-compose.yml
# NETSPLIT_N2B_COMMIT/N2A_COMMIT/N1_COMMIT에는 실제 변경 커밋 ID를 지정:
git revert "$NETSPLIT_N2B_COMMIT" "$NETSPLIT_N2A_COMMIT" "$NETSPLIT_N1_COMMIT"
# 서버 .env에서 예전 WEBMAIL_IPV4 값(예: 172.22.1.240)을 확인·복원합니다.
sudo ./scripts/update.sh -y --skip-mailcow-update
source scripts/lib/webmail-env.sh
webmail_load_config "$PWD/.env" /home/mailcow-dockerized
DBROOT_ROLLBACK=$(webmail_mailcow_value DBROOT)
printf "DROP USER IF EXISTS 'webmail_ro'@'%s';\n" "$RELAY_TO_DROP" | \
  (cd /home/mailcow-dockerized && MYSQL_PWD="$DBROOT_ROLLBACK" docker compose exec -T -e MYSQL_PWD mysql-mailcow mysql --user=root)
unset DBROOT_ROLLBACK
# 남아 있는 전용 망만 제거합니다.
for network in mailstack-webmail-edge mailstack-snappymail-edge; do
  if docker network inspect "$network" >/dev/null 2>&1; then docker network rm "$network"; fi
done
```

표식이 다르면 override를 지우지 말고 멈춰 수동 검토합니다. SnappyMail을 설치한 적이 없으면 해당 down·compose 복원은 생략합니다. 전환 백업이 없으면 옛 레포의 SnappyMail compose를 복원하고 운영자 이미지 고정값을 대조해야 합니다. Postfix `extra.cf`는 생성 백업과 대조하세요. 제외만 남아 있어도 인증해서 보내는 메일에는 영향이 없습니다.

2026-09a의 `Global setting mail_plugins won't change ...` 경고는 기본 conf의 IMAP·LMTP 설정(183·188행) 뒤에 `extra.conf`가 포함되어 발생합니다([Dovecot 2.3.21.1 config-parser.c 902~916](https://github.com/dovecot/core/blob/2.3.21.1/src/config/config-parser.c#L902)); 전역 가상 네임스페이스를 프로토콜 필터 없는 도구에서도 열 수 있도록 전역 virtual을 유지하고 IMAP·LMTP에도 명시적으로 추가하므로, 각 프로토콜에 virtual이 한 번씩 있는 현재 설정에서는 무해합니다.

### 스내피에서 웹메일로 바꾸기

아래 도구는 관리자가 직접 실행하며 setup·update는 자동으로 호출하지 않습니다. 각 단계는 운영자 승인과 공지 후 진행합니다. 두 도구는 `.env`를 수정하지 않고 운영자에게 변경할 선택값만 안내합니다.

1. 시범 문제 해결·전체 사용자 필터 이관·시험 서버 리허설 완료를 확인합니다. 전환 시각·주소·필터 메뉴 변경·첫 로그인 안내를 공지합니다. 사용자별 기존 필터 원본은 지우지 않습니다.
2. 전환 전 `WEBMAIL_HOSTNAMES` 값을 운영 기록에 남깁니다. `snappymail-remove.sh backup`으로 데이터 볼륨·compose 파일·NPM 프록시 JSON을 백업하고 파일 크기가 0이면 중단합니다.
3. `webmail-cutover.sh status`로 대상을 확인하고 `switch`로 SnappyMail을 향하는 주소들을 `webmail:8080`으로 바꿉니다. 기존 접근 목록을 유지하고 변경 전 JSON을 보관합니다.
4. 운영자가 먼저 해당 서버 `.env`에서 `SNAPPYMAIL_ENABLE=false`로 바꾼 다음 전환 주소를 `WEBMAIL_HOSTNAMES`에 추가합니다. 대표는 `webmail.${DOMAIN}`, 기존 시험 주소는 유지합니다. 이 순서는 환경 검증과 Origin 허용 주소를 일치시키며 컨테이너·데이터를 삭제하지 않습니다. `webmail.env` 재생성과 `up -d` 후 주소별 healthz·로그인·보내기·verify를 확인합니다.
5. 운영자가 정한 관찰 기간(권장 1주)에는 `bash scripts/snappymail-remove.sh stop`으로 컨테이너만 정지합니다. 컨테이너·볼륨·폴더는 보존합니다. 문제 시 `webmail-cutover.sh revert` → 운영자가 `WEBMAIL_HOSTNAMES`를 전환 전 목록으로 원복하고 `SNAPPYMAIL_ENABLE=true` 선택 → `snappymail-remove.sh start`로 되돌립니다.
6. 관찰 후 `snappymail-remove.sh remove`로 컨테이너를 내립니다. 앱·중계·전용 망·생성 파일·NPM 연결을 정리하며 볼륨·폴더는 보존하고 앞서 운영자가 선택한 `SNAPPYMAIL_ENABLE=false`도 그대로 둡니다. 볼륨·설치 폴더 삭제는 별도 확인 후 진행합니다. 제거 뒤 원복은 선택값을 true로 바꾸고 `update.sh -y --skip-mailcow-update` → `revert` 순서입니다. 볼륨까지 삭제했다면 `restore <백업 tar>`가 먼저입니다.
7. 최종 대체 완료 후에도 레포 기본값은 변경하지 않습니다. 전환할 서버의 `.env`에서만 웹메일 true·SnappyMail false를 선택합니다. 사용자 필터 원복은 기존 스크립트를 `doveadm sieve activate -u <주소> <원래 이름>`으로 다시 활성화합니다.

### 수동 도구 사용법과 백업

백업 위치 기본값은 `/root/webmail-backup-YYYYMMDD`입니다. 한 번의 전환 작업에서는 두 도구에 같은 `WEBMAIL_BACKUP_DIR`를 사용하세요. 다른 날 원복할 때에도 해당 백업 경로를 지정합니다. 기존 백업 파일은 덮어쓰지 않으므로 새 작업에는 새 디렉터리를 선택합니다. 백업 디렉터리 전체를 함께 보관하세요.

```bash
export WEBMAIL_BACKUP_DIR=/root/webmail-backup-20261015
bash scripts/snappymail-remove.sh backup
bash scripts/webmail-cutover.sh status
bash scripts/webmail-cutover.sh switch
# 여기서 운영자가 .env의 SNAPPYMAIL_ENABLE=false 및 주소 목록을 수정
# 웹메일 환경 재생성·up -d와 주소별 검증 후 관찰 시작
bash scripts/snappymail-remove.sh stop
# 관찰을 마친 뒤 앱·중계·전용 망 제거(볼륨·폴더 보존)
bash scripts/snappymail-remove.sh remove
```

| 도구·명령 | 동작 |
|---|---|
| `webmail-cutover.sh status [--json]` | 현재 주소·대상·접근 목록 표시. JSON 옵션은 백업용 전체 응답 |
| `add-host [주소]` | 주소가 없으면 설정된 웹메일 주소들을 생성. 기존 대상은 건너뜀 |
| `remove-host <주소>` | 웹메일을 향하는 프록시 호스트만 삭제. 삭제 전 JSON 보관 |
| `switch` | 정확히 `snappymail`을 향하는 호스트만 변경. 원본 전체 JSON을 `webmail-cutover-before.json`에 먼저 저장 |
| `revert [백업 JSON]` | 백업의 전환 대상만 원복. 바꾼 필드만 PUT하며 포트·원래 고급 설정을 복원 |
| `snappymail-remove.sh backup` | 실제 데이터 볼륨 이름을 찾아 압축 파일·compose·NPM JSON·복구 메타데이터를 저장하고 검증 |
| `stop` / `start` | 관찰 정지 / 생성 파일이 남아 있으면 기동. 없으면 update 안내 |
| `remove` | 완전한 백업 필요. 앱·중계·전용 망·생성 파일·NPM 연결 제거, 데이터·설치 폴더 보존 |
| `restore <압축 파일>` | 삭제된 볼륨을 복원. 생성 설정이 없으면 up 생략 후 update 안내. 기존 볼륨은 덮어쓰지 않음 |

볼륨 삭제가 별도로 승인됐을 때만 `remove --delete-volume`을 사용합니다. 설치 폴더 삭제는 `--delete-install-dir`로 따로 선택하며 두 옵션을 함께 사용할 수도 있습니다. 백업이 설치 폴더 안에 있으면 폴더 삭제를 거부합니다. 생성 파일이 남아 있는 관찰 정지 단계에서는 `start`로 원복합니다. remove 뒤에는 운영자가 `SNAPPYMAIL_ENABLE=true`를 선택하고 `update.sh -y --skip-mailcow-update`로 망·중계를 다시 만듭니다. 데이터가 남아 있다면 그대로 사용하며, 볼륨까지 삭제했다면 먼저 백업 압축 파일을 `restore`한 다음 같은 update 명령으로 생성 설정을 복구하고 주소를 `revert`합니다. backup은 기존 데이터 압축·manifest·compose·NPM JSON 네 파일만 보관하며 생성 설정은 포함하지 않습니다. 설치 폴더만 지웠다면 보관한 compose 파일을 먼저 원래 위치에 복원하세요. 사용자 필터는 별도로 원래 Sieve 스크립트를 활성화합니다.

백업·쿠키·관리자 암호 임시 파일은 비공개 권한으로 다룹니다. NPM 암호를 명령 인자나 로그에 남기지 않습니다. NPM PUT에는 변경할 필드만 보내며 접근 목록·인증서는 전환 중 그대로 보존합니다. 여러 호스트 중 일부 전환이 실패해도 최초 백업을 유지하므로 원인을 확인한 뒤 `revert`할 수 있습니다. 전환 후 다른 관리자가 대상·주소를 바꾼 경우에는 원복을 거부하고 수동 검토를 요구합니다.

## 11. 스팸·휴지통 자동 삭제

`MAIL_AUTOEXPUNGE_ENABLE=false`, `MAIL_AUTOEXPUNGE_DAYS=30`이 기본값입니다. 새 기능은 기본 꺼짐이며 선택값 키가 없는 서버에서는 관련 단계를 건너뜁니다. 웹메일 설치 여부와 무관하게 Dovecot의 실제 `Junk`·`Trash` 폴더에 적용되어 Outlook·휴대폰 등 **모든 메일 프로그램**에 영향을 줍니다. 1~365일만 허용하며 이미 삭제된 메일은 복원되지 않습니다.

**기존 서버는 update만으로 자동 삭제가 켜지지 않습니다.** 적용하려면 사용자에게 시각과 일수를 공지한 뒤 해당 서버 `.env`에 `MAIL_AUTOEXPUNGE_ENABLE=true`를 명시하세요. 보존 기간 축소 전에도 공지해야 합니다. 끄려면 `.env`에서 `MAIL_AUTOEXPUNGE_ENABLE=false`로 바꾸고 `bash scripts/apply-dovecot-autoexpunge.sh --revert -y`를 실행합니다. 이미 삭제된 메일은 돌아오지 않습니다. `apply-dovecot-autoexpunge.sh --check`로 켜진 정책을 확인할 수 있습니다.


## 12. 관리 화면

`WEBMAIL_ADMIN_ENABLE=true`로 켜는 별도 `webmail-admin` 컨테이너입니다. 공개 웹메일과 같은 이미지를 쓰고 mailcow 내부망에서 관리자 로그인·계정·팀·별칭·보내기 권한·필터·동기화·운영 상태·변경 기록·웹메일 로고를 관리합니다. 공개 웹메일은 관리 API를 등록하지 않으며 관리 컨테이너에 연결할 수 없습니다.

mailcow의 전체 관리자(superadmin) 아이디·암호로 로그인합니다. 2단계 인증은 인증 앱의 6자리 TOTP를 지원합니다. 도메인 관리자와 보안 키만 사용하는 계정은 지원하지 않습니다. 암호 변경·2단계 등록 대기 상태이면 mailcow 관리 화면에서 먼저 완료합니다. 암호·mailcow 세션·API 키를 디스크에 저장하지 않으며 재시작하면 관리자는 다시 로그인합니다.

### 설정값과 DNS

| 변수 | 기본값 | 의미 |
|---|---|---|
| `WEBMAIL_ADMIN_ENABLE` | `false` | 관리 기능 선택. `WEBMAIL_ENABLE=true`가 필수 |
| `WEBMAIL_ADMIN_HOSTNAME` | `mailadmin.${DOMAIN}` | 관리 주소 한 개. mail/mailcow/mail-npm 및 공개 웹메일 주소와 중복 불가 |
| `WEBMAIL_ADMIN_SESSION_IDLE_MIN` | `60` | 유휴 만료, 1~180분 |
| `WEBMAIL_ADMIN_SESSION_MAX_HOURS` | `8` | 최대 시간. 유휴 만료보다 짧을 수 없음 |
| `ADMIN_ACCESS_LIST` | 기존 설정 | NPMplus의 IP 허용 목록. 허용 IP가 있어야 하고 HTTP 인증 사용자는 없어야 함. 비면 관리 프록시 생성 안 함 |
| `TOOLKIT_ENABLE` | `true` | Toolkit 설치·갱신. false는 자동 제거를 뜻하지 않음 |

관리 주소의 DNS A 레코드를 서버 IP로 만듭니다. `sudo bash scripts/dns-records.sh`가 주소와 확인 표시를 출력합니다. 인증서는 NPMplus가 발급합니다. 다른 대상으로 향하는 기존 프록시는 덮어쓰지 않고 경고합니다. 관리 프록시는 `http://webmail-admin:8080`, HTTP/2 켬, 웹소켓·block_exploits 끔, 요청 크기 4m입니다.

### 기존 서버에서 켜기

먼저 웹메일 전용 망 분리를 완료하고 변경 시각을 공지합니다. 스택을 검토된 커밋으로 갱신한 뒤 `.env`, `/home/webmail`의 env·override, NPM 프록시 목록 JSON, Redis `APP_LINKS`를 비공개 백업에 보관합니다. 공개 웹메일의 `LOGO_DIR` 변경으로 사용자가 다시 로그인할 수 있습니다.

서버 `.env`에 `WEBMAIL_ENABLE=true`, `WEBMAIL_ADMIN_ENABLE=true`를 설정하고 `ADMIN_ACCESS_LIST`를 확인합니다. 관리 IP가 목록에 포함돼 있어야 합니다. update는 mailcow 갱신도 할 수 있으므로 관리 화면만 켤 때는 다음 개별 명령 순서를 사용합니다. 스택 저장소 루트에서 실행합니다.

```bash
STACK_DIR=$PWD
MAILCOW_DIR=/home/mailcow-dockerized
WEBMAIL_DIR=/home/webmail
sudo mkdir -p "$WEBMAIL_DIR"
sudo rsync -a --delete --exclude=node_modules --exclude=webmail.env \
  --exclude=webmail-admin.env --exclude=mail-tls-pin.pem \
  --exclude=docker-compose.override.yml --exclude=haproxy.cfg \
  "$STACK_DIR/webmail/" "$WEBMAIL_DIR/"
sudo bash -c 'source "$1/scripts/lib/webmail-env.sh"; webmail_prepare "$1/.env" "$2" "$3"' \
  bash "$STACK_DIR" "$MAILCOW_DIR" "$WEBMAIL_DIR"
(cd "$WEBMAIL_DIR" && sudo docker compose build && sudo docker compose --profile admin up -d)
sudo bash scripts/webmail-cutover.sh add-admin-host
sudo bash scripts/admin-app-link.sh add "$MAILCOW_DIR"
sudo bash -e -c '
  set +x
  set -a; source "$1/.env"; set +a
  source "$1/scripts/lib/webmail-env.sh"
  source "$1/scripts/lib/waf.sh"
  waf_reconcile "${NPMPLUS_DIR:-/home/npmplus}"
  docker exec npmplus nginx -t
  if [ "$WAF_NPMPLUS_RESTART_REQUIRED" = true ]; then
    docker restart npmplus
  else
    docker exec npmplus nginx -s reload
  fi
' bash "$PWD"
sudo bash scripts/verify.sh
```

순서는 rsync → `webmail_prepare`(공개·관리 env와 override) → build·관리 profile up → 관리 프록시 → 앱 링크 → WAF 재적용 → 확인입니다. WAF 재적용은 update와 같은 `waf_reconcile`로 관리 주소 예외를 생성하고 CrowdSec 설정을 검증·재적용합니다. NPMplus도 `nginx -t` 성공 후 reload하며, 바운서 설정이 바뀌어 함수가 재시작을 요구하면 restart합니다. 어느 단계든 실패하면 다음 단계로 진행하지 말고 원인을 확인합니다.

`/home/webmail/webmail-admin.env`는 권한600입니다. 스택 `.env`와 함께 출력하거나 커밋하지 마세요. `pin` 모드에서는 공개 인증서를 두 컨테이너에 `:ro,z`로 연결하고, 인증서가 바뀌면 둘 다 재생성합니다. 일반 update도 관리 env와 앱 링크를 다시 확인합니다.

### 확인과 업데이트

`sudo bash scripts/verify.sh`에서 관리 컨테이너 running/healthy, 관리 `/healthz` 200, 비로그인 logout 403 및 인증 요구 헤더 부재, 공개 웹메일 관리 경로 404, 공개 웹메일에서 관리 컨테이너·dockerapi 연결 차단, 관리 앱 링크를 확인합니다. 접근 목록에 의해 `/healthz`가 403이면 해당 항목은 건너뜀으로 표시하므로 허용 IP의 브라우저에서도 확인합니다. 관리자 로그인 뒤 상태와 계정 정보가 mailcow 화면과 같은지도 확인합니다.

`sudo bash scripts/update.sh -y`는 켜진 관리 컨테이너의 env를 다시 만들고 같은 이미지로 올린 뒤 앱 링크를 유지합니다. mailcow 갱신을 빼려면 `--skip-mailcow-update`를 붙입니다. 관리 선택을 false로만 바꾸면 실행 중인 관리 컨테이너를 지우지 않고 끄기 절차를 경고합니다.

### 관리 화면 끄기

2단계(`WEBMAIL_ADMIN_DOVEADM_ENABLE`·`WEBMAIL_ADMIN_RELAY_ENABLE`)를 켰다면 먼저 아래 [2단계 끄기와 릴레이 항목 보존](#2단계-끄기와-릴레이-항목-보존) 절차로 두 값을 `false`로 바꾸고 끕니다. 두 값 중 하나라도 `true`로 남아 있으면 아래 `webmail_prepare`가 `admin stage 2 requires WEBMAIL_ADMIN_ENABLE=true`로 멈춥니다.

`.env`의 `WEBMAIL_ADMIN_ENABLE=false`를 먼저 설정하고 다음 순서로 실행합니다. `ADMIN_ACCESS_LIST`는 프록시 제거가 끝날 때까지 유지합니다.

```bash
(cd /home/webmail && sudo docker compose --profile admin stop webmail-admin && sudo docker compose --profile admin rm -f webmail-admin)
sudo bash scripts/webmail-cutover.sh remove-admin-host
sudo bash scripts/admin-app-link.sh remove /home/mailcow-dockerized
sudo bash -c 'source "$1/scripts/lib/webmail-env.sh"; webmail_prepare "$1/.env" /home/mailcow-dockerized /home/webmail' bash "$PWD"
(cd /home/webmail && sudo docker compose up -d webmail)
sudo bash -e -c '
  set +x
  set -a; source "$1/.env"; set +a
  source "$1/scripts/lib/webmail-env.sh"
  source "$1/scripts/lib/waf.sh"
  waf_reconcile "${NPMPLUS_DIR:-/home/npmplus}"
  docker exec npmplus nginx -t
  if [ "$WAF_NPMPLUS_RESTART_REQUIRED" = true ]; then
    docker restart npmplus
  else
    docker exec npmplus nginx -s reload
  fi
' bash "$PWD"
sudo bash scripts/verify.sh
```

위 WAF 재적용은 바뀐 `.env`를 읽어 관리 주소 예외도 제거합니다. 설정 검증에 실패하면 reload하지 않고 원인을 확인합니다.

`LOGO_DIR`가 비어 공개 웹메일은 기본 글자 로고를 표시합니다. 관리 주소가 닫혔고 컨테이너가 없는지 확인합니다. `webmail-admin-data`와 `webmail-brand` 볼륨은 남습니다. 실제 이름에는 compose 프로젝트 접두가 붙습니다. 전체 `teardown.sh`도 관리 기록·로고 볼륨을 보존하고 이름을 안내합니다. 별도 확인 없이 `down -v`나 볼륨 삭제를 실행하지 않습니다.

### Toolkit 제거와 mailcow 업데이트

`TOOLKIT_ENABLE=false`는 설치·갱신만 건너뜁니다. 관리 화면에서 Toolkit 대응 기능을 모두 확인하고 서버별 제거 승인을 받은 뒤 진행합니다. 기존 컨테이너·데이터·API 키를 update가 자동 삭제하지 않습니다. 아래 명령은 스택 저장소 루트에서 실행하며 백업 폴더는 아직 없는 경로를 지정합니다.

```bash
TOOLKIT_BACKUP_DIR=/root/toolkit-backup-$(date +%Y%m%d-%H%M%S)
sudo env TOOLKIT_BACKUP_DIR="$TOOLKIT_BACKUP_DIR" bash scripts/toolkit-remove.sh backup
sudo test -s "$TOOLKIT_BACKUP_DIR/toolkit-backup.json"
sudo stat -c '%a %n' "$TOOLKIT_BACKUP_DIR/config.yml"
```

`verified backup saved` 성공 메시지와 `config.yml` 권한600을 확인합니다. 도구는 데이터 폴더가 비어 있지 않은지와 config·compose 조각·nginx 경로·PHP 인증 연결·Redis 앱 링크의 백업 및 해시를 검증합니다. 백업 내용을 대화·로그에 출력하지 마세요. 성공 확인 후 스택 `.env`에서 `TOOLKIT_ENABLE=false`로 직접 바꾸고, 같은 셸에서 같은 백업 경로로 제거합니다. `remove`에는 위치 인자를 붙이지 않습니다.

```bash
sudo env TOOLKIT_BACKUP_DIR="$TOOLKIT_BACKUP_DIR" bash scripts/toolkit-remove.sh remove
sudo bash scripts/verify.sh
```

remove는 백업을 다시 검증한 뒤 앱 링크·컨테이너·compose 조각·nginx 경로·PHP 인증 연결을 제거하고 nginx를 reload합니다. 앱 메뉴에서 Toolkit이 사라지고 관리 화면이 남았는지, 허용 IP에서 로그인한 뒤 `https://mailcow.example.com/toolkit/`이 404인지 확인합니다(`example.com`은 실제 도메인으로 바꿈). mailcow API 키는 변경하지 않으며 `/home/mailcow-toolkit` 설치·데이터 폴더와 백업 폴더를 남깁니다.

복구하려면 실제 백업 폴더를 위치 인자로 전달합니다. 아래 예의 경로를 보관한 경로로 바꿉니다.

```bash
sudo bash scripts/toolkit-remove.sh restore /root/toolkit-backup-20261017-020000
```

복구 성공 후 스택 `.env`에서 `TOOLKIT_ENABLE=true`로 직접 바꾸고 실행합니다.

```bash
(cd /home/mailcow-dockerized && sudo docker compose up -d toolkit-mailcow)
sudo bash toolkit/app_link.sh add /home/mailcow-dockerized
(cd /home/mailcow-dockerized && sudo docker compose exec -T nginx-mailcow nginx -s reload)
sudo bash scripts/verify.sh
```

앱 메뉴에 Toolkit이 돌아오고 `/toolkit/`이 열리는지 확인합니다. 백업 이후 설치 파일·데이터·앱 링크가 달라졌으면 도구는 복구를 거부하므로 변경 내용을 먼저 확인합니다.

mailcow 판을 바꿀 때는 관리자 로그인과 TOTP 판별, 관리자 JSON API, dockerapi 공유·필터 읽기, 실제 IP 전달, 공개 웹메일 격리를 시험 VM에서 확인합니다. 로고·변경 기록 볼륨도 별도로 백업합니다.

### 2단계: 메일 정리·용량 재확인·릴레이 허용 IP

두 기능은 각각 선택하며 기본 꺼짐입니다. `WEBMAIL_ADMIN_ENABLE=true`가 필수이고, 관리 끔 상태에서 아래 선택값만 켜면 설정 오류로 멈춥니다.

| 변수 | 기본값 | 동작 |
|---|---|---|
| `WEBMAIL_ADMIN_DOVEADM_ENABLE` | `false` | 메일 정리·용량 재확인용 내부 HTTP API |
| `WEBMAIL_ADMIN_DOVEADM_KEY` | 빈 값 | 위 기능이 켜졌을 때만 64자리 hex 키를 생성해 스택 `.env`에 권한600으로 저장. 출력·커밋 금지 |
| `WEBMAIL_ADMIN_RELAY_ENABLE` | `false` | Postfix/Rspamd 릴레이 파일 두 개 연결 |

사용자 공지와 변경 시간대를 정하고 Dovecot `extra.conf`, Postfix `extra.cf`, Rspamd `options.inc`, 스택 `.env`를 비공개 백업에 보관합니다. 시험 VM에서 확인한 Dovecot 2.3.21.1은 `doveadm reload`로 API를 켜고 끌 수 있으며 기존 IMAP·POP 접속을 끊지 않습니다. 릴레이 목록 변경은 Postfix·Rspamd를 재시작하므로 짧은 SMTP 중단이 있습니다. 운영 반영은 시간대를 정해 진행합니다.

`.env`에서 원하는 선택값을 true로 바꾼 뒤 저장소 루트에서 실행합니다. 관리 컨테이너는 같은 이미지이며 서버 코드를 새로 반영했다면 먼저 이미지를 빌드합니다.

```bash
sudo bash -c 'source "$1/scripts/lib/webmail-env.sh"; webmail_prepare "$1/.env" /home/mailcow-dockerized /home/webmail' bash "$PWD"
(cd /home/webmail && sudo docker compose --profile admin up -d webmail-admin)
sudo bash scripts/verify.sh
```

`webmail_prepare`는 필요한 키만 생성하고 `apply-dovecot-admin-api.sh apply -y` 또는 `--revert -y`를 실행한 뒤 env·override를 만듭니다. setup·update도 같은 준비를 합니다. 같은 Dovecot 블록이면 파일 쓰기·reload가 없습니다. 키와 선택값이 없는 기존 `.env`에서는 2단계 작업을 하지 않습니다.

관리 블록을 쓰면 키 보호를 위해 `extra.conf`를 `0600 root:root`로 둡니다.

관리 env의 `DOVEADM_URL`은 `http://dovecot:12346`이며 `dovecot`은 mailcow 내부망의 서비스 별칭입니다. 클라이언트가 `/doveadm/v1`을 붙입니다. 허용 명령은 `search,expunge,quota get,quota recalc,mailbox list,acl get`입니다. `extra.conf` 관리 블록은 키와 HTTP 리스너를 두고, 허용 목록은 `remote 0.0.0.0/1`·`remote 128.0.0.0/1`·`remote ::/1`·`remote 8000::/1` 네 블록 안에 각각 설정합니다. IP로 들어오는 doveadm 연결에만 허용 목록을 적용해 mailcow replicator의 unix 소켓 연결은 그대로 둡니다. 기존 전역 허용 목록 블록은 적용 시 키를 유지한 새 형식으로 갱신하고 reload하며, `--check`는 새 형식만 통과합니다. 포트12346은 호스트에 게시하지 않습니다. `DOVEADM_KEY`는 관리 env에만 넣고 공개 웹메일에는 전달하지 않습니다.

릴레이는 `/home/mailcow-dockerized/data/conf/postfix/extra.cf`와 `data/conf/rspamd/local.d/options.inc`가 모두 있을 때만 연결합니다. 특히 mailcow 기본 상태에서 `options.inc`가 없으면 빈 파일을 만들지 않고 두 마운트와 `RELAY_FILES`를 비운 뒤 경고합니다. 기능은 `RELAY_DISABLED`로 꺼지고 verify의 파일 검사는 실패로 표시됩니다. 설정을 검토해 두 파일을 준비하거나 선택값을 false로 되돌립니다.

릴레이를 켜면 Postfix 설정 디렉터리를 `/run/relay/postfix`, Rspamd `local.d` 디렉터리를 `/run/relay/rspamd`에 `rw,z`로 연결합니다. 관리 env의 `RELAY_FILES`는 `/run/relay/postfix/extra.cf,/run/relay/rspamd/options.inc`입니다. 관리 서버가 쓰는 대상은 두 파일뿐이지만 컨테이너에는 두 설정 디렉터리 전체의 쓰기 권한이 노출됩니다. 이 범위 때문에 릴레이 기능은 기본 꺼짐(`WEBMAIL_ADMIN_RELAY_ENABLE=false`)이며 승인된 관리 작업에만 사용합니다. mailcow Postfix 시작 스크립트는 `sed -i`로 `extra.cf` inode를 바꿉니다. 디렉터리를 연결하면 서비스 재시작 뒤 다음 파일 열기에서도 새 inode를 찾아 읽고 쓸 수 있습니다. mailcow는 Postfix 디렉터리에 `rw,z`, Rspamd `local.d` 디렉터리에 `rw,Z`를 사용하므로 단순히 모든 경로의 라벨을 같은 방식으로 바꿔도 안전하다고 가정할 수 없습니다. 시험 VM은 도커 SELinux가 꺼져 있어 충돌을 검증하지 못했습니다. **운영 서버 반영 전 도커 SELinux 설정과 AVC(`ausearch -m avc --input-logs`) 확인 필수**입니다. 거부가 있으면 적용을 중단하고 mount/컨테이너 라벨을 확인합니다. 운영 반영 전 node UID로 두 파일에 쓸 수 있는지, Postfix 재시작으로 inode가 바뀐 뒤에도 관리 쪽에서 새 내용을 읽고 쓰는지, Rspamd 재시작 뒤에도 같은지 확인합니다. 두 파일에 그룹 64250 쓰기 권한을 붙이며, mailcow update가 파일을 새로 쓰면 권한이 빠질 수 있어 우리 스택 update가 매번 다시 맞춥니다(그 사이 저장은 '쓰기 권한 없음'으로 실패하며 파일은 바뀌지 않습니다).

검증은 `apply-dovecot-admin-api.sh --check`, 관리 컨테이너 안 두 릴레이 파일의 존재·읽기, 시험 메일함 개수·용량, 두 릴레이 목록의 일치 여부를 포함합니다. 메일 정리의 삭제는 휴지통으로 옮기지 않으므로 기준일·대상·개수를 확인해야 합니다.

### 2단계 끄기와 릴레이 항목 보존

원하는 선택값을 false로 바꾼 뒤 같은 `webmail_prepare` → 관리 profile up → verify 순서로 실행합니다. doveadm 관리 블록은 `--revert -y`로 제거하고 reload합니다. 릴레이는 파일 연결만 해제하며 이미 저장한 허용 IP는 자동 삭제하지 않습니다. 릴레이 목록의 원복은 연결을 끄기 전에 변경 기록 또는 `/data/relay-backup/`의 두 파일을 검토해 제자리로 복원한 뒤 Postfix·Rspamd를 재시작합니다.

`apply-postfix-edge.sh apply`는 기본 고정 목록 뒤에 관리 화면이 더한 릴레이 IP를 보존합니다. `--revert`는 망 분리 표식과 중계 제외 항목만 제거합니다. 관리 릴레이 IP가 있으면 기본 허용 목록과 함께 표식 밖 `mynetworks`로 남기므로 관리 항목을 지우지 않습니다. 관리 릴레이 IP가 없으면 기존 되돌리기 동작을 유지합니다. 해석할 수 없는 항목이나 별도 `mynetworks`와의 충돌은 자동 병합하지 않고 멈춥니다. 전체 teardown도 Dovecot 관리 블록을 먼저 제거하며 관리 기록·로고 볼륨은 보존합니다.
