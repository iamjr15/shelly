export function verifyPhysicalAndroidAdbDevices(text, failures, { file = "adb-devices.txt" } = {}) {
  if (!Array.isArray(failures)) {
    throw new TypeError("verifyPhysicalAndroidAdbDevices requires a failures array");
  }

  requirePatternText(text, /^List of devices attached\b/im, `${file} must include adb devices output`, failures);
  const authorizedDevices = text
    .split(/\r?\n/)
    .filter((line) => /^[^\s#][^\n]*\s+device(?:\s|$)/i.test(line));
  if (authorizedDevices.length === 0) {
    failures.push(`${file} must show exactly one authorized physical Android device`);
  } else if (authorizedDevices.length > 1) {
    failures.push(`${file} must show exactly one authorized physical Android device, found ${authorizedDevices.length}`);
  }
  rejectPatternText(
    text,
    /^(?:emulator-\d+|[^\n]*(?:\bsdk_gphone\b|\bsdk_gphone64\b|\bgeneric_x86\b|\bgeneric_x86_64\b|\bgoldfish\b|\branchu\b|\bqemu\b|\bavd\b|\bdevice:emu[^\s]*\b))[^\n]*\s+device(?:\s|$)/im,
    `${file} must show a physical Android phone, not an emulator or AVD`,
    failures,
  );
  rejectPatternText(
    text,
    /\b(?:unauthorized|offline|no permissions)\b/i,
    `${file} must not show the tested device as unauthorized, offline, or inaccessible`,
    failures,
  );
}

export function verifyInstalledAndroidPackageInfo(
  text,
  failures,
  {
    file = "package-info.txt",
    packageName = "app.fieldwork.android",
    versionName = "1.0",
    versionCode = "1",
    forbidDebuggable = false,
  } = {},
) {
  if (!Array.isArray(failures)) {
    throw new TypeError("verifyInstalledAndroidPackageInfo requires a failures array");
  }

  const packagePattern = escapeRegExp(packageName);
  requirePatternText(
    text,
    new RegExp(`\\bpackage:\\S*${packagePattern}\\S*`, "i"),
    `${file} must include adb shell pm path output for ${packageName}`,
    failures,
  );
  requirePatternText(
    text,
    new RegExp(`\\bPackage\\s*\\[${packagePattern}\\]|\\bname=${packagePattern}\\b|\\b${packagePattern}\\b`, "i"),
    `${file} must include dumpsys package details for ${packageName}`,
    failures,
  );
  requirePatternText(
    text,
    new RegExp(`\\bversionName=${escapeRegExp(versionName)}\\b`),
    `${file} must prove installed versionName=${versionName}`,
    failures,
  );
  requirePatternText(
    text,
    new RegExp(`\\bversionCode=${escapeRegExp(versionCode)}\\b`),
    `${file} must prove installed versionCode=${versionCode}`,
    failures,
  );
  if (forbidDebuggable) {
    rejectPatternText(
      text,
      /\b(?:DEBUGGABLE|debuggable\s*=\s*true|android:debuggable\s*=\s*["']?true["']?)\b/i,
      `${file} must prove the installed package is not a debug/debuggable build`,
      failures,
    );
  }
}

export function verifyNoAndroidSystemErrorOverlays(entries, failures) {
  if (!Array.isArray(failures)) {
    throw new TypeError("verifyNoAndroidSystemErrorOverlays requires a failures array");
  }

  const systemError = /\b(?:System UI|Fieldwork|[^"]+)\s+(?:isn't responding|is not responding)\b|\bClose app\b|\bApp isn't responding\b/i;
  for (const [file, text] of entries) {
    rejectPatternText(
      text,
      systemError,
      `${file} must not show an Android system error or not-responding overlay`,
      failures,
    );
  }
}

export function verifyCleanAndroidLogs(entries, failures) {
  if (!Array.isArray(failures)) {
    throw new TypeError("verifyCleanAndroidLogs requires a failures array");
  }

  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  for (const [file, text] of entries) {
    rejectPatternText(
      text,
      fatalPattern,
      `${file} must not contain Android fatal, ANR, or exception entries`,
      failures,
    );
    if (isCrashBufferFile(file) && text.trim().length > 0) {
      failures.push(`${file} must be empty after adb logcat -c; crash-buffer entries invalidate Android evidence`);
    }
  }
}

function isCrashBufferFile(file) {
  return file === "crash.log" || file.endsWith("-crash.log");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requirePatternText(text, pattern, message, failures) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function rejectPatternText(text, pattern, message, failures) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}
