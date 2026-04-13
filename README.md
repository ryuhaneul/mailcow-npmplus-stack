# Mailcow + NPMplus + CrowdSec Stack

Mailcow 메일서버 앞단에 NPMplus(리버스 프록시) + CrowdSec(WAF)를 배치하고,
Snappymail 웹메일을 통합하는 올인원 자동화 배포 스크립트.

## 아키텍처

```
[인터넷]
    │
    ├── :80/443 ──→ [NPMplus + CrowdSec WAF]
    │                  ├── mail.DOMAIN      → Snappymail (웹메일)
    │                  ├── mailcow.DOMAIN   → Mailcow Admin UI
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
| Snappymail | Docker 내부 네트워크로 Dovecot/Postfix 연결 (DNS 불필요) |

## 테스트 환경

- **Rocky Linux 9** (primary)

RHEL 계열(Alma, CentOS 9) 호환. Debian/Ubuntu 지원 포함되어 있으나 미검증.

## 사전 요구사항

- Linux 서버, root 접근 권한
- DNS A 레코드: `mail.DOMAIN`, `mailcow.DOMAIN`, `mail-npm.DOMAIN` → 서버 IP
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

```bash
# === 필수 ===
DOMAIN=example.com          # 메일 도메인
SERVER_IP=                   # 비워두면 자동 감지

# === NPMplus 관리자 ===
NPM_ADMIN_EMAIL=admin@example.com
NPM_ADMIN_PASSWORD=ChangeMe!Str0ng   # 비워두면 자동 생성

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
| 6 | Snappymail 배포 + 도메인 설정 + 관리자 비밀번호 설정 |
| 7 | NPM 프록시 호스트 생성 + SSL 인증서 발급 |
| 8 | Mailcow SSL 심볼릭 링크 생성 (NPM 인증서 → Dovecot/Postfix) |
| 9 | 인증서 리로드 크론 설치 (매일 04:00) |

- **멱등성(idempotent)**: 중단 후 재실행 안전
- `--non-interactive` 옵션으로 무인 실행 지원

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
| 웹메일 관리자 | `https://mail.DOMAIN/?admin` | admin / (NPM_ADMIN_PASSWORD) |
| Mailcow 관리 | `https://mailcow.DOMAIN` | admin / (NPM_ADMIN_PASSWORD) |
| NPM 대시보드 | `https://mail-npm.DOMAIN` | (NPM_ADMIN_EMAIL) / (NPM_ADMIN_PASSWORD) |

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
├── snappymail/
│   ├── docker-compose.yml                    # Snappymail 웹메일
│   └── admin_ko.json                         # 한국어 관리자 UI 번역
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
├── snappymail/             # Snappymail
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

### Snappymail 로그인 실패

- 도메인 설정에서 `shortLogin`이 `false`인지 확인 (Dovecot은 `user@domain` 형식 필수)
- `security_level`이 `0`인지 확인
- 도메인 설정 파일 소유자가 `www-data`인지 확인

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
| [SnappyMail](https://github.com/the-djmaze/snappymail) | GNU Affero General Public License v3.0 | `AGPL-3.0-only` |
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
+ CrowdSec (WAF), with integrated Snappymail webmail.

## Architecture

```
[Internet]
    │
    ├── :80/443 ──→ [NPMplus + CrowdSec WAF]
    │                  ├── mail.DOMAIN      → Snappymail (webmail)
    │                  ├── mailcow.DOMAIN   → Mailcow Admin UI
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
| Snappymail | Connects to Dovecot/Postfix via Docker internal network (no DNS required) |

## Tested On

- **Rocky Linux 9** (primary)

Compatible with RHEL-based distros (Alma, CentOS 9). Debian/Ubuntu support is included but untested.

## Prerequisites

- Linux server with root access
- DNS A records: `mail.DOMAIN`, `mailcow.DOMAIN`, `mail-npm.DOMAIN` → server IP
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
NPM_ADMIN_PASSWORD=ChangeMe!Str0ng   # Auto-generated if empty

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
| 6 | Snappymail deployment + domain configuration + admin password setup |
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
| Webmail Admin | `https://mail.DOMAIN/?admin` | admin / (NPM_ADMIN_PASSWORD) |
| Mailcow Admin | `https://mailcow.DOMAIN` | admin / (NPM_ADMIN_PASSWORD) |
| NPM Dashboard | `https://mail-npm.DOMAIN` | (NPM_ADMIN_EMAIL) / (NPM_ADMIN_PASSWORD) |

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
├── snappymail/
│   ├── docker-compose.yml                    # Snappymail webmail
│   └── admin_ko.json                         # Korean admin UI translation
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
├── snappymail/             # Snappymail
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

### Snappymail Login Failure

- Verify `shortLogin` is `false` in domain config (Dovecot requires `user@domain` format)
- Verify `security_level` is `0`
- Verify domain config file ownership is `www-data`

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
| [SnappyMail](https://github.com/the-djmaze/snappymail) | GNU Affero General Public License v3.0 | `AGPL-3.0-only` |
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
