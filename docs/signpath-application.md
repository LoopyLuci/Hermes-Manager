# SignPath open-source application (copy-paste)

SignPath's free signing certificates are issued **to the SignPath Foundation**, so
they apply to open-source projects whose maintainers build and sign their own
artifacts. This document contains everything the application form asks for.

## Project

| Field                | Value                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project name         | Hermes Manager                                                                                                                                                                                                                                                                                                  |
| Project slug         | `hermes-manager`                                                                                                                                                                                                                                                                                                |
| Repository URL       | https://github.com/LoopyLuci/Hermes-Manager                                                                                                                                                                                                                                                                     |
| License              | MIT (see `LICENSE` in the repository)                                                                                                                                                                                                                                                                           |
| Language             | TypeScript, Python                                                                                                                                                                                                                                                                                              |
| Description          | Desktop control center for Hermes: live telemetry, log explorer, gateway and process control, session browser, streaming chat, comment-preserving config editor, updates, backups, and a tools center (MCP servers, skills, cron jobs, plugins, local models). Ships as a Windows installer and a portable zip. |
| Download page / docs | https://github.com/LoopyLuci/Hermes-Manager#readme                                                                                                                                                                                                                                                              |

## Maintainer roles

| Role                     | Members                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| Committers and reviewers | Repository maintainers: https://github.com/orgs/LoopyLuci/teams/members        |
| Approvers                | Repository owners: https://github.com/LoopyLuci?tab=repositories (role: owner) |
| Code-signing responsible | Repository owner (same person as the committers)                               |

## Build and release process

Everything below runs on GitHub-hosted Windows runners; no proprietary code and
no self-hosted build infrastructure is involved.

```powershell
git clone https://github.com/LoopyLuci/Hermes-Manager
cd Hermes-Manager
npm ci
python -m pip install fastapi uvicorn pydantic PyYAML   # bridge runtime
pwsh -File scripts/verify.ps1                           # typecheck, lint, pytest, vitest
npm run build                                           # electron-vite production build
npx playwright test                                     # end-to-end
npx electron-builder --win dir                          # unpacked binaries
# then the release workflow signs the binaries and the installer with SignPath
```

- Version: `0.1.0`
- Signing policy requested: `release-signing`
  - Approval process: **enabled, 1 approval** (per-release, by an owner)
  - Origin verification: enabled, repository
    `https://github.com/LoopyLuci/Hermes-Manager`, branches `main`
  - Trusted build system: GitHub.com, GitHub-hosted runners only
- Signed artifacts: `HermesManager-<version>-x64.exe` (NSIS installer),
  `HermesManager-<version>-x64.zip`, and every executable inside
  `dist/win-unpacked` (including the uninstaller and `elevate.exe`).

## Privacy statement

This program will not transfer any information to other networked systems unless
specifically requested by the user or the person installing or operating it.
SignPath receives only the binary that is submitted for signing plus the origin
metadata GitHub attaches to the build (repository, branch, commit, workflow run).

## Other components

Hermes Manager bundles no proprietary third-party components. It uses
Electron, React, TanStack Virtual (all MIT) and a local FastAPI bridge that talks
to a user-provided Hermes installation. The Hermes agent itself is not
redistributed and is not signed with this subscription.

## After approval

1. Install the SignPath GitHub App on `LoopyLuci/Hermes-Manager`.
2. Create the API token for the submitting user.
3. Configure the repository:

   ```powershell
   pwsh -NoProfile -File scripts/setup-signing.ps1 `
     -ApiToken '<token>' -OrganizationId '<org id>' `
     -ProjectSlug 'hermes-manager' -SigningPolicySlug 'release-signing'
   ```

4. Cut the release tag; the workflow signs the binaries and the installer and
   refuses to publish anything unsigned:

   ```powershell
   git tag -a v0.1.0 -m "Hermes Manager v0.1.0"
   git push origin v0.1.0
   ```

5. Approve the two signing requests (binaries, then installer) in SignPath.
