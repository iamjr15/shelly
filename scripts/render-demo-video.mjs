#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const output = path.resolve(root, process.argv[2] ?? "docs/assets/fieldwork-demo-v1.mp4");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-demo-"));

const slides = [
  {
    kind: "slate",
    name: "01-title",
    duration: 8,
    eyebrow: "FIELDWORK V1.0",
    title: "Universal terminal handoff",
    lines: [
      "Run any CLI on your laptop.",
      "Continue the exact same PTY session from your phone.",
      "Return to the laptop without losing state.",
    ],
  },
  {
    kind: "asset",
    name: "02-cli",
    duration: 10,
    source: "docs/assets/fieldwork-cli-flow.svg",
  },
  {
    kind: "asset",
    name: "03-pairing",
    duration: 10,
    source: "docs/assets/fieldwork-pairing.svg",
  },
  {
    kind: "asset",
    name: "04-mobile",
    duration: 10,
    source: "docs/assets/fieldwork-mobile-session.svg",
  },
  {
    kind: "slate",
    name: "05-architecture",
    duration: 10,
    eyebrow: "RAW PTY BYTES",
    title: "No tmux, no SSH keys, no cell-grid protocol",
    lines: [
      "fieldworkd owns the PTY and streams bytes over length-prefixed frames.",
      "Warm reconnect replays from the byte ring.",
      "Stale attach uses a synthetic ANSI snapshot from daemon terminal state.",
    ],
  },
  {
    kind: "slate",
    name: "06-boundary",
    duration: 12,
    eyebrow: "V1 RELEASE BOUNDARY",
    title: "Production gates are explicit",
    lines: [
      "Local code, package, relay, Android AAB, privacy, and protocol gates are verified.",
      "Final release still requires signing, provider credentials, hosted relay, npm publish, and physical-device passes.",
      "iOS is deferred; the current local release surface stays Android, relay, npm, site, and desktop CLI.",
    ],
  },
];

try {
  ensureTool("qlmanage");
  ensureTool("ffmpeg");

  const pngs = [];
  for (const slide of slides) {
    const svgPath = slide.kind === "asset"
      ? path.join(root, slide.source)
      : writeSlate(slide);
    pngs.push({ path: renderSvg(svgPath), duration: slide.duration });
  }

  const concatFile = path.join(tmp, "concat.txt");
  fs.writeFileSync(
    concatFile,
    [
      ...pngs.flatMap((png) => [`file '${escapeConcatPath(png.path)}'`, `duration ${png.duration}`]),
      `file '${escapeConcatPath(pngs[pngs.length - 1].path)}'`,
      "",
    ].join("\n"),
  );

  fs.mkdirSync(path.dirname(output), { recursive: true });
  run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0f0e,fps=30,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-t",
    "60",
    "-movflags",
    "+faststart",
    "-metadata",
    "title=Fieldwork v1.0 demo",
    output,
  ]);

  console.log(`wrote ${path.relative(root, output)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function writeSlate(slide) {
  const file = path.join(tmp, `${slide.name}.svg`);
  const lines = slide.lines
    .map((line, index) => {
      const y = 630 + index * 72;
      return `<text x="188" y="${y}" class="line">${xml(line)}</text>`;
    })
    .join("\n");
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <style>
    .eyebrow { font: 700 38px -apple-system, BlinkMacSystemFont, "SF Pro Display", Arial, sans-serif; letter-spacing: 8px; fill: #7bd7bd; }
    .title { font: 800 92px -apple-system, BlinkMacSystemFont, "SF Pro Display", Arial, sans-serif; fill: #f4f1e8; }
    .line { font: 500 42px -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif; fill: #d7ded7; }
    .meta { font: 600 30px -apple-system, BlinkMacSystemFont, "SF Pro Text", Arial, sans-serif; fill: #85938c; }
  </style>
  <rect width="1920" height="1080" fill="#0b0f0e"/>
  <rect x="124" y="118" width="1672" height="844" rx="38" fill="#111815" stroke="#294239" stroke-width="2"/>
  <rect x="124" y="118" width="1672" height="9" fill="#7bd7bd"/>
  <circle cx="1502" cy="250" r="90" fill="#20362f"/>
  <circle cx="1630" cy="338" r="42" fill="#62533b"/>
  <path d="M1460 266h210M1460 318h148M1460 370h180" stroke="#7bd7bd" stroke-width="16" stroke-linecap="round"/>
  <text x="184" y="262" class="eyebrow">${xml(slide.eyebrow)}</text>
  <text x="184" y="428" class="title">${xml(slide.title)}</text>
  ${lines}
  <text x="184" y="892" class="meta">fieldwork.dev · npm i -g fieldwork · AGPL-3.0</text>
</svg>
`);
  return file;
}

function renderSvg(svgPath) {
  if (!fs.existsSync(svgPath)) {
    throw new Error(`missing SVG input: ${path.relative(root, svgPath)}`);
  }
  run("qlmanage", ["-t", "-s", "1920", "-o", tmp, svgPath]);
  const png = path.join(tmp, `${path.basename(svgPath)}.png`);
  if (!fs.existsSync(png)) {
    throw new Error(`Quick Look did not produce ${png}`);
  }
  return png;
}

function ensureTool(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${name} is required to render the demo video`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  }
}

function escapeConcatPath(value) {
  return value.replace(/'/g, "'\\''");
}

function xml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
