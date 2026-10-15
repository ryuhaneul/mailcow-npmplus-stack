# unknown example.com format
require ["fileinto"];
if header :contains "subject" "a" { fileinto "Archive"; }
