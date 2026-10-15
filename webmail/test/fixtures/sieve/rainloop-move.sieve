require ["fileinto", "imap4flags"];

# This is synthetic example.com test data.
# RAINLOOP:SIEVE
/*
BEGIN:FILTER:synthetic1
BEGIN:HEADER
eyJJRCI6InN5bnRoZXRpYzEiLCJFbmFibGVkIjp0cnVlLCJOYW1lIjoi7ZWp7ISxIOq3nOy5mS
AxIiwiQ29uZGl0aW9ucyI6W3siRmllbGQiOiJGcm9tIiwiVHlwZSI6IkNvbnRhaW5zIiwiVmFs
dWUiOiJzZW5kZXJAZXhhbXBsZS5jb20iLCJWYWx1ZVNlY29uZCI6IiJ9XSwiQ29uZGl0aW9uc1
R5cGUiOiJBbGwiLCJBY3Rpb25UeXBlIjoiTW92ZVRvIiwiQWN0aW9uVmFsdWUiOiJBcmNoaXZl
IiwiQWN0aW9uVmFsdWVTZWNvbmQiOiIiLCJBY3Rpb25WYWx1ZVRoaXJkIjoiIiwiQWN0aW9uVm
FsdWVGb3VydGgiOiIiLCJLZWVwIjpmYWxzZSwiU3RvcCI6dHJ1ZSwiTWFya0FzUmVhZCI6dHJ1
ZX0=
END:HEADER
*/
if header :contains ["From"] "sender@example.com" {
    addflag "\\Seen";
    fileinto "Archive";
    stop;
}

/* END:FILTER */
