const TRANSLATIONS = {
  ko: {
    // App
    app_name: "Mailcow Toolkit",

    // Dashboard
    dashboard: "대시보드",
    installed_modules: "설치된 모듈",
    module_groups: "그룹 관리",
    module_groups_desc: "시각적 계층 구조로 별칭 기반 메일 그룹 관리",
    module_syncjobs: "동기화 작업",
    module_syncjobs_desc: "IMAP 동기화 작업 일괄 생성 및 모니터링",
    module_mailboxes: "메일박스",
    module_mailboxes_desc: "CSV로 메일박스 일괄 생성 (무작위 비밀번호)",

    // Groups
    group_management: "그룹 관리",
    new_group: "+ 새 그룹",
    members: "멤버",
    inbound_addresses: "수신 주소",
    edit: "수정",
    delete: "삭제",
    add_inbound_address: "수신 주소 추가",
    no_groups_yet: "그룹이 없습니다. \"+ 새 그룹\"을 눌러 생성하세요.",
    group_name: "그룹 이름",
    domain: "도메인",
    email_forward_hint: "이 그룹으로 전달할 이메일 주소",
    add: "추가",
    none: "없음",
    edit_group: "그룹 수정",
    delete_group_confirm: "그룹 \"%s\"을(를) 삭제하시겠습니까?",
    remove_inbound_confirm: "이 수신 주소를 삭제하시겠습니까?",

    // Sync Jobs
    syncjob_management: "동기화 작업 관리",
    batch_create: "일괄 생성",
    source_host: "소스 호스트",
    port: "포트",
    encryption: "암호화",
    account_list: "계정 목록",
    account_list_hint: "형식: 소스이메일:비밀번호:대상이메일 (줄당 하나)",
    csv_upload: "CSV 업로드",
    preview: "미리보기",
    create_all: "전체 생성",
    active_sync_jobs: "활성 동기화 작업",
    refresh: "새로고침",
    source: "소스",
    destination: "대상",
    status: "상태",
    last_run: "마지막 실행",
    active: "활성",
    inactive: "비활성",
    never: "없음",
    activate: "활성화",
    deactivate: "비활성화",
    selected: "선택됨",
    preview_title: "미리보기",
    accounts: "계정",
    password: "비밀번호",
    results: "결과",
    succeeded: "성공",
    failed: "실패",
    running: "실행 중",
    pending: "대기",
    result: "결과",
    log: "로그",
    sync_log: "동기화 로그",
    no_log: "로그가 없습니다",
    close: "닫기",
    out_of: "중",
    ok: "OK",
    create_confirm: "%d개의 동기화 작업을 생성하시겠습니까?",
    mb_create_confirm: "%d개의 메일박스를 생성하시겠습니까?",
    delete_confirm: "%d개의 동기화 작업을 삭제하시겠습니까?",
    enter_account_list: "계정 목록을 먼저 입력하세요",
    no_valid_accounts: "유효한 계정이 없습니다",
    no_syncjobs_found: "동기화 작업이 없습니다",
    error_loading_syncjobs: "동기화 작업 로딩 중 오류 발생",
    csv_format_help: "CSV 형식 도움말",
    csv_format_desc: "한 줄에 하나의 계정을 입력합니다. 지원되는 형식:",
    csv_format_note: "#으로 시작하는 줄은 무시됩니다. 대상 이메일을 생략하면 소스 이메일이 대상으로 사용됩니다.",
    default_quota: "기본 용량 (MB)",
    default_name: "기본 이름",
    sj_auto_create_target: "없으면 대상 메일박스/도메인 자동 생성",
    sj_auto_password_note: "자동 생성 시, 소스 비밀번호(password1)가 새 메일박스의 비밀번호로 사용됩니다.",
    advanced_options: "고급 옵션 (선택)",
    include_folders: "포함할 폴더만 (쉼표 구분, 비우면 전체)",
    include_folders_hint: "입력 시 해당 폴더만 동기화하고 나머지는 모두 제외합니다. 아래 제외 폴더 설정보다 우선합니다.",
    exclude_folders: "제외 폴더 (정규식, 선택)",
    max_age_days: "최대 기간 (일), 0 = 전체",
    dest_subfolder: "대상 하위폴더 (선택)",

    // Mailboxes
    mailbox_management: "메일박스 관리",
    bulk_create: "일괄 생성",
    auto_create_domain: "없는 도메인 자동 생성",
    email: "이메일",
    display_name: "이름",
    quota_mb: "용량 (MB)",
    mailbox_list: "메일박스 목록",
    mailbox_list_hint: "형식: 이메일,비밀번호,이름,용량(MB) (줄당 하나). 비밀번호 비우면 무작위 생성.",
    mb_csv_format_desc: "한 줄에 메일박스 하나. 컬럼:",
    mb_csv_format_note: "비밀번호 비움 → 무작위 20자. 이름 비움 → 로컬 파트. 용량 비움 → 기본값. #으로 시작하는 줄은 무시.",
    mailboxes_word: "개 메일박스",
    copy_all_credentials: "전체 자격증명 복사",

    // Login
    login_title: "Mailcow Toolkit",
    login_subtitle: "Mailcow API 연결 확인 중...",
    login_desc: "아래 버튼을 눌러 Mailcow API 연결을 확인하고 툴킷에 접속합니다.",
    connect: "연결",
    api_key_invalid: "API 키가 유효하지 않거나 Mailcow에 연결할 수 없습니다",

    // Common
    cancel: "취소",
    save: "저장",
    loading: "로딩 중...",
    error_loading: "로딩 오류",
    error_save: "저장 중 오류가 발생했습니다",
    copied: "복사됨",
    back_to_dashboard: "← 대시보드",
  },

  en: {
    app_name: "Mailcow Toolkit",

    dashboard: "Dashboard",
    installed_modules: "Installed modules",
    module_groups: "Group Management",
    module_groups_desc: "Manage alias-based mail groups with visual hierarchy",
    module_syncjobs: "Sync Jobs",
    module_syncjobs_desc: "Batch create and monitor IMAP sync jobs",
    module_mailboxes: "Mailboxes",
    module_mailboxes_desc: "Bulk create mailboxes from CSV (random passwords)",

    group_management: "Group Management",
    new_group: "+ New Group",
    members: "Members",
    inbound_addresses: "Inbound addresses",
    edit: "Edit",
    delete: "Delete",
    add_inbound_address: "Add Inbound Address",
    no_groups_yet: 'No groups yet. Click "+ New Group" to create one.',
    group_name: "Group Name",
    domain: "Domain",
    email_forward_hint: "Email address that should forward to this group",
    add: "Add",
    none: "None",
    edit_group: "Edit Group",
    delete_group_confirm: 'Delete group "%s"?',
    remove_inbound_confirm: "Remove this inbound address?",

    syncjob_management: "Sync Job Management",
    batch_create: "Batch Create",
    source_host: "Source Host",
    port: "Port",
    encryption: "Encryption",
    account_list: "Account List",
    account_list_hint: "Format: source_email:password:destination_email (one per line)",
    csv_upload: "CSV Upload",
    preview: "Preview",
    create_all: "Create All",
    active_sync_jobs: "Active Sync Jobs",
    refresh: "Refresh",
    source: "Source",
    destination: "Destination",
    status: "Status",
    last_run: "Last Run",
    active: "Active",
    inactive: "Inactive",
    never: "Never",
    activate: "Activate",
    deactivate: "Deactivate",
    selected: "selected",
    preview_title: "Preview",
    accounts: "accounts",
    password: "Password",
    results: "Results",
    succeeded: "succeeded",
    failed: "failed",
    running: "Running",
    pending: "Pending",
    result: "Result",
    log: "Log",
    sync_log: "Sync Log",
    no_log: "No log available",
    close: "Close",
    out_of: "out of",
    ok: "OK",
    create_confirm: "Create %d sync job(s)?",
    mb_create_confirm: "Create %d mailbox(es)?",
    delete_confirm: "Delete %d sync job(s)?",
    enter_account_list: "Enter account list first",
    no_valid_accounts: "No valid accounts parsed",
    no_syncjobs_found: "No sync jobs found",
    error_loading_syncjobs: "Error loading sync jobs",
    csv_format_help: "CSV Format Help",
    csv_format_desc: "Each line represents one account to sync. Supported formats:",
    csv_format_note: "Lines starting with # are ignored. If destination is omitted, source email is used as destination.",
    default_quota: "Default Quota (MB)",
    default_name: "Default Name",
    sj_auto_create_target: "Auto-create destination mailbox/domain if missing",
    sj_auto_password_note: "When auto-creating, the source password (password1) is used as the new mailbox password.",
    advanced_options: "Advanced Options (optional)",
    include_folders: "Include only these folders (comma-separated, empty = all)",
    include_folders_hint: "When set, only these folders are synced (all others excluded). Overrides the exclude field below.",
    exclude_folders: "Exclude folders (regex, optional)",
    max_age_days: "Max age (days), 0 = all",
    dest_subfolder: "Destination subfolder (optional)",

    mailbox_management: "Mailbox Management",
    bulk_create: "Bulk Create",
    auto_create_domain: "Auto-create missing domain",
    email: "Email",
    display_name: "Name",
    quota_mb: "Quota (MB)",
    mailbox_list: "Mailbox List",
    mailbox_list_hint: "Format: email,password,name,quota_mb (one per line). Empty password → random.",
    mb_csv_format_desc: "Each line represents one mailbox. Columns:",
    mb_csv_format_note: "Empty password → randomly generated (20 chars). Empty name → local part. Empty quota → default above. Lines starting with # are ignored.",
    mailboxes_word: "mailboxes",
    copy_all_credentials: "Copy all credentials",

    login_title: "Mailcow Toolkit",
    login_subtitle: "Verifying Mailcow API connection...",
    login_desc: "Click below to verify your Mailcow API connection and enter the toolkit.",
    connect: "Connect",
    api_key_invalid: "API key invalid or Mailcow unreachable",

    cancel: "Cancel",
    save: "Save",
    loading: "Loading...",
    error_loading: "Error loading",
    error_save: "An error occurred while saving",
    copied: "Copied",
    back_to_dashboard: "← Dashboard",
  },

  ja: {
    app_name: "Mailcow Toolkit",

    dashboard: "ダッシュボード",
    installed_modules: "インストール済みモジュール",
    module_groups: "グループ管理",
    module_groups_desc: "エイリアスベースのメールグループを視覚的に管理",
    module_syncjobs: "同期ジョブ",
    module_syncjobs_desc: "IMAP同期ジョブの一括作成と監視",
    module_mailboxes: "メールボックス",
    module_mailboxes_desc: "CSVからメールボックスを一括作成（ランダムパスワード）",

    group_management: "グループ管理",
    new_group: "+ 新規グループ",
    members: "メンバー",
    inbound_addresses: "受信アドレス",
    edit: "編集",
    delete: "削除",
    add_inbound_address: "受信アドレスを追加",
    no_groups_yet: "グループがありません。「+ 新規グループ」をクリックして作成してください。",
    group_name: "グループ名",
    domain: "ドメイン",
    email_forward_hint: "このグループに転送するメールアドレス",
    add: "追加",
    none: "なし",
    edit_group: "グループを編集",
    delete_group_confirm: 'グループ「%s」を削除しますか？',
    remove_inbound_confirm: "この受信アドレスを削除しますか？",

    syncjob_management: "同期ジョブ管理",
    batch_create: "一括作成",
    source_host: "ソースホスト",
    port: "ポート",
    encryption: "暗号化",
    account_list: "アカウント一覧",
    account_list_hint: "形式: ソースメール:パスワード:宛先メール（1行ずつ）",
    csv_upload: "CSVアップロード",
    preview: "プレビュー",
    create_all: "一括作成",
    active_sync_jobs: "アクティブな同期ジョブ",
    refresh: "更新",
    source: "ソース",
    destination: "宛先",
    status: "ステータス",
    last_run: "最終実行",
    active: "アクティブ",
    inactive: "非アクティブ",
    never: "なし",
    activate: "有効化",
    deactivate: "無効化",
    selected: "件選択中",
    preview_title: "プレビュー",
    accounts: "アカウント",
    password: "パスワード",
    results: "結果",
    succeeded: "成功",
    failed: "失敗",
    running: "実行中",
    pending: "待機中",
    result: "結果",
    log: "ログ",
    sync_log: "同期ログ",
    no_log: "ログがありません",
    close: "閉じる",
    out_of: "/",
    ok: "OK",
    create_confirm: "%d件の同期ジョブを作成しますか？",
    mb_create_confirm: "%d個のメールボックスを作成しますか？",
    delete_confirm: "%d件の同期ジョブを削除しますか？",
    enter_account_list: "先にアカウント一覧を入力してください",
    no_valid_accounts: "有効なアカウントがありません",
    no_syncjobs_found: "同期ジョブがありません",
    error_loading_syncjobs: "同期ジョブの読み込みエラー",
    csv_format_help: "CSV形式ヘルプ",
    csv_format_desc: "1行に1つのアカウントを入力します。対応形式:",
    csv_format_note: "#で始まる行は無視されます。宛先を省略するとソースメールが宛先として使用されます。",
    default_quota: "デフォルト容量 (MB)",
    default_name: "デフォルト名",
    sj_auto_create_target: "宛先メールボックス/ドメインが存在しない場合は自動作成",
    sj_auto_password_note: "自動作成時、ソースパスワード（password1）が新しいメールボックスのパスワードとして使用されます。",
    advanced_options: "詳細オプション（任意）",
    include_folders: "含めるフォルダのみ（カンマ区切り、空欄で全て）",
    include_folders_hint: "指定すると該当フォルダのみ同期し、それ以外は全て除外します。下の除外フォルダ設定より優先されます。",
    exclude_folders: "除外フォルダ（正規表現、任意）",
    max_age_days: "最大期間（日）、0 = 全て",
    dest_subfolder: "宛先サブフォルダ（任意）",

    mailbox_management: "メールボックス管理",
    bulk_create: "一括作成",
    auto_create_domain: "存在しないドメインを自動作成",
    email: "メール",
    display_name: "名前",
    quota_mb: "容量 (MB)",
    mailbox_list: "メールボックス一覧",
    mailbox_list_hint: "形式: メール,パスワード,名前,容量(MB)（1行ずつ）。パスワードを空にするとランダム生成。",
    mb_csv_format_desc: "1行に1つのメールボックス。列:",
    mb_csv_format_note: "パスワード空 → ランダム生成（20文字）。名前空 → ローカル部。容量空 → 上記デフォルト。#で始まる行は無視。",
    mailboxes_word: "件のメールボックス",
    copy_all_credentials: "すべての認証情報をコピー",

    login_title: "Mailcow Toolkit",
    login_subtitle: "Mailcow API接続を確認中...",
    login_desc: "下のボタンをクリックしてMailcow API接続を確認し、ツールキットにアクセスします。",
    connect: "接続",
    api_key_invalid: "APIキーが無効か、Mailcowに接続できません",

    cancel: "キャンセル",
    save: "保存",
    loading: "読み込み中...",
    error_loading: "読み込みエラー",
    error_save: "保存中にエラーが発生しました",
    copied: "コピーしました",
    back_to_dashboard: "← ダッシュボード",
  },
};

