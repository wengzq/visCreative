# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/aliuda/visCreative/security/advisories/new)). Do not open a public issue, discussion or pull request for a security problem.

Include the version or commit, the platform, the steps to reproduce and what an attacker gains. **Never include a real provider API key, Agent login file or token**, even a revoked one; describe the value's shape instead, or use a key you created for the report and have already deleted.

You will get an acknowledgement as soon as the maintainer can, and the fix and advisory are coordinated with you before anything is disclosed. visCreative is maintained by one person, so there is no fixed response time.

## Scope

In scope, in particular:

- **Credential handling**: a provider key reaching a database, config file, log, event, error message or any Agent-visible output; reading credential-store entries the app should not read.
- **Agent isolation**: an Agent escaping the macOS sandbox, or reading provider keys, studiod tokens or database files it should not reach.
- **Gateway permissions**: an Agent or session performing an action its caller or work-item relationship does not allow, or changing the author's writing, drawings or final selections without the author's action.
- **Cost limits**: bypassing daily limits, or making generation jobs repeat despite `requestId` idempotency.
- **The web UI**: executing Agent-produced HTML or script, or a local web page reaching studiod without its token.

Out of scope: problems that need an already-compromised user account or machine, and the known limitation that Windows has no Agent isolation (RFC 0022; the UI discloses it before a key is configured).

## Supported versions

Fixes land on `main` and in the next release. Older snapshots are not patched.
