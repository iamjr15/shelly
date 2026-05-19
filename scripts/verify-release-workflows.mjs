#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const workflows = {
  ci: read(".github/workflows/ci.yml"),
  rust: read(".github/workflows/release-rust.yml"),
  npm: read(".github/workflows/release-npm.yml"),
  ios: read(".github/workflows/release-ios.yml"),
  android: read(".github/workflows/release-android.yml"),
  relay: read(".github/workflows/deploy-relay.yml"),
  site: read(".github/workflows/deploy-site.yml"),
  versionPackages: read(".github/workflows/version-packages.yml"),
  dependabot: read(".github/dependabot.yml"),
};
const distConfig = read("dist-workspace.toml");
const siteConfig = read("site/astro.config.mjs");
const iosProject = read("apps/ios/Fieldwork.xcodeproj/project.pbxproj");

verifyRustRelease(workflows.rust);
verifyNpmRelease(workflows.npm);
verifyChangesetsVersionWorkflow(workflows.versionPackages);
verifyIosRelease(workflows.ios, iosProject);
verifyAndroidRelease(workflows.android);
verifyRelayDeploy(workflows.relay);
verifySiteDeploy(workflows.site, siteConfig);
verifyDependabot(workflows.dependabot);
verifyCiWiresVerifier(workflows.ci);
verifyCargoDistArchiveOnly(distConfig);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("release workflows ok");

function verifyRustRelease(text) {
  requireText(text, "id-token: write", "release-rust must be allowed to produce Sigstore attestations");
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    requireText(text, `package: ${platform}`, `release-rust matrix is missing ${platform}`);
  }
  requireText(text, "sigstore/cosign-installer@v3", "release-rust must install cosign");
  requireText(text, "cargo install apple-codesign --locked", "release-rust must install locked rcodesign");
  requireText(text, "Verify relay-only provider secret boundary", "release-rust must run provider secret-boundary verifier after build");
  requireText(text, "node scripts/verify-secret-boundaries.mjs", "release-rust must run provider secret-boundary verifier");
  requireText(text, "node scripts/verify-telemetry-privacy.mjs", "release-rust must run telemetry privacy verifier");
  for (const secret of ["APPLE_P12_BASE64", "APPLE_P12_PASSWORD", "APP_STORE_KEY_JSON"]) {
    requireText(text, secret, `release-rust must require ${secret} for Darwin signing`);
  }
  requireText(text, "exit 1", "release-rust signing steps must fail closed when required secrets are absent");
  requireText(text, 'signing_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fieldwork-signing.XXXXXX")"', "release-rust must decode Apple signing/notarization assets outside the repository workspace");
  requireText(text, 'trap \'rm -rf "$signing_dir" target/${{ matrix.target }}/release/fieldworkd.zip\' EXIT', "release-rust must clean decoded Apple signing/notarization assets");
  requireText(text, 'chmod 600 "$cert_path" "$app_store_key_path"', "release-rust must restrict decoded Apple signing/notarization assets");
  requireText(text, '--p12-file "$cert_path"', "release-rust must sign from the temporary certificate path");
  requireText(text, '--api-key-path "$app_store_key_path"', "release-rust must notarize from the temporary App Store key path");
  requireText(text, "--code-signature-flags runtime", "release-rust must sign macOS daemon with hardened runtime");
  requireText(text, "target/${{ matrix.target }}/release/fieldworkd", "release-rust must sign the daemon binary");
  requireText(text, "rcodesign notary-submit", "release-rust must submit macOS daemon for notarization");
  requireText(text, "--wait --staple", "release-rust notarization must wait and staple");
  requireText(text, "codesign --verify", "release-rust must verify the signed daemon");
  for (const binary of ["fieldwork", "fieldworkd"]) {
    requireText(text, `cp target/\${{ matrix.target }}/release/${binary}`, `release-rust archive must include ${binary}`);
  }
  requireText(text, "LC_ALL=C LANG=C shasum -a 256", "release-rust must write archive SHA-256 files under a macOS-safe locale");
  requireText(text, "https://slsa.dev/provenance/v1", "release-rust must write an SLSA predicate");
  requireText(text, "\"releaseTag\": \"${GITHUB_REF_NAME}\"", "release-rust must write the triggering ref name into SLSA releaseTag");
  requireText(text, "cosign attest-blob", "release-rust must attest release archives");
  requireText(text, "--type slsaprovenance1", "release-rust cosign attestations must use SLSA provenance type");
  requireText(text, "--bundle fieldwork-${{ matrix.package }}.tar.gz.bundle", "release-rust must upload Sigstore bundles");
  requireText(text, "softprops/action-gh-release@v2", "release-rust must upload GitHub Release audit artifacts");
}

