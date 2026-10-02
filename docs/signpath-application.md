# SignPath Foundation application — values to submit

SignPath's free signing certificates are issued **to the SignPath Foundation**,
so they apply to open-source projects whose own maintainers build and sign their
own artifacts. Submitting is a manual step; this file contains every value the
form asks for.

- Application page: <https://signpath.org/apply.html>
  (also reachable from <https://signpath.io/product/open-source> → _Apply for
  free signing_)
- Conditions: <https://signpath.org/terms.html>

## Before you submit (checklist)

| Requirement                                                | Status                                               |
| ---------------------------------------------------------- | ---------------------------------------------------- |
| OSI-approved license, `LICENSE` at the repository root     | done — MIT                                           |
| Public source repository                                   | done — <https://github.com/LoopyLuci/Hermes-Manager> |
| README describes what the product is and how to build it   | done                                                 |
| Privacy statement on the project home page                 | done — see "Code signing policy" in the README       |
| Build is reproducible from source on GitHub-hosted runners | done — `.github/workflows/release.yml`               |
| **Free public download of the distribution**               | **needs one published release** (see below)          |
| MFA enabled for every team member on GitHub and SignPath   | required by the terms — enable 2FA before submitting |

## Form values

**Project / repository URL**

```
https://github.com/LoopyLuci/Hermes-Manager
```

**Project name**

```
Hermes Manager
```

**License**

```
MIT — OSI-approved. The LICENSE file is in the repository root.
```

**Download / release URL**

```
https://github.com/LoopyLuci/Hermes-Manager/releases
```

**Homepage / documentation URL**

```
https://github.com/LoopyLuci/Hermes-Manager#readme
```

**Project description**

```
Hermes Manager is a desktop control center for Hermes, an open-source AI agent.
It gives a Windows user one place to see what the agent is doing and to manage
it: live health and data-source telemetry, a log explorer with follow mode,
gateway and process control, session browsing with transcripts, a streaming
chat with the agent, a comment-preserving configuration editor for config.yaml
and .env, update management, backups with diff-and-restore, and a tools center
for MCP servers, skills, cron jobs, plugins and local models. It talks only to a
Hermes installation on the same machine over a token-protected loopback API; it
does not phone home.

Target users: developers and power users who run Hermes on Windows and want a
GUI instead of the CLI.

Artifacts published for download (all Windows x64, free):
- NSIS installer (.exe) with an install-directory chooser and desktop/Start Menu
  shortcuts
- Portable archive (.zip) that runs without installing

Built from source in CI on GitHub-hosted Windows runners. The repository
contains no proprietary code and bundles no proprietary components.
```

**Why signing is needed**

```
Windows SmartScreen shows "Unknown publisher" for unsigned installers, which
blocks adoption. Provenance attestation via GitHub artifact attestations is
already in place, but that does not establish a Windows publisher identity;
that requires an Authenticode certificate, which a CA cannot issue to an
open-source project directly. SignPath's OSS program is the intended route.
```

## Checkboxes

- Required — agree to the SignPath Foundation Code of Conduct and that the
  certificate may be revoked if the terms are violated
- Required — agree that SignPath may store and process your personal data
- Optional — agree to receive other communications from SignPath (your choice)

## Maintainer roles (also required on the project home page)

| Role                     | Members                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| Committers and reviewers | Repository maintainers: <https://github.com/orgs/LoopyLuci/teams/members>        |
| Approvers                | Repository owners: <https://github.com/LoopyLuci?tab=repositories> (role: owner) |
| Code-signing responsible | Repository owner (same person as the committers)                                 |

The README's "Code signing policy" section already states: _free code signing
provided by SignPath.io, certificate by SignPath Foundation_, these roles, and
the privacy statement.

## Build and release process

Everything below runs on GitHub-hosted Windows runners; there is no self-hosted
build infrastructure.

```powershell
git clone https://github.com/LoopyLuci/Hermes-Manager
cd Hermes-Manager
npm ci
python -m pip install fastapi uvicorn pydantic PyYAML   # bridge runtime
pwsh -File scripts/verify.ps1                           # typecheck, lint, pytest, vitest, signing self-test
npm run build                                           # electron-vite production build
npx playwright test                                     # end-to-end
npx electron-builder --win dir                          # unpacked binaries
# .github/workflows/release.yml then signs binaries + installer and publishes
```

- Version: `0.1.0`
- Signing policy requested: `release-signing`
  - Approval process: **enabled, 1 approval** (per release, by an owner)
  - Origin verification: enabled, repository
    `https://github.com/LoopyLuci/Hermes-Manager`, branches `main`
  - Trusted build system: GitHub.com, GitHub-hosted runners only
- Signed artifacts: `HermesManager-<version>-x64.exe` (installer),
  `HermesManager-<version>-x64.zip`, and every executable inside
  `dist/win-unpacked` (application, uninstaller, `elevate.exe`).

## The one open prerequisite

The terms require the project to **already be released** in the form that
should be signed. There is currently no public release, so the download URL
above has nothing behind it yet.

The intended sequence is:

1. Publish the first release. Until SignPath is active it cannot carry an
   Authenticode signature; it does carry a GitHub artifact attestation, so
   provenance is verifiable from the first upload. Say so plainly on the
   download page — "rollout in progress" — rather than claiming it is signed.
2. Submit this application.
3. On approval: install the SignPath GitHub App, create the project and the
   `release-signing` policy, run `scripts/setup-signing.ps1`.
4. Tag the next version. The release workflow signs every binary, verifies the
   Authenticode status, and refuses to publish anything unsigned.

The release workflow will not publish unsigned artifacts unless
`ALLOW_UNSIGNED_RELEASE=true` is set as a repository variable, which is
currently **not** set.

## After approval

```powershell
# one-time repository configuration
pwsh -NoProfile -File scripts/setup-signing.ps1 `
  -ApiToken '<token>' -OrganizationId '<org id>' `
  -ProjectSlug 'hermes-manager' -SigningPolicySlug 'release-signing'

# cut a signed release
git tag -a v0.1.1 -m "Hermes Manager v0.1.1"
git push origin v0.1.1
```

Then approve the two signing requests (binaries, then installer) in SignPath.
