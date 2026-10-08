# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through [GitHub private vulnerability reporting](https://github.com/mdevel-uy/fluke/security/advisories/new). Include a description, steps to reproduce, the affected version and, if possible, a suggested fix.

We aim to acknowledge reports within a few business days. fluke is maintained by a small team, so there is no guaranteed response time or bug bounty.

## Supported versions

Only the latest release receives security fixes.

## Scope notes

fluke runs coding agents on your machine with access to your repositories, your shell and the credentials you configure (GitHub tokens, model provider API keys). Agents execute commands and modify code on your behalf. Run it only on machines and repositories you are comfortable granting that access to, and review agent changes before merging them.