function verifyNpmRelease(text) {
  requireText(text, "workflow_run", "release-npm must publish from completed release-rust workflow runs");
  requireText(text, "Release Rust Artifacts", "release-npm must depend on the Rust artifact workflow");
  requireText(text, "id-token: write", "release-npm must allow npm provenance");
  requireText(text, "sigstore/cosign-installer@v3", "release-npm must install cosign for attestation verification");
  requireText(text, "FIELDWORK_VERIFY_COSIGN_SIGNATURE: \"1\"", "release-npm must require cosign verification");
  requireText(text, "FIELDWORK_RELEASE_REPOSITORY: ${{ github.repository }}", "release-npm must verify SLSA buildType against the checked-out repository");
  requireText(text, "FIELDWORK_EXPECTED_RELEASE_TAG: ${{ github.event.inputs.tag }}", "release-npm manual dispatch must pin SLSA releaseTag to the requested GitHub Release tag");
  requireText(text, "FIELDWORK_COSIGN_IDENTITY_REGEXP", "release-npm must pin the release-rust workflow identity");
  requireText(text, "FIELDWORK_COSIGN_IDENTITY_REGEXP: '^https://github.com/${{ github.repository }}/\\.github/workflows/release-rust\\.yml@refs/tags/v.*$'", "release-npm must derive the cosign identity from the checked-out repository");
  requireText(text, "node scripts/verify-release-artifacts.mjs", "release-npm must verify archive checksums and attestations");
  requireText(text, "node scripts/prepare-npm-artifacts.mjs", "release-npm must stage verified binaries into npm packages");
  requireText(text, "node scripts/verify-npm-packages.mjs --require-binaries", "release-npm must verify package binaries before publish");
  rejectText(text, "pnpm install --no-frozen-lockfile", "release-npm must not create a transient unpinned root install before provenance publish");
  rejectText(text, "rm -f pnpm-lock.yaml", "release-npm must not create and delete a transient root lockfile");
  requireText(text, "Verify npm token", "release-npm must fail closed before artifact work when NPM_TOKEN is absent");
  requireText(text, "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}", "release-npm must publish with the npm token secret");
  requireText(text, "NPM_TOKEN is required to publish Fieldwork npm packages.", "release-npm missing-token failure must explain the external publish gate");
  requireText(text, "node scripts/publish-npm-packages.mjs", "release-npm must use the repo-owned children-first publish script");
  requireText(text, "Verify npm registry after publish", "release-npm must verify npm registry state after publish");
  requireText(text, "require('./packages/cli/package.json').version", "release-npm must derive the post-publish npm version from the meta package");
  requireText(text, "--expect-meta-published", "release-npm must verify the meta package after publish");
  requireText(text, "--expect-platform-published", "release-npm must verify all platform children after publish");
  requireText(text, "--expect-latest-version=\"$version\"", "release-npm must verify the published latest dist-tag version");
  requireText(text, "--expect-provenance", "release-npm must verify public npm provenance metadata after publish");
  requireText(text, "for attempt in {1..12}", "release-npm must retry npm registry propagation before failing");
}

