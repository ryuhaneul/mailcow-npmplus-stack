# 필터 이관용 오프라인 CLI

웹메일 디렉터리에서 실행합니다. 서버에 연결하거나 스크립트를 저장·활성화하지 않습니다.

```sh
node bin/webmail-rules.js import original.sieve --policy policy.json > report.json
node bin/webmail-rules.js import original.sieve --name rainloop.user --policy policy.json > report.json
node bin/webmail-rules.js gen rules.json --policy policy.json > webmail-rules.sieve
```

관리자가 서버에서 `doveadm mailbox list -u <주소>` 결과와 mailcow의 활성 도메인·활성 별칭 도메인 목록으로 `policy.json`을 만듭니다. 문서에 적힌 전달 주소나 이동 폴더를 허용 목록으로 추출하지 않습니다.

```json
{
  "internalDomains": ["example.com"],
  "folders": [{"path": "Archive"}, {"path": "Projects/팀"}],
  "addresses": ["user@example.com", "alias@example.com"]
}
```

- `internalDomains`는 필수입니다. 누락하면 외부 전달 검사를 할 수 없으므로 종료 코드 2로 거부합니다. 빈 배열은 모든 전달을 거부합니다.
- `folders`는 선택입니다. 폴더 항목은 `path`와 필요한 경우 `specialUse`, `shared`, `virtual`, `personal`을 받습니다. 제공하면 W10의 폴더 검사를 수행합니다. 생략하면 존재 여부만 건너뛰고, 해당 항목의 `warnings`와 보고서의 `uncheckedFolders`에 미확인 내용을 남깁니다. 금지된 폴더 경로와 외부 전달 검사는 유지합니다.
- `addresses`는 사용자가 보낼 수 있는 주소 전부입니다. 부재중 응답이 켜진 문서에서 이를 생략하면 W10 생성기의 422 오류와 종료 코드 2를 반환합니다.

`import`는 모든 원본 블록의 `items`와 변환된 `rules`를 JSON으로 출력합니다. `changed`의 변경점을 확인하고, `unconvertible`이 있으면 관리자가 해당 내용을 해결해야 합니다. 변환 불가 블록을 버린 채 자동 활성화하면 안 됩니다. 관리자는 보고서를 확인한 뒤 W10 형식의 규칙 문서를 완성해 `gen`에 전달합니다.

`gen`의 stdout에는 생성된 Sieve만 출력합니다. 폴더 경고와 미확인 개수는 stderr에 출력합니다. 입출력·정책·문서 오류의 종료 코드는 2입니다.

실제 저장·활성화는 계획 8-4의 관리자 `doveadm sieve put`·`doveadm sieve activate` 절차로 별도 수행합니다. 기존 스크립트는 삭제하지 않습니다. 원복할 때는 기존 스크립트를 다시 활성화합니다.

Gmail 합성 자료는 저장소의 `tools/gmail2sieve/core.js`로 XML에서 생성합니다. SnappyMail 자료는 확인된 2.38.2의 메타데이터 형식에 맞춘 합성값입니다. SnappyMail 구현 코드는 포함하지 않습니다.

SnappyMail의 읽음은 JSON의 `MarkAsRead`로, 이후 규칙 멈춤은 `Stop`으로 이관합니다. 2.38.2 화면 필터에는 별표 동작이 없으므로 본문에서 별표 동작을 추론하지 않습니다. `MoveTo`와 `Keep`이 함께 있으면 폴더 이동으로 바꾸고 `changed` 및 “받은편지함에 안 남아요”를 표시합니다. Keep만 있고 다른 동작이 없으면 `unconvertible`, 이유 “동작 없음”으로 보고합니다.
