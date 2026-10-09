# Console distribution

This release pipeline packages only `tools/fluke-console-go`. It is independent
of the Rust/web desktop release. The initial npm name is `@mdevel/fluke`; confirm
ownership of the npm scope before publishing. Update the package manifest and
npm README together if that name changes.

## What a release contains

- Windows, Linux and macOS executables for amd64/x64 and arm64.
- Six `.tar.gz` archives, with the executable, README and license notices.
- One npm `.tgz` containing all six executables and a platform-selecting launcher.
- SHA256 checksums for every downloadable archive and npm package.

Including all executables makes the npm package larger but avoids install-time
downloads, lifecycle install scripts and separate platform package publications.
There is no runtime Go dependency. The npm launcher requires Node 22+; native
archives run without Node. On Windows, extract archives with `tar -xzf FILE`.
The executable is `fluke.exe`; on Linux/macOS it is `fluke`.

## Local build

Install Go matching `../go.mod`, Node 22+, npm and tar. From the repository root:

```sh
node --test tools/fluke-console-go/distribution/distribution.test.mjs
node tools/fluke-console-go/distribution/build-all.mjs dist/console-binaries
node tools/fluke-console-go/distribution/package.mjs dist/console-binaries dist/console-release
npm install -g --prefix /tmp/fluke-install dist/console-release/*.tgz
/tmp/fluke-install/bin/fluke --version
```

`package.mjs` requires a new output directory and all six binaries, to prevent
mixing releases. The optional last argument of both scripts is the release
version; by default it comes from `npm/package.json`. Supported versions are
`X.Y.Z`, `X.Y.Z-alpha.N`, `X.Y.Z-beta.N` and `X.Y.Z-rc.N`.

## First release

For testing a corrected build on the current machine before all six release
binaries are available, use `package-local.mjs` instead of `package.mjs`. It
creates a private, single-platform package that npm cannot publish. This package
is for local testing only and does not certify the other platforms.

1. Commit the distribution files and the shared Go test-helper fix. Make the
   release workflow available on the repository's default branch, keeping the
   console source on the branch/ref that is being released.
2. In Actions, run **Fluke Console Release** against that ref with the chosen
   version, **dry_run=true**, and **publish_npm=false**. Inspect the build/test
   results on all three native runners and download the `console-release`
   artifact. ARM binaries are cross-built; the workflow smoke-tests only the
   native runner architecture. Interactive terminals and agent sessions still
   require testing on target machines.
3. Once reviewed, rerun with **dry_run=false**, **publish_npm=false** to create
   `console-vVERSION` and its public GitHub release. The repository must be
   public for anonymous downloads. Alternatively, pushing a `console-vVERSION`
   tag builds/tests and publishes the GitHub release automatically.
4. For the first npm publication, sign in locally with `npm login`, verify
   `npm whoami` and access to the chosen scope, then publish the reviewed `.tgz`:

   ```sh
   npm publish ./mdevel-fluke-0.1.0-beta.1.tgz --access public --tag beta
   ```

   The npm account owner must complete login/2FA. Do not put tokens in this repo.
5. In that npm package's settings, configure a GitHub Actions trusted publisher:
   owner **mdevel-uy**, repository **fluke**, workflow **release-console.yml**,
   and no environment name (unless one is later added to the workflow).
   Subsequent manual releases can enable **publish_npm=true**; publishing uses
   OIDC rather than a saved npm token. Set it only after the publisher exists.

Versions containing alpha/beta/rc use the npm `beta` tag; stable releases use
`latest`. Until a stable release exists, users install with
`npm install -g @mdevel/fluke@beta`. Existing releases/versions are not overwritten.
If npm publication fails after the GitHub release succeeds, download that
release's `.tgz` and publish it manually; do not recreate the release.

Trusted publishing requirements:
https://docs.npmjs.com/trusted-publishers/

## Next channels

Homebrew, WinGet, Chocolatey and apt can reference this same release version.
They are not published by this workflow. apt also needs a signed repository
and hosting; a `.deb` alone does not provide `apt install fluke` by package name.
