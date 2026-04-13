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
    image: zoeyvid/npmplus:latest
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
      CROWDSEC: "true"
      CROWDSEC_LAPI: "http://crowdsec:8080"
      CROWDSEC_KEY: "${CROWDSEC_BOUNCER_KEY}"
    volumes:
      - npmplus-data:/data
    networks:
      - npmplus-net
      - mailcow-network
    depends_on:
      - crowdsec

  crowdsec:
    image: crowdsecurity/crowdsec:latest
    container_name: crowdsec
    restart: always
    environment:
      TZ: Asia/Seoul
      COLLECTIONS: "crowdsecurity/nginx crowdsecurity/http-cve"
      BOUNCER_KEY_npmplus: "${CROWDSEC_BOUNCER_KEY}"
    volumes:
      - npmplus-data:/npmplus-data:ro    # NPM 로그 읽기 전용
      - crowdsec-data:/var/lib/crowdsec
      - crowdsec-config:/etc/crowdsec
    networks:
      - npmplus-net

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
    image: djmaze/snappymail:latest
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
```

> `api_url` 포트를 `8443`으로 맞춰야 한다. Mailcow nginx가 기본 443이 아닌
> 8443에서 리스닝하기 때문.

---

## 5. NPM Proxy Host 설정

Mailcow를 먼저 기동한 후 NPMplus를 올리고, NPM 관리 UI에서 설정.

### 5.1 초기 계정

`docker-compose.yml`의 `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` 환경변수로
첫 기동 시 관리자 계정이 자동 생성된다. `setup.sh`는 이 방식을 사용하므로 수동 생성 불필요.

> 로그인 시 토큰은 response body가 아닌 **쿠키 `access_token`**으로 전달된다.

### 5.2 Proxy Host 구성

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
0 4 * * * root docker exec postfix-mailcow postfix reload 2>/dev/null; docker exec dovecot-mailcow doveadm reload 2>/dev/null
```

> 매일 04:00에 postfix/dovecot 리로드. 인증서가 변경되지 않아도 리로드는 무해함.
> nginx-mailcow은 심볼릭을 통해 매 요청 시 읽으므로 별도 리로드 불필요.

---

## 8. 트러블슈팅

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
- [ ] CrowdSec 로그 수집: `docker exec crowdsec cscli decisions list`
- [ ] SSL 인증서 유효성 (웹 + 메일 프로토콜)

### 인증서

- [ ] NPM에서 3개 도메인 인증서 발급 확인
- [ ] Mailcow SSL 심볼릭 resolve 확인: `docker exec nginx-mailcow ls -la /npm-data/tls/certbot/live/`
- [ ] `openssl s_client -connect mail.DOMAIN:993` → 유효한 인증서
- [ ] `openssl s_client -connect mail.DOMAIN:465` → 유효한 인증서
