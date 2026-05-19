#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

const ignoredDirs = new Set([
  ".git",
  "target",
  "node_modules",
  ".gradle",
  "DerivedData",
  "build",
]);

const forbiddenCredentialPatterns = [
  /FIELDWORK_APNS_P8_PATH/,
  /FIELDWORK_FCM_SERVICE_ACCOUNT_PATH/,
  /FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH/,
  /apns\.p8/,
  /fcm-service-account\.json/,
  /honeycomb-api-key/,
  /LoadCredential=.*(?:apns|fcm|honeycomb)/,
];
const forbiddenRepositorySecretPatterns = [
  /npm_[A-Za-z0-9]{20,}/,
  /(?:^|\n)\s*(?:\/\/[^:\n]+:)?_authToken\s*=/,
  /(?:^|\n)\s*NODE_AUTH_TOKEN\s*=/,
];

const forbiddenAreas = [
  "crates/cli",
  "crates/daemon",
  "crates/mobile-core",
  "apps/ios",
  "apps/android",
  "packages",
];

const requiredRelayWiring = [
  {
    file: "crates/relay/src/apns.rs",
    patterns: [/FIELDWORK_APNS_P8_PATH/, /CREDENTIALS_DIRECTORY/, /apns\.p8/],
  },
  {
    file: "crates/relay/src/fcm.rs",
    patterns: [
      /FIELDWORK_FCM_SERVICE_ACCOUNT_PATH/,
      /CREDENTIALS_DIRECTORY/,
      /fcm-service-account\.json/,
    ],
  },
  {
    file: "infra/relay/ansible/templates/fieldwork-control-plane.service.j2",
    patterns: [
      /LoadCredential=apns\.p8:/,
      /LoadCredential=fcm-service-account\.json:/,
      /LoadCredential=honeycomb-api-key:/,
    ],
  },
  {
    file: "crates/relay/src/telemetry.rs",
    patterns: [
      /FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH/,
      /CREDENTIALS_DIRECTORY/,
      /honeycomb-api-key/,
    ],
  },
];

const failures = [];
const scannedArtifacts = [];
const artifactChunkSize = 1024 * 1024;
const artifactTextOverlap = 4096;

if (process.argv.includes("--self-test")) {
  runSelfTest();
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("secret boundary self-test ok");
  process.exit(0);
}

verifyGitIgnoreSecretPatterns();

for (const area of forbiddenAreas) {
  for (const file of walk(path.join(repo, area))) {
    const rel = path.relative(repo, file);
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbiddenCredentialPatterns) {
      if (pattern.test(text)) {
        failures.push(`${rel} contains relay-only provider credential wiring: ${pattern}`);
      }
    }
  }
}