function verifyChangesetsVersionWorkflow(text) {
  requireText(text, "name: Version Packages", "version-packages workflow must exist");
  requireText(text, "branches: [main]", "version-packages workflow must run on main");
  requireText(text, "contents: write", "version-packages workflow must be allowed to push version branches");
  requireText(text, "pull-requests: write", "version-packages workflow must be allowed to open version PRs");
  requireText(text, "node scripts/verify-changesets-config.mjs", "version-packages workflow must verify the fixed package group before action runs");
  requireText(text, "changesets/action@v1", "version-packages workflow must use changesets/action@v1");
  requireText(text, "version: pnpm --package @changesets/cli@2.29.7 --package @changesets/changelog-github@0.5.1 dlx changeset version", "changesets/action must run pinned Changesets packages without a mutable root install");
  requireText(text, "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}", "changesets/action must use the repository GitHub token");
  rejectText(text, "pnpm install --no-frozen-lockfile", "version-packages workflow must not create a transient unpinned root install");
  rejectText(text, "pnpm install --frozen-lockfile", "version-packages workflow must not rely on a root lockfile for package versioning");
  rejectText(text, "publish: pnpm", "version-packages workflow must not publish packages");
  rejectText(text, "node scripts/publish-npm-packages.mjs", "version-packages workflow must leave npm publishing to release-npm.yml");
}

function verifyIosRelease(text, projectText) {
  requireText(text, "runs-on: macos-26", "release-ios must run on the Xcode 26-capable runner");
  requireText(text, "FIELDWORK_IOS_RELEASE_XCODE_MAJOR: \"26\"", "release-ios must enforce Xcode 26+");
  requireText(text, "FIELDWORK_IOS_RELEASE_SDK_MAJOR: \"26\"", "release-ios must enforce iOS SDK 26+");
  requireText(text, "scripts/check-ios-prereqs.sh --release", "release-ios must verify the release Xcode/iOS SDK floor");
  requireText(text, "node scripts/verify-mobile-privacy.mjs", "release-ios must run mobile privacy verifier");
  requireText(text, "node scripts/verify-store-privacy.mjs", "release-ios must run store privacy verifier");
  requireText(text, "node scripts/verify-telemetry-privacy.mjs", "release-ios must run telemetry privacy verifier");
  requireText(text, "apps/ios/scripts/build-rust.sh", "release-ios must build the Rust xcframework");
  requireText(text, "Verify xcframework slices", "release-ios must verify xcframework slices");
  for (const secret of [
    "SENTRY_DSN",
    "IOS_DISTRIBUTION_CERTIFICATE_BASE64",
    "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD",
    "IOS_PROVISIONING_PROFILE_BASE64",
    "IOS_DEVELOPMENT_TEAM",
    "IOS_EXPORT_OPTIONS_PLIST",
    "APP_STORE_KEY_JSON",
  ]) {
    requireText(text, secret, `release-ios must require ${secret}`);
  }
  requireText(text, "chmod 600 \"$cert_path\" \"$profile_path\"", "release-ios must restrict decoded signing asset permissions");
  requireText(text, "app.fieldwork.ios", "release-ios must reject provisioning profiles for the wrong bundle id");
  requireText(text, "aps-environment", "release-ios must verify APNs entitlement in provisioning profile");
  requireText(text, "production", "release-ios must require production APNs entitlement");
  requireText(text, "CODE_SIGN_STYLE=Manual", "release-ios must use manual App Store signing");
  requireText(text, "CODE_SIGN_IDENTITY=\"Apple Distribution\"", "release-ios must use Apple Distribution signing identity");
  requireText(text, "FIELDWORK_SKIP_RUST_BUILD: \"1\"", "release-ios archive must reuse the verified xcframework build");
  requireText(projectText, 'if [ \\"${FIELDWORK_SKIP_RUST_BUILD:-}\\" != \\"1\\" ]; then', "iOS Xcode project must honor FIELDWORK_SKIP_RUST_BUILD before running the Rust build phase");
  requireText(projectText, '${SRCROOT}/scripts/build-rust.sh', "iOS Xcode project must run the repo-owned Rust build script when the skip flag is absent");
  requireText(text, "plutil -lint ExportOptions.plist", "release-ios must lint export options before export");
  requireText(text, "xcrun altool --upload-app", "release-ios must upload the signed IPA to TestFlight");
  requireText(text, 'app_store_key_json="$RUNNER_TEMP/fieldwork-app-store-key.json"', "release-ios must keep App Store Connect JSON outside the repository workspace");
  requireText(text, 'chmod 600 "$app_store_key_json"', "release-ios must restrict App Store Connect JSON permissions");
  requireText(text, 'app_store_private_key="$HOME/.appstoreconnect/private_keys/AuthKey_${key_id}.p8"', "release-ios must write the App Store Connect private key to the expected altool path");
  requireText(text, 'chmod 600 "$app_store_private_key"', "release-ios must restrict App Store Connect private key permissions");
  requireText(text, "FIELDWORK_APP_STORE_PRIVATE_KEY_PATH", "release-ios must track the App Store Connect private key path for cleanup");
  requireText(text, "if: always()", "release-ios must clean up signing keychain even on failure");
  requireText(text, "Clean iOS signing and upload assets", "release-ios must clean signing and upload secret material");
  requireText(text, "security delete-keychain", "release-ios must delete its ephemeral signing keychain");
  for (const path of [
    "$RUNNER_TEMP/fieldwork-ios-distribution.p12",
    "$RUNNER_TEMP/fieldwork.mobileprovision",
    "$RUNNER_TEMP/fieldwork-profile.plist",
    "$RUNNER_TEMP/fieldwork-app-store-key.json",
    "${FIELDWORK_APP_STORE_PRIVATE_KEY_PATH:-}",
    "ExportOptions.plist",
  ]) {
    requireText(text, path, `release-ios cleanup must remove ${path}`);
  }
}

