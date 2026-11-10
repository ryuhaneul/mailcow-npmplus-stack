# Mailcow + NPMplus + CrowdSec Stack

Mailcow 메일서버 앞단에 NPMplus(리버스 프록시) + CrowdSec(WAF)를 배치하고,
메일스택 웹메일을 통합하는 올인원 자동화 배포 스크립트.

## 아키텍처

```
[인터넷]
    │
    ├── :80/443 ──→ [NPMplus + CrowdSec WAF]
    │                  ├── mail.DOMAIN      → Webmail (웹메일)
    │                  ├── mailcow.DOMAIN   → Mailcow Admin UI (opt in)
    │                  │     └── /toolkit/  → Mailcow Toolkit
    │                  └── mail-npm.DOMAIN  → NPMplus Dashboard
    │
    ├── :25/465/587 ──→ [Postfix] (직접 노출)
    └── :143/993 ─────→ [Dovecot] (직접 노출)
```

### 핵심 설계

| 항목 | 설명 |
|------|------|
| Mailcow 포트 | `127.0.0.1:8080/8443` — 외부 직접 접근 차단, NPMplus 경유만 허용 |
| SSL 인증서 | NPMplus가 Let's Encrypt 발급 → Docker 볼륨 공유로 Mailcow에 전달 |
| acme-mailcow | 비활성화 (`sleep infinity`) — NPMplus가 인증서 담당 |
| SMTP/IMAP | 리버스 프록시 우회, 직접 노출 |
| 웹메일 | 기본 설치하는 메일스택 웹메일. `webmail:8080`, 사용자 IMAP/Sieve/SMTP 자격과 열 단위 DB 읽기 계정 사용 |
| 관리 화면 | 선택 설치하는 `webmail-admin:8080`. mailcow 관리자 로그인, IP 접근 목록, 변경 기록·웹메일 로고 관리 |

## 웹메일 선택값

| 변수 | 기본값 | 동작 |
|---|---|---|
| `WEBMAIL_ENABLE` | `true` | 웹메일 설치·빌드·기동·검증 |
| `WEBMAIL_ADMIN_ENABLE` | `false` | 웹메일 관리 화면. `WEBMAIL_ENABLE=true`와 관리자 IP 접근 목록 필요 |
| `TOOLKIT_ENABLE` | `true` | Toolkit 설치·업데이트. false로 바꿔도 기존 컨테이너는 자동 삭제하지 않음 |
| `MAIL_SHARE_WHOLE_MAILBOX` | `false` | 받은편지함 공유를 메일함 전체로 확장. 켜기 전 기존 공유 목록 확인. 끄면 설정만 되돌리고 복사된 폴더 권한은 남음 |
| `MAIL_TRUSTED_SENDER_ENABLE` | `false` | SMTP 발신자+IP 짝에 Rspamd -100 점수. 끄면 규칙만 제거하고 목록 보존 |
| `MAIL_AUTOEXPUNGE_ENABLE` | `false` | 모든 메일 프로그램의 Junk·Trash 자동 삭제. `MAIL_AUTOEXPUNGE_DAYS=30`(1~365일) |