for (const file of walk(repo)) {
  const rel = path.relative(repo, file);
  if (rel.startsWith("infra/relay/")) {
    continue;
  }
  if (rel.startsWith("docs/") || rel.startsWith("scripts/") || rel === "PLAN.md") {
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  if (/LoadCredential=.*(?:apns|fcm|honeycomb)/.test(text)) {
    failures.push(`${rel} contains relay-only LoadCredential outside infra/relay`);
  }
}

for (const file of walk(repo)) {
  const rel = path.relative(repo, file);
  if (rel.startsWith("references/")) {
    continue;
  }
  if (path.basename(file) === ".npmrc") {
    failures.push(`${rel} must not exist; npm credentials must stay in operator environment or GitHub Secrets`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of forbiddenRepositorySecretPatterns) {
    if (matchesPattern(pattern, text)) {
      failures.push(`${rel} contains a repository secret or npm auth token pattern: ${pattern}`);
    }
  }
}

for (const requirement of requiredRelayWiring) {
  const text = fs.readFileSync(path.join(repo, requirement.file), "utf8");
  for (const pattern of requirement.patterns) {
    if (!pattern.test(text)) {
      failures.push(`${requirement.file} is missing required relay wiring: ${pattern}`);
    }
  }
}

for (const artifact of findNonRelayArtifacts()) {
  scannedArtifacts.push(path.relative(repo, artifact));
  const scan = scanArtifactForForbiddenContent(artifact);
  for (const literal of scan.credentialLiterals) {
    failures.push(
      `${path.relative(repo, artifact)} binary contains relay-only provider credential wiring: ${literal}`,
    );
  }
  for (const pattern of scan.repositorySecretPatterns) {
    failures.push(
      `${path.relative(repo, artifact)} artifact contains a repository secret or npm auth token pattern: ${pattern}`,
    );
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

if (scannedArtifacts.length > 0) {
  console.log(
    `secret boundary ok (repository and artifact npm tokens/.npmrc rejected; scanned ${scannedArtifacts.length} non-relay artifacts: ${scannedArtifacts.sort().join(", ")})`,
  );
} else {
  console.log("secret boundary ok (repository and artifact npm tokens/.npmrc rejected; scanned 0 non-relay artifacts)");
}

function verifyGitIgnoreSecretPatterns() {
  const gitignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  for (const pattern of [
    ".npmrc",
    ".env",
    ".env.local",
    ".env.*.local",
    "*.p8",
    "*.p12",
    "*.mobileprovision",
    "*.jks",
    "*.keystore",
    "fcm-service-account.json",
    "google-services.json",
    "honeycomb-api-key",
  ]) {
    if (!gitignore.split("\n").includes(pattern)) {
      failures.push(`.gitignore must keep local secret pattern ignored: ${pattern}`);
    }
  }
}

function runSelfTest() {
  const mustMatch = [
    `npm_${"A".repeat(20)}`,
    `\n//registry.npmjs.org/:_auth${"Token"}=secret`,
    `\n_auth${"Token"} = secret`,
    `\nNODE_AUTH${"_TOKEN"}=secret`,
  ];
  const mustNotMatch = [
    "NPM_TOKEN / NODE_AUTH_TOKEN lives in GitHub Secrets",
    "`NODE_AUTH_TOKEN` without an assignment",
    "`_authToken` without an assignment",
    "example token names only",
  ];

  for (const sample of mustMatch) {
    if (!forbiddenRepositorySecretPatterns.some((pattern) => matchesPattern(pattern, sample))) {
      failures.push(`secret-boundary self-test expected a match for sample: ${sample}`);
    }
  }
  for (const sample of mustNotMatch) {
    if (forbiddenRepositorySecretPatterns.some((pattern) => matchesPattern(pattern, sample))) {
      failures.push(`secret-boundary self-test unexpectedly matched sample: ${sample}`);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-secret-boundary-"));
  try {
    const chunkBoundaryToken = path.join(tempDir, "fieldworkd");
    fs.writeFileSync(
      chunkBoundaryToken,
      Buffer.concat([
        Buffer.alloc(artifactChunkSize - 2, 0),
        Buffer.from("np"),
        Buffer.from(`m_${"A".repeat(20)}`),
        Buffer.alloc(artifactChunkSize, 0),
      ]),
    );
    const tokenScan = scanArtifactForForbiddenContent(chunkBoundaryToken);
    if (tokenScan.repositorySecretPatterns.length === 0) {
      failures.push("secret-boundary self-test must detect npm tokens across artifact chunk boundaries");
    }

    const chunkBoundaryCredential = path.join(tempDir, "fieldwork");
    fs.writeFileSync(
      chunkBoundaryCredential,
      Buffer.concat([
        Buffer.alloc(artifactChunkSize - "ap".length, 0),
        Buffer.from("ap"),
        Buffer.from("ns.p8"),
        Buffer.alloc(artifactChunkSize, 0),
      ]),
    );
    const credentialScan = scanArtifactForForbiddenContent(chunkBoundaryCredential);
    if (!credentialScan.credentialLiterals.includes("apns.p8")) {
      failures.push(
        "secret-boundary self-test must detect relay credential literals across artifact chunk boundaries",
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  verifyGitIgnoreSecretPatterns();
}

function matchesPattern(pattern, text) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function* walk(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.isFile() && isTextFile(full)) {
      yield full;
    }
  }
}

function isTextFile(file) {
  if (path.basename(file) === ".npmrc") {
    return true;
  }
  return /\.(c|h|cc|cpp|gradle|java|json|kts|kt|m|mm|md|mjs|plist|proj|rs|sh|swift|toml|txt|xml|yml|yaml)$/.test(
    file,
  );
}

function* findNonRelayArtifacts() {
  const names = new Set([
    "fieldwork",
    "fieldworkd",
    "libfieldwork_mobile_core.a",
    "libfieldwork_mobile_core.dylib",
    "libfieldwork_mobile_core.so",
    "fieldwork_mobile_core.dll",
  ]);
  for (const root of ["target", "dist", "packages"]) {
    yield* walkArtifacts(path.join(repo, root), names);
  }
}

function* walkArtifacts(dir, names) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkArtifacts(full, names);
      continue;
    }
    if (entry.isFile() && names.has(entry.name)) {
      yield full;
    }
  }
}

function scanArtifactForForbiddenContent(file) {
  const credentialLiterals = forbiddenCredentialPatterns.map(literalFromPattern).filter(Boolean);
  const credentialBuffers = credentialLiterals.map((literal) => [literal, Buffer.from(literal)]);
  const byteOverlap = Math.max(0, ...credentialBuffers.map(([, buffer]) => buffer.length - 1));
  const foundCredentialLiterals = new Set();
  const foundRepositorySecretPatterns = new Set();
  const chunk = Buffer.allocUnsafe(artifactChunkSize);
  let previousBytes = Buffer.alloc(0);
  let previousText = "";
  const fd = fs.openSync(file, "r");

  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const current = chunk.subarray(0, bytesRead);
      const bytesForScan =
        previousBytes.length > 0 ? Buffer.concat([previousBytes, current]) : current;
      for (const [literal, literalBuffer] of credentialBuffers) {
        if (!foundCredentialLiterals.has(literal) && bytesForScan.includes(literalBuffer)) {
          foundCredentialLiterals.add(literal);
        }
      }

      const textForScan = previousText + current.toString("latin1");
      for (const pattern of forbiddenRepositorySecretPatterns) {
        if (!foundRepositorySecretPatterns.has(pattern) && matchesPattern(pattern, textForScan)) {
          foundRepositorySecretPatterns.add(pattern);
        }
      }

      previousBytes =
        byteOverlap > 0
          ? Buffer.from(bytesForScan.subarray(Math.max(0, bytesForScan.length - byteOverlap)))
          : Buffer.alloc(0);
      previousText = textForScan.slice(-artifactTextOverlap);
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    credentialLiterals: [...foundCredentialLiterals],
    repositorySecretPatterns: [...foundRepositorySecretPatterns],
  };
}

function literalFromPattern(pattern) {
  const source = pattern.source;
  if (source === "FIELDWORK_APNS_P8_PATH") {
    return "FIELDWORK_APNS_P8_PATH";
  }
  if (source === "FIELDWORK_FCM_SERVICE_ACCOUNT_PATH") {
    return "FIELDWORK_FCM_SERVICE_ACCOUNT_PATH";
  }
  if (source === "FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH") {
    return "FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH";
  }
  if (source === "apns\\.p8") {
    return "apns.p8";
  }
  if (source === "fcm-service-account\\.json") {
    return "fcm-service-account.json";
  }
  if (source === "honeycomb-api-key") {
    return "honeycomb-api-key";
  }
  return null;
}