function verifyAndroidRelease(text) {
  requireText(text, "runs-on: ubuntu-24.04", "release-android must run on Ubuntu");
  requireText(text, "apps/android/scripts/build-rust.sh", "release-android must build Rust mobile libraries");
  for (const secret of [
    "SENTRY_DSN",
    "ANDROID_GOOGLE_SERVICES_JSON",
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PROPERTIES",
    "PLAY_SERVICE_ACCOUNT_JSON",
  ]) {
    requireText(text, secret, `release-android must require ${secret}`);
  }
  requireText(text, "node scripts/verify-telemetry-privacy.mjs", "release-android must run telemetry privacy verifier");
  requireText(text, "chmod 600 apps/android/app/google-services.json", "release-android must restrict Firebase config permissions");
  requireText(text, "chmod 600 apps/android/app/release.keystore apps/android/keystore.properties", "release-android must restrict signing asset permissions");
  requireText(text, "Clean Android release secrets", "release-android must clean decoded release secrets after upload");
  requireText(text, "rm -f apps/android/app/google-services.json apps/android/app/release.keystore apps/android/keystore.properties", "release-android cleanup must remove Firebase and signing files");
  requireText(text, "apps/android/gradlew --no-daemon bundleRelease", "release-android must build the release AAB");
  requireText(text, "node scripts/verify-mobile-privacy.mjs", "release-android must run mobile privacy verifier after manifest merge");
  requireText(text, "node scripts/verify-store-privacy.mjs", "release-android must run store privacy verifier after manifest merge");
  requireText(text, "node scripts/verify-android-aab.mjs", "release-android must verify AAB contents");
  rejectText(text, "node scripts/verify-android-aab.mjs --expect-unsigned", "release-android must not use the local unsigned-AAB verifier mode");
  requireText(text, "jarsigner -verify -certs", "release-android must verify AAB signature");
  requireText(text, "packageName: app.fieldwork.android", "release-android must upload the Fieldwork package");
  requireText(text, "track: internal", "release-android must upload to the Play internal track first");
}

