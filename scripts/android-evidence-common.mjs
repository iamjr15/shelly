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
