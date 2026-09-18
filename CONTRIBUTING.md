# Contributing to Yenop

Thank you for looking. Bug reports, policy ideas and test cases from real agent sessions are the most useful things you can send.

## Before you open a pull request

- Read [docs/engineering.md](docs/engineering.md). It lists the contracts that must not drift: the policy vocabulary, the versioned formats, and the fail-closed rules.
- `npm install && npm run build && npm test` must pass.
- A change to the policy vocabulary must be additive and optional, and must update `policies/schema.cedarschema`, `policies/README.md` and the tests together.
- Security-relevant changes need a test that fails without them.

## Contributor agreement

Yenop is licensed under FSL-1.1-ALv2 and will be relicensed to Apache 2.0 on schedule. To keep that possible, we ask every outside contributor to sign a short contributor license agreement before a first pull request is merged. It confirms you wrote the code and lets the project license it under these terms. We will send it when you open your first pull request.

## Reporting a vulnerability

Please do not open a public issue. Write to developer@yenop.com with the details and a way to reproduce. We will answer within three working days.
