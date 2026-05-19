#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();

const cases = [
  {
    name: "missing xcode pin stays actionable",
    setup: ({ repo }) => {
      installDefaultStubs(repo, { xcodebuildVersion: null });
    },
    args: [],
    expectStatus: "failure",
    expectStdout: [
      "required Xcode: unknown",
      "fail: .xcode-version is missing",
      "warn: no required Xcode version configured; cannot look for Xcode XIP",
      "Restore .xcode-version or set FIELDWORK_XCODE_VERSION",
    ],
    rejectStdout: ["Xcode_.xip", "Xcode-.app"],
  },
  {
    name: "local xcode version match is exact",
    setup: ({ repo }) => {
      fs.writeFileSync(path.join(repo, ".xcode-version"), "16.3\n");
      installDefaultStubs(repo, { xcodebuildVersion: "16.30" });
    },
    args: [],
    expectStatus: "failure",
    expectStdout: [
      "fail: Xcode 16.30 selected, expected Xcode 16.3",
    ],
  },
  {
    name: "download headroom floors fractional gib",
    setup: ({ repo }) => {
      fs.writeFileSync(path.join(repo, ".xcode-version"), "16.3\n");
      installDefaultStubs(repo, {
        xcodebuildVersion: "16.3",
        freeKiB: Math.floor(69.9 * 1024 * 1024),
      });
    },
    args: ["--download-xcode"],
    expectStatus: "failure",
    expectStdout: [
      "warn: ",
      "has 69 GiB free; Xcode download plus expansion should have at least 70 GiB free",
      "fail: refusing Xcode download with only 69 GiB free",
    ],
    rejectStdout: ["Starting Xcode 16.3 download through xcodes"],
  },
];

for (const testCase of cases) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-ios-prereq-test-"));
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(root, "scripts", "check-ios-prereqs.sh"),
      path.join(repo, "scripts", "check-ios-prereqs.sh"),
    );
    fs.chmodSync(path.join(repo, "scripts", "check-ios-prereqs.sh"), 0o755);

    testCase.setup({ repo, tmp });
    const result = runCase(repo, testCase.args);
    const failed = result.status !== 0;
    if (testCase.expectStatus === "failure" && !failed) {
      failCase(testCase.name, result, "expected failure, got success");
    }
    if (testCase.expectStatus === "success" && failed) {
      failCase(testCase.name, result, "expected success, got failure");
    }
    for (const expected of testCase.expectStdout || []) {
      if (!result.stdout.includes(expected)) {
        failCase(testCase.name, result, `expected stdout to include: ${expected}`);
      }
    }
    for (const rejected of testCase.rejectStdout || []) {
      if (result.stdout.includes(rejected)) {
        failCase(testCase.name, result, `expected stdout not to include: ${rejected}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("iOS prerequisite script tests ok");

function runCase(repo, args) {
  return spawnSync("bash", ["scripts/check-ios-prereqs.sh", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(repo, "stub-bin")}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_XCODE_DOWNLOAD_DIR: path.join(repo, "downloads"),
    },
  });
}

function installDefaultStubs(repo, options = {}) {
  const bin = path.join(repo, "stub-bin");
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(bin, "sw_vers", "#!/usr/bin/env bash\nprintf '15.2\\n'\n");
  writeExecutable(bin, "cargo", "#!/usr/bin/env bash\nprintf 'cargo 1.94.0\\n'\n");
  writeExecutable(bin, "aria2c", "#!/usr/bin/env bash\nprintf 'aria2 version 1.37.0\\n'\n");
  writeExecutable(bin, "swiftc", "#!/usr/bin/env bash\nprintf 'Apple Swift version 6.0.3\\n'\n");
  writeExecutable(bin, "xcode-select", "#!/usr/bin/env bash\nprintf '/Applications/Xcode.app/Contents/Developer\\n'\n");
  writeExecutable(bin, "lipo", "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(bin, "git", "#!/usr/bin/env bash\nexit 1\n");
  writeExecutable(bin, "df", `#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
printf '/dev/test 100000000 0 ${options.freeKiB ?? 80 * 1024 * 1024} 0%% /\\n'
`);
  writeExecutable(bin, "rustup", `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  printf 'rustup 1.29.0\\n'
elif [ "$1" = "target" ] && [ "$2" = "list" ] && [ "$3" = "--installed" ]; then
  printf 'aarch64-apple-ios\\naarch64-apple-ios-sim\\nx86_64-apple-ios\\n'
else
  exit 1
fi
`);
  writeExecutable(bin, "xcodes", `#!/usr/bin/env bash
if [ "$1" = "version" ]; then
  printf '1.6.2\\n'
elif [ "$1" = "download" ]; then
  printf 'stub xcodes download invoked\\n'
  exit 0
else
  exit 1
fi
`);
  writeExecutable(bin, "xcodebuild", xcodebuildStub(options.xcodebuildVersion));
  writeExecutable(bin, "xcrun", `#!/usr/bin/env bash
if [ "$3" = "--show-sdk-path" ]; then
  printf '/Applications/Xcode.app/Contents/Developer/Platforms/%s.platform/Developer/SDKs/%s.sdk\\n' "$2" "$2"
elif [ "$3" = "--show-sdk-version" ]; then
  printf '26.0\\n'
else
  exit 1
fi
`);
}

function xcodebuildStub(version) {
  if (!version) {
    return "#!/usr/bin/env bash\nexit 1\n";
  }
  return `#!/usr/bin/env bash
printf 'Xcode ${version}\\n'
printf 'Build version TEST\\n'
`;
}

function writeExecutable(bin, name, contents) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function failCase(name, result, message) {
  process.stderr.write(`case failed: ${name}: ${message}\n`);
  process.stderr.write("--- stdout ---\n");
  process.stderr.write(result.stdout);
  process.stderr.write("--- stderr ---\n");
  process.stderr.write(result.stderr);
  process.exit(1);
}