function verifyRelayDeploy(text) {
  requireText(text, "Verify relay deploy prerequisites", "deploy-relay must preflight SSH key and inventory before artifact work");
  requireBefore(
    text,
    "Verify relay deploy prerequisites",
    "Download relay artifact",
    "deploy-relay must fail closed on SSH/inventory prerequisites before artifact download",
  );
  requireText(text, "FIELDWORK_VERIFY_COSIGN_SIGNATURE: \"1\"", "deploy-relay must require cosign verification");
  requireText(text, "FIELDWORK_RELEASE_REPOSITORY: ${{ github.repository }}", "deploy-relay must verify SLSA buildType against the checked-out repository");
  requireText(text, "FIELDWORK_EXPECTED_RELEASE_TAG: ${{ github.event.inputs.tag }}", "deploy-relay must pin SLSA releaseTag to the requested GitHub Release tag");
  requireText(text, "FIELDWORK_COSIGN_IDENTITY_REGEXP: '^https://github.com/${{ github.repository }}/\\.github/workflows/release-rust\\.yml@refs/tags/v.*$'", "deploy-relay must derive the cosign identity from the checked-out repository");
  requireText(text, "FIELDWORK_RELEASE_PLATFORMS: linux-arm64", "deploy-relay must deploy only the linux-arm64 artifact");
  requireText(text, "node scripts/verify-release-artifacts.mjs", "deploy-relay must verify release artifacts before deploy");
  requireText(text, "RELAY_SSH_KEY: ${{ secrets.RELAY_SSH_KEY }}", "deploy-relay must require SSH key from secrets");
  requireText(text, "chmod 600 ~/.ssh/fieldwork-relay", "deploy-relay must restrict the decoded relay SSH key");
  requireText(text, "Clean relay SSH key", "deploy-relay must clean the decoded relay SSH key");
  requireText(text, "rm -f ~/.ssh/fieldwork-relay", "deploy-relay cleanup must remove the decoded relay SSH key");
  requireText(text, "grep -Ev", "deploy-relay must ignore comments and blank lines when validating inventory");
  requireText(text, "must contain at least one relay host", "deploy-relay must reject empty placeholder inventory");
  requireText(text, "ansible-playbook", "deploy-relay must deploy through the Ansible playbook");
}

function verifySiteDeploy(text, astroConfig) {
  requireText(text, "name: Deploy Site", "deploy-site workflow must exist");
  requireText(text, "branches: [main]", "deploy-site must run on pushes to main");
  requireText(text, "workflow_dispatch", "deploy-site must support manual dispatch");
  requireText(text, "contents: read", "deploy-site must use read-only repository contents permission");
  requireText(text, "runs-on: ubuntu-24.04", "deploy-site must run on Ubuntu 24.04");
  requireText(text, "pnpm/action-setup@v4", "deploy-site must install pnpm through the pinned action");
  requireText(text, "version: 10.30.3", "deploy-site must pin the same pnpm version as the repo");
  requireText(text, "node-version: 22", "deploy-site must run on Node 22");
  requireText(text, "cache-dependency-path: site/pnpm-lock.yaml", "deploy-site must cache against the isolated site lockfile");
  requireText(text, "pnpm --dir site install --ignore-workspace --frozen-lockfile", "deploy-site must install the isolated site package from its lockfile");
  requireText(text, "pnpm build:site", "deploy-site must build the same static site command exposed at the root");
  requireText(text, "Verify Cloudflare credentials", "deploy-site must fail closed before Cloudflare deploy");
  requireText(text, "CLOUDFLARE_API_TOKEN", "deploy-site must require CLOUDFLARE_API_TOKEN");
  requireText(text, "CLOUDFLARE_ACCOUNT_ID", "deploy-site must require CLOUDFLARE_ACCOUNT_ID");
  requireText(text, "Cloudflare Pages credentials are required to deploy fieldwork.dev.", "deploy-site must explain the blocked external credential gate");
  requireText(text, "exit 1", "deploy-site credential verification must fail closed");
  requireText(text, "cloudflare/wrangler-action@v3", "deploy-site must deploy through Cloudflare wrangler-action");
  requireText(text, "pages deploy site/dist --project-name fieldwork-dev --branch main", "deploy-site must deploy site/dist to the fieldwork-dev Pages project");
  requireText(astroConfig, 'site: "https://fieldwork.dev"', "Astro config must pin the canonical fieldwork.dev site URL");
}

