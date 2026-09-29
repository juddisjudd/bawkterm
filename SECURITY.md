# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use **Security → Report a vulnerability** on this repository's GitHub page. Include what you found, how to reproduce it, and which version you tested (shown at the bottom of the settings screen).

You should get a first answer within a week. Fixes ship as a new release, and the release notes credit you unless you prefer otherwise.

## Scope

In scope: the bawkterm app in this repository, including how it stores and syncs data.

For the sync server, report to [bawksync](https://github.com/juddisjudd/bawksync).

Out of scope, because the app does not claim to defend against them (see "What bawkterm does not protect against" in the [README](README.md)):

- Attacks that need malware already running as your Windows user.
- Access to a device while the vault is unlocked.
- A leaked sync link or server token.

## Supported versions

Only the latest release gets security fixes.
