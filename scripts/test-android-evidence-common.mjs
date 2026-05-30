#!/usr/bin/env node
import {
  verifyInstalledAndroidPackageInfo,
  verifyPhysicalAndroidAdbDevices,
} from "./android-evidence-common.mjs";

const goodPackageInfo = [
  "package:/data/app/~~hash/app.fieldwork.android-base.apk",
  "Packages:",
  "  Package [app.fieldwork.android] (abc):",
  "    versionCode=1 minSdk=30 targetSdk=36",
  "    versionName=1.0",
  "    pkgFlags=[ HAS_CODE ALLOW_BACKUP ]",
].join("\n");

const releaseFailures = [];
verifyInstalledAndroidPackageInfo(goodPackageInfo, releaseFailures, { forbidDebuggable: true });
expectDeepEqual(releaseFailures, [], "release package proof without debug markers should pass");

for (const [label, marker] of [
  ["dumpsys DEBUGGABLE flag", "    pkgFlags=[ HAS_CODE DEBUGGABLE ALLOW_BACKUP ]"],
  ["debuggable=true key", "    debuggable=true"],
  ["manifest android:debuggable", '    android:debuggable="true"'],
]) {
  const failures = [];
  verifyInstalledAndroidPackageInfo(`${goodPackageInfo}\n${marker}`, failures, { forbidDebuggable: true });
  expect(
    failures.some((failure) => failure.includes("not a debug/debuggable build")),
    `${label} should fail release package proof`,
  );
}

const liveTestingFailures = [];
verifyInstalledAndroidPackageInfo(
  `${goodPackageInfo}\n    pkgFlags=[ HAS_CODE DEBUGGABLE ALLOW_BACKUP ]`,
  liveTestingFailures,
);
expectDeepEqual(liveTestingFailures, [], "first-round live-testing package proof may use the normal debug build");

const adbFailures = [];
verifyPhysicalAndroidAdbDevices(
  "List of devices attached\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\n",
  adbFailures,
);
expectDeepEqual(adbFailures, [], "single physical adb device should pass common verifier");

console.log("Android evidence common helpers ok");

function expect(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function expectDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}
