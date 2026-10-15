require ["fileinto", "imap4flags"];

# This is synthetic example.com test data.
# RAINLOOP:SIEVE
/*
BEGIN:FILTER:synthetic2
BEGIN:HEADER
eyJJRCI6InN5bnRoZXRpYzIiLCJFbmFibGVkIjp0cnVlLCJOYW1lIjoi7ZWp7ISxIOq3nOy5mS
AyIiwiQ29uZGl0aW9ucyI6W3siRmllbGQiOiJIZWFkZXIiLCJUeXBlIjoiRXF1YWxUbyIsIlZh
bHVlIjoiZGVsZXRlLW1lIiwiVmFsdWVTZWNvbmQiOiJTdWJqZWN0In1dLCJDb25kaXRpb25zVH
lwZSI6IkFsbCIsIkFjdGlvblR5cGUiOiJEaXNjYXJkIiwiQWN0aW9uVmFsdWUiOiIiLCJBY3Rp
b25WYWx1ZVNlY29uZCI6IiIsIkFjdGlvblZhbHVlVGhpcmQiOiIiLCJBY3Rpb25WYWx1ZUZvdX
J0aCI6IiIsIktlZXAiOmZhbHNlLCJTdG9wIjpmYWxzZSwiTWFya0FzUmVhZCI6ZmFsc2V9
END:HEADER
*/
if header :is ["Subject"] "delete-me" { discard; }
/* END:FILTER */
/*
BEGIN:FILTER:synthetic3
BEGIN:HEADER
eyJJRCI6InN5bnRoZXRpYzMiLCJFbmFibGVkIjpmYWxzZSwiTmFtZSI6Iu2VqeyEsSDqt5zsuZ
kgMyIsIkNvbmRpdGlvbnMiOlt7IkZpZWxkIjoiU3ViamVjdCIsIlR5cGUiOiJOb3RDb250YWlu
cyIsIlZhbHVlIjoibmV3c2xldHRlciIsIlZhbHVlU2Vjb25kIjoiIn1dLCJDb25kaXRpb25zVH
lwZSI6IkFsbCIsIkFjdGlvblR5cGUiOiJOb25lIiwiQWN0aW9uVmFsdWUiOiIiLCJBY3Rpb25W
YWx1ZVNlY29uZCI6IiIsIkFjdGlvblZhbHVlVGhpcmQiOiIiLCJBY3Rpb25WYWx1ZUZvdXJ0aC
I6IiIsIktlZXAiOmZhbHNlLCJTdG9wIjpmYWxzZSwiTWFya0FzUmVhZCI6dHJ1ZX0=
END:HEADER
*/
/* @Filter is disabled
if not header :contains ["Subject"] "newsletter" { addflag "\\Seen"; }
*/
/* END:FILTER */
