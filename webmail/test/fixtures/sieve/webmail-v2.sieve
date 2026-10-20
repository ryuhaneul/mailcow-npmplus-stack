# WEBMAIL-RULES 1 — 웹메일이 만든 필터입니다. 여기서 직접 고치면 웹메일에서 규칙을 고칠 수 없게 됩니다.
# WEBMAIL-DATA eyJibG9ja2VkIjpbXSwicmV2IjozLCJydWxlcyI6W3siYWN0aW9ucyI6eyJtb3ZlIjoiUHJvamVjdHMifSwiY29uZGl0aW9ucyI6W3siY29uZGl0aW9ucyI6
# WEBMAIL-DATA W3siZmllbGQiOiJmcm9tIiwib3AiOiJtYXRjaGVzIiwidmFsdWUiOiIqQHBhcnRuZXIuZXhhbXBsZS5jb20ifSx7ImZpZWxkIjoic3ViamVjdCIsIm9wIjoi
# WEBMAIL-DATA aGFzIiwidmFsdWUiOiJTeW50aGV0aWMgbWVldGluZyJ9XSwibWF0Y2giOiJhbnkifSx7ImZpZWxkIjoic3ViamVjdCIsIm9wIjoibm90IiwidmFsdWUiOiJT
# WEBMAIL-DATA eW50aGV0aWMgc3BhbSJ9XSwiZW5hYmxlZCI6dHJ1ZSwiaWQiOiJydWxlMDAwMSIsIm1hdGNoIjoiYWxsIiwic3RvcCI6ZmFsc2V9XSwidiI6MiwidmFjYXRp
# WEBMAIL-DATA b24iOnsiYm9keSI6IiIsImVuYWJsZWQiOmZhbHNlLCJlbmQiOm51bGwsInN0YXJ0IjpudWxsLCJzdWJqZWN0IjoiIn19
# WEBMAIL-HASH 6da2a76553f7cb8d718755b8ee36ade6e2c072593090cf7e9df903ecf7b2ff7f
require ["fileinto", "imap4flags", "variables", "copy", "vacation", "date", "relational"];
if not header :is "X-Spam-Flag" "YES" {
  set "wm_stop" "0";
  set "wm_folder" "";
  set "wm_trash" "0";
  # 규칙 1: (보낸 사람 또는 제목) 및 제목
  if allof(not string :is "${wm_stop}" "1", allof(anyof(address :all :matches "from" "*@partner.example.com", header :contains "subject" "Synthetic meeting"), not header :contains "subject" "Synthetic spam")) {
    if string :is "${wm_folder}" "" { set "wm_folder" "Projects"; }
  }
  if string :is "${wm_trash}" "1" { fileinto "Trash"; }
  elsif not string :is "${wm_folder}" "" { fileinto "${wm_folder}"; }
}