관리 주소는 `WEBMAIL_ADMIN_HOSTNAME`(기본 `mailadmin.${DOMAIN}`), 세션 기본값은 유휴 60분·최대 8시간입니다. `ADMIN_ACCESS_LIST`가 비면 관리 프록시를 만들지 않습니다. 기존 서버의 켜기·DNS·검증·끄기는 [관리 화면 안내](docs/guide.md#12-관리-화면)를 따르세요.

웹메일은 기본 켬(`WEBMAIL_ENABLE=true`)이며 값이 없는 기존 `.env`에서도 켜집니다. 기본 주소는 `newmail.${DOMAIN}`이고 `mail.${DOMAIN}`도 새 웹메일에 연결하며 로그인 허용 주소에 자동 추가합니다. `WEBMAIL_ENABLE=false`로 명시하면 설치·기동을 생략합니다.
자동 삭제는 기본 꺼짐입니다. 공지 후 해당 서버 `.env`에 `MAIL_AUTOEXPUNGE_ENABLE=true`를 설정해 켜세요. setup·update는 선택값을 기록하거나 바꾸지 않으며, 켜진 기능에 필요한 빈 비밀값만 생성합니다.

CrowdSec 보안 필터는 기본 켬(`WAF_ENABLE=true`, 키가 없어도 켬)이며, NPMplus 요청을 AppSec CRS로 검사하고 접근 로그의 반복 공격을 로컬 IP 밴으로 차단합니다. CAPI 외부 결정은 받지 않습니다. setup·update가 설정을 적용하며 선택값을 `.env`에 쓰지 않습니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `WAF_ENABLE` | `true` | `false`면 스택 관리 보안 필터 해제 |
| `WAF_MODE` | `block` | `block`은 공격 403, `detect`는 앱 통과·경보 기록(튜닝용) |
| `WAF_ALLOWLIST` | 빈 값 | IP·CIDR 쉼표 목록. IP 밴만 제외하고 AppSec 403은 유지 |

**운영 detect 경보에는 사용자 입력이 남을 수 있습니다.** 짧게 재현·튜닝한 뒤 block으로 복귀하고 `docker exec crowdsec cscli alerts delete --all`로 경보를 삭제하세요. 밴 해제와 요청 오탐 예외는 별도입니다. [튜닝·오탐 대응 절차](docs/guide.md#14-crowdsec-보안-필터)를 따르세요. NPMplus의 `npmplus_crowdsec_appsec=true`는 AppSec를 끈다는 뜻입니다.

`webmail-cutover.sh`는 웹메일 주소 추가·삭제·상태 확인에 사용합니다. 브랜드·접속 제한·TLS는 [웹메일 운영 가이드](docs/guide.md#10-웹메일)를 참고하세요.

### 신뢰 발신 장비

`MAIL_TRUSTED_SENDER_ENABLE=true`로 켜면 setup·update가 SMTP 발신자+접속 IP **짝**에만 -100 점수를 주는 Rspamd 규칙을 설치합니다(기본 꺼짐, 바이러스 검사는 유지). 관리 화면에서는 '신뢰 발신 장비' 목록을 편집합니다. 먼저 규칙만 적용하려면 `scripts/apply-rspamd-trusted-sender.sh` 하나를 복사해 `apply -y --seed <비공개 목록 파일>`을 실행합니다. seed는 목록이 없을 때만 사용하며 기존·수정된 목록을 덮어쓰지 않습니다. `--check`로 검사하고, `--revert -y` 또는 설정을 끈 뒤 update로 규칙만 제거할 수 있습니다. 목록은 남습니다.

옛 발신자 화이트리스트 줄은 스크립트가 지우지 않으므로 서버에서 별도로 백업·제거해야 합니다. 관리 컨테이너의 목록 폴더 `:rw,z`와 Rspamd 상위 `override.d:Z`는 **SELinux 라벨 충돌 위험**이 있어 운영 반영 전 AVC·재시작 후 읽기/쓰기 시험이 필요합니다. 의존 도구·seed 형식·되돌리기는 [설치 가이드](docs/guide.md#신뢰-발신-장비-발신자--ip-짝)를 참고하세요.

## 테스트 환경

- **Rocky Linux 9** (primary)

RHEL 계열(Alma, CentOS 9) 호환. Debian/Ubuntu 지원 포함되어 있으나 미검증.

## 사전 요구사항

- Linux 서버, root 접근 권한
- DNS A 레코드: `mail.DOMAIN`, `mail-npm.DOMAIN` → 서버 IP. `mailcow.DOMAIN`은 공개 웹을 임시로 켤 때만 필요합니다.
- **Docker, Mailcow 사전 설치 불필요** — `setup.sh`가 모두 설치

## 빠른 시작

```bash
git clone https://github.com/ryuhaneul/mailcow-npmplus-stack.git
cd mailcow-npmplus-stack
cp .env.example .env
vi .env          # DOMAIN 필수 설정

chmod +x scripts/*.sh
sudo ./scripts/setup.sh
```

### .env 설정

외부 이미지는 NPMplus `2026-07-24-r1`, CrowdSec `v1.7.8`의 태그·다이제스트로 고정합니다. 판 변경과 기존 서버 동기화는 [이미지 버전 절차](docs/guide.md#외부-이미지-버전-고정변경)를 따르세요. 다른 특정 버전을 직접 지정한 서버는 update가 그 값을 유지합니다.

```bash
# === 필수 ===
DOMAIN=example.com          # 메일 도메인
SERVER_IP=                   # 비워두면 자동 감지

# === NPMplus 관리자 ===
NPM_ADMIN_EMAIL=admin@example.com
NPM_ADMIN_PASSWORD=   # 비워두면 자동 생성(권장)

# === 자동 생성 (비워두면 setup.sh가 생성) ===
CROWDSEC_BOUNCER_KEY=
MAILCOW_API_KEY=
TOOLKIT_SECRET_KEY=
```

## setup.sh 수행 내용

| Phase | 내용 |
|-------|------|
| 0 | 시스템 패키지 업데이트 및 필수 도구 설치 (curl, dig, openssl, git) |
| 1 | Docker Engine + Docker Compose 설치 (firewall 안전 처리 포함) |
| 2 | 환경변수 로드, 시크릿 자동 생성 |
| 3 | DNS 레코드 표시 및 검증 (미설정 시 self-signed로 계속 진행) |
| 4 | Mailcow 설치, 포트/바인딩 패치, API 키 설정 |
| 5 | NPMplus + CrowdSec 배포 |
| 6b | 웹메일 빌드·환경 생성·기동 |
| 7 | NPM 프록시 호스트 생성 + SSL 인증서 발급 |
| 8 | Mailcow SSL 심볼릭 링크 생성 (NPM 인증서 → Dovecot/Postfix) |
| 9 | 인증서 리로드 크론 설치 (매일 04:00) |

- **멱등성(idempotent)**: 중단 후 재실행 안전
- `--non-interactive` 옵션으로 무인 실행 지원

## 업데이트

일반 업데이트는 `sudo ./scripts/update.sh -y`입니다. mailcow 판을 고정한 서버에서는 `sudo ./scripts/update.sh -y --skip-mailcow-update`로 mailcow 공식 업데이트만 건너뛰고 스택 업데이트를 계속할 수 있습니다. 생략 시 기존처럼 mailcow도 업데이트하며, 대화형 확인에서 아니오를 선택하면 전체 작업이 중단됩니다. 나머지 재빌드·재시작·검증은 수행하므로 무중단 옵션은 아닙니다. 자세한 내용은 [운영 가이드](docs/guide.md#설치업데이트tls)를 참고하세요.

## 검증

```bash
sudo ./scripts/verify.sh
```

컨테이너 상태, 웹 서비스 응답, SSL 인증서, 메일 프로토콜(SMTP/IMAP),
보안(내부 포트 외부 차단), 크론 설치를 자동 확인. 종료 코드 = 실패 항목 수.

## DNS 레코드 확인

```bash
sudo ./scripts/dns-records.sh
```

필요한 모든 DNS 레코드(A, MX, SPF, DKIM, DMARC, PTR)를 복사 가능한 형태로 표시.

## 완전 제거

```bash
sudo ./scripts/teardown.sh
```

모든 컨테이너, 볼륨, 설치 디렉토리를 제거. 볼륨까지 삭제하므로 데이터 복구 불가.

## 서비스 접속

| 서비스 | URL | 계정 |
|--------|-----|------|
| 웹메일 | `https://mail.DOMAIN` | Mailcow에서 생성한 메일 계정 |
| 웹메일 관리자(선택) | `https://mailadmin.DOMAIN` | Mailcow 전체 관리자 |
| Mailcow 관리(기본 꺼짐) | `https://mailcow.DOMAIN` | admin / (NPM_ADMIN_PASSWORD) |
| NPM 대시보드 | `https://mail-npm.DOMAIN` | (NPM_ADMIN_EMAIL) / (NPM_ADMIN_PASSWORD) |

`MAILCOW_WEB_PUBLIC_ENABLE=false`가 기본이며 누락·빈 값도 false입니다. 기존 설치도 다음 update에서 `mailcow.DOMAIN` 프록시를 삭제 없이 끕니다. update는 이 설정값을 쓰거나 바꾸지 않습니다. 내부 nginx와 메일 서비스, 새 웹메일·관리 앱은 유지됩니다. 필요한 mailcow 초기 작업은 [임시 재개 절차](docs/guide.md#mailcow-웹-공개-설정과-임시-복구)를 따르세요. 앱의 기존 mailcow 복구 링크는 꺼진 동안 사용할 수 없습니다.

NPM_ADMIN_PASSWORD를 `.env`에 지정하지 않은 경우, setup 완료 시 터미널에 출력됩니다.

## 파일 구조

```
mailcow-npmplus-stack/
├── .env.example                              # 환경변수 템플릿
├── README.md                                 # 이 문서
├── docs/
│   └── guide.md                              # 상세 구성 가이드 (수동 설정 참고)
├── npmplus/
│   └── docker-compose.yml                    # NPMplus + CrowdSec
├── webmail/                                  # Mailstack Webmail
├── mailcow-override/
│   ├── docker-compose.override.yml           # Mailcow 오버라이드 (인증서 공유, acme 비활성화)
│   └── docker-compose.override.toolkit.yml   # Toolkit 추가 템플릿
├── toolkit/                                  # Mailcow Toolkit (번들 포함)
│   ├── Dockerfile
│   ├── app/                                  # Flask 애플리케이션 소스
│   ├── app_link.sh                           # Mailcow 네비바 등록
│   ├── config.yml.template                   # 설정 템플릿
│   └── requirements.txt
└── scripts/
    ├── setup.sh                              # 전체 설치 자동화
    ├── teardown.sh                           # 완전 제거
    ├── verify.sh                             # 상태 검증
    └── dns-records.sh                        # DNS 레코드 표시
```

### 서버 설치 디렉토리

```
/home/
├── mailcow-dockerized/    # Mailcow (git clone)
├── npmplus/                # NPMplus + CrowdSec
├── webmail/                # Mailstack Webmail
└── mailcow-toolkit/        # Toolkit (setup.sh가 toolkit/에서 복사)
```

## 트러블슈팅

### Mailcow update.sh 인증서 경고

```
cp: not writing through dangling symlink 'data/assets/ssl/cert.pem'
```

무시 가능. SSL 심볼릭 링크는 호스트에서는 dangling이지만 컨테이너 내부에서 정상 동작합니다.

### unbound-mailcow unhealthy

Docker 재시작 후 iptables 규칙 누락 시 발생. `systemctl restart docker`로 해결.

### NPM proxy host가 conf를 생성하지 않음

DB의 `nginx_online: false` 캐시 문제. 해당 호스트를 API로 삭제 후 재생성.

### 메일 발송 후 수신 서버에서 거부

DNS 레코드(MX, A, PTR, DKIM, DMARC)가 미설정이면 수신 서버의 스팸 필터에서 거부됩니다.
최소 MX + A 레코드 + PTR(rDNS) 설정이 필요합니다.

## 라이선스

이 프로젝트 자체의 스크립트 및 설정 파일은 **MIT License**로 배포됩니다.

이 스택은 아래의 오픈소스 소프트웨어를 사용합니다. 각 소프트웨어는 해당 프로젝트의 라이선스를 따릅니다.

| 소프트웨어 | 라이선스 | SPDX |
|-----------|---------|------|
| [Mailcow-dockerized](https://github.com/mailcow/mailcow-dockerized) | GNU General Public License v3.0 | `GPL-3.0-only` |
| [NPMplus](https://github.com/ZoeyVid/NPMplus) | MIT License | `MIT` |
| [CrowdSec](https://github.com/crowdsecurity/crowdsec) | MIT License | `MIT` |
| [Docker Engine](https://github.com/moby/moby) | Apache License 2.0 | `Apache-2.0` |
| [Postfix](https://www.postfix.org/) | Eclipse Public License 2.0 / IBM Public License 1.0 | `EPL-2.0` OR `IPL-1.0` |
| [Dovecot](https://www.dovecot.org/) | MIT (libs) + LGPL v2.1 | `MIT` AND `LGPL-2.1-only` |
| [Rspamd](https://rspamd.com/) | Apache License 2.0 | `Apache-2.0` |
| [SOGo](https://www.sogo.nu/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [MariaDB](https://mariadb.org/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [Redis](https://redis.io/) | BSD 3-Clause (v7.x), tri-license (v8+) | `BSD-3-Clause` |
| [Nginx](https://nginx.org/) | BSD 2-Clause | `BSD-2-Clause` |
| [ClamAV](https://www.clamav.net/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [Unbound](https://nlnetlabs.nl/projects/unbound/) | BSD 3-Clause | `BSD-3-Clause` |
| [PHP](https://www.php.net/) | PHP License v3.01 | `PHP-3.01` |
| [Olefy](https://github.com/HeinleinSupport/olefy) | Apache License 2.0 | `Apache-2.0` |

## 면책조항

이 프로젝트는 메일 서버 배포를 자동화하기 위한 스크립트 모음입니다.

- **어떠한 보증도 제공하지 않습니다.** 이 소프트웨어는 "있는 그대로(AS IS)" 제공되며,
  명시적이거나 묵시적인 어떠한 종류의 보증도 포함하지 않습니다.
- **프로덕션 배포 전 충분한 테스트를 수행하십시오.** 메일 서버는 보안에 민감한
  인프라이며, 잘못된 설정은 데이터 유출 또는 서비스 중단으로 이어질 수 있습니다.
- **DNS, SSL, 방화벽 설정은 사용자의 책임입니다.** 이 스크립트는 기본 설정을
  자동화하지만, 네트워크 환경에 따른 추가 보안 설정은 사용자가 직접 수행해야 합니다.
- **포함된 서드파티 소프트웨어의 라이선스를 준수하십시오.** 각 구성 요소는 해당
  프로젝트의 라이선스 조건을 따르며, 이 프로젝트는 해당 라이선스에 대한 책임을
  지지 않습니다.
- **이 소프트웨어의 사용으로 인해 발생하는 어떠한 손해에 대해서도 저작자 또는
  기여자는 책임을 지지 않습니다.**

---

# Mailcow + NPMplus + CrowdSec Stack

An all-in-one automated deployment of Mailcow mail server behind NPMplus (reverse proxy)
+ CrowdSec (WAF), with integrated Mailstack Webmail.

CrowdSec request filtering and local log-based IP bans are enabled by default (`WAF_ENABLE=true`, `WAF_MODE=block`). `WAF_ALLOWLIST` exempts IP ban decisions only; AppSec can still return 403. CAPI is disabled. Detect mode passes requests and records alerts that may contain user input: use briefly, return to block, then run `docker exec crowdsec cscli alerts delete --all`. See the [WAF operations guide](docs/guide.md#14-crowdsec-보안-필터).

## Architecture

```
[Internet]
    │
    ├── :80/443 ──→ [NPMplus + CrowdSec WAF]
    │                  ├── mail.DOMAIN      → Webmail (webmail)
    │                  ├── mailcow.DOMAIN   → Mailcow Admin UI (opt in)
    │                  │     └── /toolkit/  → Mailcow Toolkit
    │                  └── mail-npm.DOMAIN  → NPMplus Dashboard
    │
    ├── :25/465/587 ──→ [Postfix] (direct)
    └── :143/993 ─────→ [Dovecot] (direct)
```

### Design Decisions

| Item | Description |
|------|-------------|
| Mailcow ports | `127.0.0.1:8080/8443` — blocks external access, only reachable via NPMplus |
| SSL certificates | NPMplus issues Let's Encrypt certs → shared to Mailcow via Docker volume |
| acme-mailcow | Disabled (`sleep infinity`) — NPMplus handles certificates |
| SMTP/IMAP | Direct exposure, bypasses reverse proxy |
| Webmail administration | Optional `webmail-admin:8080`, mailcow administrator login, IP access restriction, audit history and branding |

Webmail defaults to enabled (`WEBMAIL_ENABLE=true`), including when the key is absent. It serves `newmail.${DOMAIN}` and `mail.${DOMAIN}`; set `WEBMAIL_ENABLE=false` to skip deployment. `webmail-cutover.sh` manages Webmail host creation, removal and status. See the [Webmail operations guide](docs/guide.md#10-웹메일).

Whole-mailbox sharing defaults to off (`MAIL_SHARE_WHOLE_MAILBOX=false`). Review existing shares before enabling: existing INBOX shares immediately expand to every folder. Disabling removes only the setting; copied folder ACLs remain. Dovecot reload disconnects active IMAP/POP connections once; mail clients reconnect.

Webmail administration defaults to off (`WEBMAIL_ADMIN_ENABLE=false`) and requires Webmail plus an IP-only `ADMIN_ACCESS_LIST`. The default hostname is `mailadmin.${DOMAIN}`. `TOOLKIT_ENABLE` defaults to true; disabling it preserves existing Toolkit containers. See the [administration guide](docs/guide.md#12-관리-화면).

## Tested On

- **Rocky Linux 9** (primary)

Compatible with RHEL-based distros (Alma, CentOS 9). Debian/Ubuntu support is included but untested.

## Prerequisites

- Linux server with root access
- DNS A records: `mail.DOMAIN`, `mail-npm.DOMAIN` → server IP. `mailcow.DOMAIN` is optional for public web access.
- **Docker and Mailcow are NOT required** — `setup.sh` installs everything

## Quick Start

```bash
git clone https://github.com/ryuhaneul/mailcow-npmplus-stack.git
cd mailcow-npmplus-stack
cp .env.example .env
vi .env          # DOMAIN is required

chmod +x scripts/*.sh
sudo ./scripts/setup.sh
```

### .env Configuration

```bash
# === Required ===
DOMAIN=example.com          # Mail domain
SERVER_IP=                   # Auto-detected if empty

# === NPMplus Admin ===
NPM_ADMIN_EMAIL=admin@example.com
NPM_ADMIN_PASSWORD=   # Auto-generated if empty (recommended)

# === Auto-generated (leave empty for setup.sh to generate) ===
CROWDSEC_BOUNCER_KEY=
MAILCOW_API_KEY=
TOOLKIT_SECRET_KEY=
```

## What setup.sh Does

| Phase | Description |
|-------|-------------|
| 0 | System package update and essential tool installation (curl, dig, openssl, git) |
| 1 | Docker Engine + Docker Compose installation (with firewall safety) |
| 2 | Environment variable loading, automatic secret generation |
| 3 | DNS record display and validation (proceeds with self-signed certs if DNS is missing) |
| 4 | Mailcow installation, port/binding patches, API key configuration |
| 5 | NPMplus + CrowdSec deployment |
| 6b | Webmail build, environment generation and startup |
| 7 | NPM proxy host creation + SSL certificate issuance |
| 8 | Mailcow SSL symlink creation (NPM certificates → Dovecot/Postfix) |
| 9 | Certificate reload cron installation (daily at 04:00) |

- **Idempotent**: safe to re-run after interruption
- Supports `--non-interactive` for unattended execution

## Verification

```bash
sudo ./scripts/verify.sh
```

Checks container status, web service responses, SSL certificates, mail protocols (SMTP/IMAP),
security (internal ports blocked externally), and cron installation. Exit code = number of failures.

## DNS Record Display

```bash
sudo ./scripts/dns-records.sh
```

Displays all required DNS records (A, MX, SPF, DKIM, DMARC, PTR) in copy-paste format.

## Full Removal

```bash
sudo ./scripts/teardown.sh
```

Removes all containers, volumes, and installation directories. Volumes are deleted — data is unrecoverable.

## Service Access

| Service | URL | Credentials |
|---------|-----|-------------|
| Webmail | `https://mail.DOMAIN` | Mail account created in Mailcow |
| Webmail Admin (optional) | `https://mailadmin.DOMAIN` | Mailcow superadmin |
| Mailcow Admin (off by default) | `https://mailcow.DOMAIN` | admin / (NPM_ADMIN_PASSWORD) |
| NPM Dashboard | `https://mail-npm.DOMAIN` | (NPM_ADMIN_EMAIL) / (NPM_ADMIN_PASSWORD) |

`MAILCOW_WEB_PUBLIC_ENABLE=false` is the default; missing or empty also means false. The next update disables an existing `mailcow.DOMAIN` proxy without deleting it and never writes this selection to `.env`. Internal nginx, mail services, and the separate webmail/admin apps keep running. Follow the [temporary access procedure](docs/guide.md#mailcow-웹-공개-설정과-임시-복구) for initial password or two-factor tasks. Existing app recovery links are unavailable while the proxy is disabled.

If NPM_ADMIN_PASSWORD is not set in `.env`, the generated password is printed at the end of setup.

## File Structure

```
mailcow-npmplus-stack/
├── .env.example                              # Environment variable template
├── README.md                                 # This document
├── docs/
│   └── guide.md                              # Detailed configuration guide (manual setup reference)
├── npmplus/
│   └── docker-compose.yml                    # NPMplus + CrowdSec
├── webmail/                                  # Mailstack Webmail
├── mailcow-override/
│   ├── docker-compose.override.yml           # Mailcow overrides (cert sharing, acme disabled)
│   └── docker-compose.override.toolkit.yml   # Toolkit addon template
├── toolkit/                                  # Mailcow Toolkit (bundled)
│   ├── Dockerfile
│   ├── app/                                  # Flask application source
│   ├── app_link.sh                           # Mailcow navbar registration
│   ├── config.yml.template                   # Configuration template
│   └── requirements.txt
└── scripts/
    ├── setup.sh                              # Full installation automation
    ├── teardown.sh                           # Full removal
    ├── verify.sh                             # Health check
    └── dns-records.sh                        # DNS record display
```

### Server Installation Directories

```
/home/
├── mailcow-dockerized/    # Mailcow (git clone)
├── npmplus/                # NPMplus + CrowdSec
├── webmail/                # Mailstack Webmail
└── mailcow-toolkit/        # Toolkit (copied from toolkit/ by setup.sh)
```

## Troubleshooting

### Mailcow update.sh Certificate Warning

```
cp: not writing through dangling symlink 'data/assets/ssl/cert.pem'
```

Safe to ignore. SSL symlinks are dangling on the host but resolve correctly inside containers.

### unbound-mailcow unhealthy

Occurs when iptables rules are lost after Docker restart. Fix with `systemctl restart docker`.

### NPM Proxy Host Not Generating Config

DB cache issue with `nginx_online: false`. Delete and recreate the host via API.

### Mail Rejected by Receiving Server

Missing DNS records (MX, A, PTR, DKIM, DMARC) cause spam filter rejection on receiving servers.
At minimum, MX + A records + PTR (rDNS) must be configured.

## License

The scripts and configuration files in this project are distributed under the **MIT License**.

This stack uses the following open-source software. Each component is governed by its own license.

| Software | License | SPDX |
|----------|---------|------|
| [Mailcow-dockerized](https://github.com/mailcow/mailcow-dockerized) | GNU General Public License v3.0 | `GPL-3.0-only` |
| [NPMplus](https://github.com/ZoeyVid/NPMplus) | MIT License | `MIT` |
| [CrowdSec](https://github.com/crowdsecurity/crowdsec) | MIT License | `MIT` |
| [Docker Engine](https://github.com/moby/moby) | Apache License 2.0 | `Apache-2.0` |
| [Postfix](https://www.postfix.org/) | Eclipse Public License 2.0 / IBM Public License 1.0 | `EPL-2.0` OR `IPL-1.0` |
| [Dovecot](https://www.dovecot.org/) | MIT (libs) + LGPL v2.1 | `MIT` AND `LGPL-2.1-only` |
| [Rspamd](https://rspamd.com/) | Apache License 2.0 | `Apache-2.0` |
| [SOGo](https://www.sogo.nu/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [MariaDB](https://mariadb.org/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [Redis](https://redis.io/) | BSD 3-Clause (v7.x), tri-license (v8+) | `BSD-3-Clause` |
| [Nginx](https://nginx.org/) | BSD 2-Clause | `BSD-2-Clause` |
| [ClamAV](https://www.clamav.net/) | GNU General Public License v2.0 | `GPL-2.0-only` |
| [Unbound](https://nlnetlabs.nl/projects/unbound/) | BSD 3-Clause | `BSD-3-Clause` |
| [PHP](https://www.php.net/) | PHP License v3.01 | `PHP-3.01` |
| [Olefy](https://github.com/HeinleinSupport/olefy) | Apache License 2.0 | `Apache-2.0` |

## Disclaimer

This project is a collection of scripts for automating mail server deployment.

- **No warranties of any kind are provided.** This software is provided "AS IS" without
  warranty of any kind, either express or implied.
- **Perform thorough testing before production deployment.** Mail servers are
  security-sensitive infrastructure, and misconfiguration may lead to data exposure
  or service disruption.
- **DNS, SSL, and firewall configuration are the user's responsibility.** These scripts
  automate basic setup, but additional security hardening for your network environment
  must be performed by the user.
- **Comply with the licenses of included third-party software.** Each component is
  governed by its respective project's license terms. This project assumes no
  responsibility for those licenses.
- **The authors and contributors shall not be liable for any damages arising from the
  use of this software.**

### Retirement metadata migration (admin)

Retirement metadata and SMTP recipient keys use separate application tables. Prepare
`bash scripts/apply-webmail-retirement-db.sh apply` before applying the updated DB grants;
`--check` verifies the existing schema and `--dry-run` prints DDL without contacting services.
The admin DB account gets CRUD on both tables. Public webmail gets SELECT only on
`retirement_recipient_keys` when the server's
`WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE=true`; missing/empty/false leaves this
additional public grant disabled. The SMTP account and receive-block hook are prepared
separately. Importing metadata never activates receive blocking.

Run the migration inside the admin container using its existing API key, audit directory,
and DB account. An installation without the mailcow API key cannot migrate. Prepare an
admin-only directory such as `/data/private` (0700); reports are created exclusively with
mode 0600 and existing files are never overwritten. Approvals contain one canonical
address per line. Review a new report and explicitly approve addresses before applying:

```sh
docker exec webmail-admin node bin/migrate-webmail-retirement.js --dry-run --output /data/private/retirement-candidates.json
docker exec webmail-admin node bin/migrate-webmail-retirement.js --apply --manifest /data/private/retirement-candidates.json --approved /data/private/retirement-approved.txt --output /data/private/retirement-receipt.json
docker exec webmail-admin node bin/migrate-webmail-retirement.js --rollback --manifest /data/private/retirement-receipt.json --approved /data/private/retirement-approved.txt --output /data/private/retirement-rollback.json
```

Dry-run is the default and changes no service state; only the specified report is created.
Apply rechecks live mailbox state and successful paired audit records before CAS inserts.
Imported accounts are explicitly retired with receive blocking **OFF** and zero recipient
keys. Missing or ambiguous creation times are held: timezone-free timestamps use a
conservative ±24-hour band, and only creation more than 24 hours before the leave record
qualifies. Later lifecycle evidence also holds the address for manual review. This cannot
prove that changes outside the application's API/audit history never happened.

Rollback removes only the exact imported versions in its receipt; modified records,
changed mailbox generations, pending operations or recipient keys stop the operation.
A partial receipt records completed writes; review it before recovery. Schema tables and
existing mail are never dropped by this tool. Application routing/UI integration and SMTP
activation are separate deployment steps.

Retirement settings remove an existing owner forward automatically only with preview
consent, and only when the whole managed prefilter contains literal `:copy` redirects
plus `require`/`stop`; deletion keeps its audit backup. Mixed prefilters are
`OWNER_FORWARD_UNEDITABLE` blockers showing the location and known targets; edit them
in the team distribution screen first. Personal, postfilter and global scripts are
never edited automatically. Ordinary retirement defaults `cleanShares=false` even
with legacy `cleanRefs=true`; permanent deletion still cleans every reference.

In retirement settings, `forwardTo: X` adds X to the existing managed forwards,
`forwardTo: null` explicitly removes the eligible pure managed prefilter, and an
omitted `forwardTo` preserves existing forwards. Preview reports the existing targets
and the actual addition/removal; it does not silently replace other destinations.

A partial leave must finish through the leave preview/run flow before the separate
retirement settings endpoints can be used (`409 RETIREMENT_OPERATION_PENDING`). If
its pending request selected receive blocking and the server feature is OFF, enable
and prepare the server feature before retrying; this flow has no additional cancel
or bypass transition. Partial settings operations may use a new explicit settings
preview instead.

Public webmail receives the derived `RETIREMENT_RECEIVE_BLOCK_ENABLE` boolean from
`WEBMAIL_ADMIN_RETIREMENT_RECEIVE_BLOCK_ENABLE` (missing/empty defaults OFF). When ON,
Sieve writes, activation, restore, imports, undo and failed-import recovery check
literal redirect targets with one batched SELECT on `retirement_recipient_keys` per
write phase. Public webmail has no retirement metadata access or named routing lock.
The SELECT and Sieve write are not atomic: a concurrent admin block can race with
that write, and mailcow UI/API or direct ManageSieve changes remain outside this
application guard. With no redirect targets, no SELECT is needed and saving remains
possible during a DB outage; a DB failure at the initial forwarding check returns
503 before the first change. XML checks before folder creation, then rejects a changed final target set.
A blocked recovery retains its archives, reports `502 IMPORT_WRITE_FAILED` with
`recoveryBlocked`, and asks for administrator review.

The standalone `scripts/apply-postfix-retirement-access.sh [apply|--check|--check-resources|--revert]`
prepares a direct MySQL recipient access map when retirement receive blocking is
explicitly enabled. Run it with the existing stack configuration and root file
ownership privileges; `apply -y` and `--revert -y` authorize the required Postfix
reload. It refuses existing bounce ownership, recipient/relay service overrides,
unexpected owned-hook drift, delimiters other than `+`, or a missing MySQL map
module. Bounce/retirement coexistence belongs to the recipient-policy reconciler. After
checking both owned chains, that reconciler may use `--check-resources` to verify
the private map, exact grants, current IP and Postfix-user lookup without changing
credentials, files, hooks or reload state. This mode does not certify hook ordering.

The private map is stored at
`data/conf/postfix/mailstack-retirement/recipient-access.cf` under the mailcow
project and appears as `/opt/postfix/conf/mailstack-retirement/recipient-access.cf`
in Postfix. The directory is root:Postfix-group 0750 and the file is 0640. Its
password is generated once and kept only in that runtime map, never in the server
`.env`, command arguments, or output. The dedicated `mailstack_retirement_ro`
account has only SELECT on `mailstack_webmail.retirement_recipient_keys`, limited
to the verified Postfix container IPv4. Check detects address/group changes and
requests reapplication; apply reuses the password and removes the recorded old
host account only after the new lookup and hook have been verified.

A match returns one fixed `550 5.7.1 MAILSTACK_RETIRED_RECIPIENT` response; a missing
key returns zero rows. SQL lookup errors must temporarily defer every RCPT that
reaches this hook, including normal incoming mail and authenticated outgoing
recipients. They must not turn into an allow result. Delayed mail can eventually
expire in the sender's queue and generate a delivery status notification. Actual
Postfix SQL escaping, delimiter fallback and SMTP fail-closed behavior still
require the isolated integration tests.

`--revert` restores the preceding recipient chain and verifies/reloads it without
requiring the database. It intentionally retains the inactive map and dedicated
account. After confirming the retirement hook is absent from both persistent and
live configuration, an operator may explicitly drop only the dedicated account at
the map's recorded Postfix IP, then remove that private map and its empty directory.
Do not remove credentials or tables while a live hook still uses them; inspect any
unexpected account hosts rather than dropping them automatically. Account retirement
records and recipient keys remain untouched by these scripts.

If restoring the original map also fails, the command returns failure and retains
a root-owned emergency snapshot (directory 0700, files 0600), printing only its
location. Complete manual recovery, then shred the snapshot files and remove that
directory. Normal runs and successful rollbacks remove their temporary snapshots.
