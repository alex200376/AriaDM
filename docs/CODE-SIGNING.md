# Code signing

## What the warning is, and what actually removes it

AriaDM's installer is not signed, so Windows SmartScreen shows "Windows protected
your PC" on first download. That warning comes from the file having no publisher
reputation, and per Microsoft's current guidance a certificate changes it only
slowly:

| Option | Cost | SmartScreen |
| --- | --- | --- |
| Microsoft Store (MSIX) | free | no warning at all — Microsoft re-signs the package |
| Azure Artifact Signing | ~$9.99/month | reputation builds over time; initial warnings expected |
| OV certificate | $150–300/year | same as above |
| EV certificate | $400+/year | **no longer** bypasses SmartScreen (changed in 2024) |
| Self-signed certificate | free | blocks installation for everyone else |
| No signature | free | strong SmartScreen block |

So there is no switch that removes the warning on the next release. Signing with a
consistent identity is what makes it fade, release by release. The one exception
is Store distribution: package as MSIX and Microsoft signs it, at the cost of
shipping updates through the Store instead of this app's own updater.

Azure Artifact Signing is not available from Taiwan (individuals are limited to
the USA and Canada, and organizations to the USA, Canada, the EU and the UK),
which is why the free **SignPath Foundation** route is the plan here.

## Applying to SignPath Foundation

SignPath Foundation signs qualifying open-source projects for free, with an
OV-level certificate held in their HSM — no key or token here.

1. Make sure the repository has an OSI-approved license. This project is MIT (see
   [`LICENSE`](../LICENSE)); that file is the prerequisite, not a formality.
2. Apply at <https://signpath.org/open-source> with the repository URL, the
   license, and a short description of what the project is. A project with real
   releases and users is looked on more favourably than an empty repository, so it
   is worth applying after a few releases rather than on day one.
3. Once accepted, create a project in SignPath, link this GitHub repository, and
   create a *signing policy* (the usual name is `release-signing`) plus an
   *artifact configuration* that signs the PE files inside the built installers.
4. Add the credentials to the repository: `SIGNPATH_API_TOKEN` and
   `SIGNPATH_ORGANIZATION_ID` as secrets, and `SIGNPATH_PROJECT_SLUG`,
   `SIGNPATH_SIGNING_POLICY_SLUG` and `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` as
   variables. [`.github/workflows/build.yml`](../.github/workflows/build.yml)
   picks them up automatically and skips the signing step while they are absent.
5. The published signature will read **SignPath Foundation**, not this project.
   That is how their free tier works.

## Signing locally (OV certificate)

electron-builder signs as soon as it is given a certificate, with no config
change:

```powershell
$env:CSC_LINK = 'C:\path\to\certificate.pfx'   # or a base64 blob
$env:CSC_KEY_PASSWORD = '...'
npm run dist
```

[`electron-builder.yml`](../electron-builder.yml) already pins SHA-256 and an
RFC 3161 timestamp server, so a signed release stays verifiable after the
certificate expires. `npm run sign:verify` reports the status and signer of every
installer in `dist/`, and fails only for a signature that exists but does not
verify.

## What the app itself checks

The updater downloads an executable and runs it silently, so it verifies the
downloaded installer's Authenticode signature before launching it: same publisher
as the running build, and a valid signature. That check is skipped while the
running build is unsigned — there is nothing to compare against — and turns on by
itself as soon as releases are signed (see
[`src/main/update/signature.ts`](../src/main/update/signature.ts)).

A rejected installer is never run, the app stays open, and the reason is written
to `update.log` next to `settings.json`.
