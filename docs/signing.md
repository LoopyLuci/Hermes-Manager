# Code signing

Hermes Manager releases are signed with [SignPath](https://signpath.io/). Free
code signing for open-source projects is provided by SignPath.io with a
certificate issued to the SignPath Foundation; every release is approved by a
human in SignPath before the certificate is used.

## How a release gets signed

`.github/workflows/release.yml` performs, in order:

1. **Verify** – lint, format, typecheck, pytest, vitest, build, Playwright e2e.
2. **Package unsigned** – `electron-builder --win dir` produces
   `dist/win-unpacked`.
3. **Upload** the unpacked `*.exe` files as a GitHub Actions artifact.
4. **Sign** them with the official SignPath action
   (`signpath/github-action-submit-signing-request`), using the artifact ID
   from step 3. This is the _trusted build_ path: SignPath receives the origin
   metadata (repository, branch, commit, workflow run) from GitHub itself, so a
   signed binary provably came from this repository's workflow.
5. **Repackage** – `electron-builder --win nsis zip --prepackaged
dist/win-unpacked` builds the installer from the **signed** directory, so the
   installed application itself carries a valid signature.
6. **Upload → sign → download** the installer the same way.
7. **Verify** the Authenticode status of every shipped binary, then publish the
   GitHub Release with the installer, portable zip, `latest.yml` and blockmaps.

Step 4 and step 6 each produce a _waiting for approval_ signing request. Approve
them in the SignPath web interface (or via the SignPath REST API); the workflow
keeps polling and finishes automatically once the request reaches `Completed`.

## One-time SignPath onboarding

1. Create a SignPath account and organization, then apply for the
   **Open Source Code Signing** plan. Requirements are listed in the
   [SignPath Foundation conditions](https://signpath.org/terms.html):
   an OSI-approved license (this project uses MIT), a public repository, no
   proprietary code, an existing release, and documented functionality.
2. Create a **project** for this repository:
   - Slug: `hermes-manager`
   - Repository URL: `https://github.com/LoopyLuci/Hermes-Manager`
   - Link the predefined trusted build system **GitHub.com** to the project.
3. Install the **SignPath GitHub App** on `LoopyLuci/Hermes-Manager` and grant
   access to the repository (required for origin verification).
4. Create a **signing policy**:
   - Slug: `release-signing`
   - Purpose: _release signing_
   - Certificate: the one issued to your organization
   - **Approval process: enabled, 1 approval** (required by the OSS terms)
   - Restrict to the trusted build system / GitHub-hosted runners
   - Origin verification: repository `LoopyLuci/Hermes-Manager`, branch `main`
     or `v*` tags
   - Submitters: the CI user whose API token you use below
5. Create an **artifact configuration** (optional, only if you need SignPath to
   enforce product metadata): product name `Hermes Manager`, version from the
   build. Leave empty to use the project default.
6. Create an API token for the submitting user
   (SignPath → _Organization settings → API tokens_) and store it below.

## Repository configuration

| Name                            | Kind     | Value                                                   |
| ------------------------------- | -------- | ------------------------------------------------------- |
| `SIGNPATH_API_TOKEN`            | secret   | API token of the submitting user                        |
| `SIGNPATH_ORGANIZATION_ID`      | variable | Organization id (SignPath → organization settings)      |
| `SIGNPATH_PROJECT_SLUG`         | variable | `hermes-manager`                                        |
| `SIGNPATH_SIGNING_POLICY_SLUG`  | variable | `release-signing`                                       |
| `SIGNPATH_ARTIFACT_CONFIG_SLUG` | variable | Optional; only if you created an artifact configuration |

Set them with:

```powershell
gh secret set SIGNPATH_API_TOKEN
gh variable set SIGNPATH_ORGANIZATION_ID --body '<organization id>'
gh variable set SIGNPATH_PROJECT_SLUG --body 'hermes-manager'
gh variable set SIGNPATH_SIGNING_POLICY_SLUG --body 'release-signing'
```

Without `SIGNPATH_API_TOKEN` the release workflow refuses to publish unless you
explicitly opt in with `ALLOW_UNSIGNED_RELEASE=true` (used for the very first
release, which SignPath requires to exist before a project can be approved).

## Signing locally

`scripts/sign.ps1` talks to the same REST API directly, which is handy for
signing an artifact you built on your own machine:

```powershell
$env:SIGNPATH_API_TOKEN = '...'
$env:SIGNPATH_ORGANIZATION_ID = '...'
$env:SIGNPATH_PROJECT_SLUG = 'hermes-manager'
$env:SIGNPATH_SIGNING_POLICY_SLUG = 'test-signing'
pwsh -NoProfile -File scripts/sign.ps1 -Path 'dist/*.exe'
```

Flow: `POST /SigningRequests/SubmitWithArtifact` → poll
`GET /SigningRequests/{id}` until `isFinalStatus` → download
`GET /SigningRequests/{id}/SignedArtifact` → validate with
`Get-AuthenticodeSignature`. Requests submitted this way carry no origin
verification, so use a `test-signing` policy; releases go through the workflow.

## Verifying a download

```powershell
Get-AuthenticodeSignature .\HermesManager-0.1.0-x64.exe | Select-Object Status, SignerCertificate
```

`Status` must be `Valid`. Windows will then show the publisher instead of
"Unknown publisher".
