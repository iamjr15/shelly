#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-pair-button-picker-"));

try {
  const fixture = path.join(tmp, "pairing-screen.xml");
  fs.writeFileSync(
    fixture,
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
    <node class="android.view.View" clickable="false" enabled="true" bounds="[0,63][1080,2127]">
      <node text='AB4C7' class="android.widget.EditText" clickable="true" enabled="true" bounds="[42,1218][1038,1942]">
        <node text="Pairing code" class="android.widget.TextView" clickable="false" enabled="true" bounds="[84,1218][315,1260]" />
      </node>
      <node class="android.view.View" clickable="true" enabled="true" bounds="[42,1942][1038,2068]">
        <node class="android.widget.Button" clickable="false" enabled="true" bounds="[42,1986][1038,2023]" />
      </node>
      <node class="android.view.View" clickable="false" enabled="true" bounds="[0,126][1080,294]">
        <node text="Pair" class="android.widget.TextView" clickable="false" enabled="true" bounds="[43,173][143,247]" />
      </node>
    </node>
    <node class="android.view.View" clickable="true" enabled="true" bounds="[550,2127][1080,2337]">
      <node text="Settings" class="android.widget.TextView" bounds="[752,2253][878,2295]" />
    </node>
  </node>
</hierarchy>
UI hierchary dumped to: /dev/tty
`,
  );

  const result = spawnSync("python3", ["scripts/pick-android-pair-button.py", fixture], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }

  const coords = result.stdout.trim();
  if (coords !== "540 2005") {
    console.error(`expected pair button center 540 2005, got ${JSON.stringify(coords)}`);
    process.exit(1);
  }

  console.log("android pair-button picker ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