function verifyDependabot(text) {
  requireText(text, "version: 2", "Dependabot config must use version 2");
  const expectedEntries = [
    ["cargo", "/"],
    ["npm", "/"],
    ["npm", "/site"],
    ["gradle", "/apps/android"],
    ["github-actions", "/"],
  ];

  const entryMatches = [...text.matchAll(/package-ecosystem:\s*([^\n]+)\n\s+directory:\s*([^\n]+)\n\s+schedule:\n\s+interval:\s*weekly/g)];
  if (entryMatches.length !== expectedEntries.length) {
    failures.push(`Dependabot config must contain exactly ${expectedEntries.length} weekly update entries`);
  }

  for (const [ecosystem, directory] of expectedEntries) {
    const pattern = new RegExp(
      `package-ecosystem:\\s*${escapeRegExp(ecosystem)}\\n\\s+directory:\\s*${escapeRegExp(directory)}\\n\\s+schedule:\\n\\s+interval:\\s*weekly`,
    );
    if (!pattern.test(text)) {
      failures.push(`Dependabot config must update ${ecosystem} dependencies in ${directory} weekly`);
    }
  }

  for (const forbidden of ["/references", "/target", "/site/node_modules"]) {
    if (text.includes(forbidden)) {
      failures.push(`Dependabot config must not scan generated/reference path ${forbidden}`);
    }
  }
}

