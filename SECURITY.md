# Security reporting

Do not place credentials, personal data or exploit details in public issues.

Use [the repository's private vulnerability report page](https://github.com/FanJine-ai/fanjin/security/advisories/new) when it is available. If that feature is unavailable, open [a public contact request](https://github.com/FanJine-ai/fanjin/issues/new?title=Private%20security%20contact%20requested) containing only “Private security contact requested”, with no vulnerability details, and wait for a maintainer to establish a private channel. A dedicated security mailbox is not currently published; none is implied or invented here.

Only test systems you own or are authorized to test. Report the affected version, sanitized reproduction and impact privately. Keep real model keys and `.fanjin-data/` outside Git. The local profile binds to loopback; do not expose it directly to the Internet.