// --- i18n Engine ---

function detectLang() {
  const saved = localStorage.getItem("toolkit-lang");
  if (saved && TRANSLATIONS[saved]) return saved;
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

let currentLang = detectLang();

function t(key, ...args) {
  let str = (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.en[key] || key;
  // Simple %s / %d substitution
  let i = 0;
  str = str.replace(/%[sd]/g, () => (i < args.length ? args[i++] : ""));
  return str;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("toolkit-lang", lang);
  document.documentElement.lang = lang;
  applyTranslations();
  // Update active button
  document.querySelectorAll(".lang-btn").forEach(btn => {
    btn.classList.toggle("lang-active", btn.dataset.lang === lang);
  });
  // Dispatch event for page-specific re-renders
  document.dispatchEvent(new CustomEvent("langchange"));
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.getAttribute("placeholder") !== null) {
        el.placeholder = val;
      } else {
        el.value = val;
      }
    } else if (el.tagName === "OPTION") {
      el.textContent = val;
    } else {
      el.textContent = val;
    }
  });
  // data-i18n-placeholder
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.lang = currentLang;
  applyTranslations();
  // Mark active language button
  document.querySelectorAll(".lang-btn").forEach(btn => {
    btn.classList.toggle("lang-active", btn.dataset.lang === currentLang);
  });
});