function verifyCiWiresVerifier(text) {
  requireText(text, "cargo fmt --check", "CI must run cargo fmt");
  requireText(text, "cargo clippy --workspace -- -D warnings", "CI must run workspace clippy as a deny-warning gate");
  requireText(text, "cargo nextest run --workspace", "CI must run workspace nextest");
  requireText(text, "cargo test --workspace --doc", "CI must run workspace doctests");
  requireText(text, "cargo deny check", "CI must run cargo-deny");
  requireText(text, "cargo audit", "CI must run cargo-audit");
  requireText(text, "scripts/smoke-local-handoff.sh", "CI must run the local handoff smoke");
  requireText(text, "node scripts/smoke-relay-otlp-loopback.mjs", "CI must run the relay OTLP loopback smoke");
  requireText(text, "node scripts/verify-release-workflows.mjs", "CI must run the release workflow verifier");
  requireText(text, "node scripts/verify-rust-workspace.mjs", "CI must run the Rust workspace verifier");
  requireText(text, "node scripts/verify-npm-packages.mjs", "CI must run the npm package verifier");
  requireText(text, "node scripts/verify-changesets-config.mjs", "CI must run the Changesets fixed-group verifier");
  requireText(text, "node scripts/generate-oss-notices.mjs --check", "CI must run the OSS notice drift check");
  requireText(text, "node scripts/verify-docs-sync.mjs", "CI must run the docs-sync verifier");
  requireText(text, "node scripts/verify-development-doc.mjs", "CI must run the development doc verifier");
  requireText(text, "sudo apt-get update && sudo apt-get install -y ffmpeg", "CI must install ffprobe before the demo video verifier");
  requireText(text, "pnpm check:demo-video", "CI must verify the committed demo video artifact");
  requireText(text, "node scripts/verify-community-scaffold.mjs", "CI must run the community scaffold verifier");
  requireText(text, "node scripts/verify-secret-boundaries.mjs", "CI must run the secret-boundary verifier");
  requireText(text, "node scripts/verify-security-model.mjs", "CI must run the security model verifier");
  requireText(text, "oven-sh/setup-bun@v2", "CI must install Bun before the Bun npm-compatibility smoke");
  requireText(text, "node scripts/test-bun-install.mjs", "CI must run the Bun optional-dependency install smoke");
  requireText(text, "node scripts/test-android-aab-verifier.mjs", "CI must run the Android AAB verifier self-test");
  requireText(text, "node scripts/test-release-artifacts.mjs", "CI must run the release artifact verifier tests");
  requireText(text, "node scripts/test-npm-dispatcher.mjs", "CI must run the npm dispatcher test");
  requireText(text, "node scripts/test-npm-registry-state.mjs", "CI must run the deterministic npm registry-state checker test");
  requireText(text, "node scripts/test-npm-publish-plan.mjs", "CI must run the npm publish-plan test");
  requireText(text, "node scripts/test-npm-artifact-pack.mjs", "CI must run the npm artifact/package dry-run tests");
  requireText(text, "node scripts/test-external-status-refresh.mjs", "CI must run the deterministic external status refresh guard test");
  requireText(text, "node scripts/verify-mobile-privacy.mjs", "CI must run the mobile privacy verifier");
  requireText(text, "node scripts/verify-secret-boundaries.mjs --self-test", "CI must run the secret-boundary self-test");
  requireText(text, "node scripts/verify-telemetry-privacy.mjs", "CI must run the telemetry privacy verifier");
  requireText(text, "node scripts/verify-v1-boundary.mjs", "CI must run the v1 boundary verifier");
  requireText(text, "node scripts/verify-no-ship-markers.mjs", "CI must run the no-ship marker verifier");
  requireText(text, "node scripts/verify-no-ship-markers.mjs --self-test", "CI must run the no-ship marker self-test");
  requireText(text, "node scripts/verify-release-audit.mjs", "CI must run the release audit verifier");
  requireText(text, "node scripts/verify-store-privacy.mjs", "CI must run the store privacy verifier");
  requireText(text, "node scripts/verify-relay-provider-clients.mjs", "CI must run the relay provider-client verifier");
  requireText(text, "node scripts/verify-daemon-resize.mjs", "CI must run the daemon resize invariant verifier");
  requireText(text, "node scripts/verify-daemon-service.mjs", "CI must run the daemon service scaffold verifier");
  requireText(text, "node scripts/verify-infra-scaffold.mjs", "CI must run the infra scaffold verifier");
  requireText(text, "node scripts/verify-site-content.mjs", "CI must run the site content verifier");
  requireText(text, "node scripts/test-ios-prereqs.mjs", "CI must run the deterministic iOS prereq script tests");
  requireText(text, "scripts/smoke-relay-tls-loopback.sh", "CI must run the relay TLS loopback smoke");
  requireText(text, "pnpm --dir site install --ignore-workspace --frozen-lockfile", "CI must install the isolated site lockfile");
  requireText(text, "pnpm check:site", "CI must run the site check");
  requireText(text, "apps/android/scripts/build-rust.sh", "CI must build Android Rust mobile libraries");
  requireText(text, "apps/android/gradlew --no-daemon :app:compileDebugKotlin", "CI must compile Android debug Kotlin");
  requireText(text, "if: matrix.os == 'ubuntu-24.04'\n        run: sudo apt-get update && sudo apt-get install -y vim", "CI Rust matrix must install vim before workspace tests");
  requireText(text, 'YAML.load_file(".github/dependabot.yml")', "CI must syntax-check Dependabot config");
  requireText(text, 'YAML.load_file(".pre-commit-config.yaml")', "CI must syntax-check the pre-commit config");
  requireText(text, "name: Terraform Validate", "CI must have a Terraform validation job");
  requireText(text, "hashicorp/setup-terraform@v3", "CI must install Terraform through the official setup action");
  requireText(text, "terraform_version: 1.5.7", "CI Terraform version must match the locally validated floor");
  requireText(text, "scripts/check-infra-terraform.sh", "CI must run the shared Terraform validation script");
  requireText(text, "swiftc -parse -target arm64-apple-macosx15.0 $(find apps/ios/Sources/App apps/ios/Sources/Core apps/ios/Sources/Features apps/ios/Sources/UI -name '*.swift')", "CI must parse all iOS Swift sources, including SwiftTermView fallback code");
  rejectText(text, "! -name 'SwiftTermView.swift'", "CI must not exclude the SwiftTerm terminal wrapper from Swift parsing");
  requireText(text, "apps/android/gradlew --no-daemon :app:testDebugUnitTest", "CI must run Android unit tests for native notification/privacy helpers");
}

function verifyCargoDistArchiveOnly(text) {
  requireText(text, "installers = []", "cargo-dist must not generate installers for v1");
  requireText(text, "publish-jobs = []", "cargo-dist must not publish installer/tap jobs for v1");
  requireText(text, "install-updater = false", "cargo-dist must not install or configure a self-updater");
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
  ]) {
    requireText(text, `"${target}"`, `cargo-dist target list must include ${target}`);
  }
  rejectText(text, "x86_64-pc-windows-msvc", "cargo-dist must not include a native Windows host target in v1");
  rejectText(text, "homebrew-tap", "cargo-dist must not configure a Homebrew tap in v1");
  rejectText(text, "[dist.homebrew]", "cargo-dist must not configure Homebrew publishing in v1");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function rejectText(text, needle, message) {
  if (text.includes(needle)) {
    failures.push(message);
  }
}

function requireBefore(text, first, second, message) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    failures.push(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
