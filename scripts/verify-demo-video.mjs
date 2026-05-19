#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const video = path.join(root, "docs/assets/fieldwork-demo-v1.mp4");
const packageJson = JSON.parse(read("package.json"));
const readme = read("README.md");
const development = read("docs/DEVELOPMENT.md");
const releaseAudit = read("docs/RELEASE_AUDIT.md");
const plan = read("PLAN.md");
const failures = [];

if (!fs.existsSync(video)) {
  failures.push("docs/assets/fieldwork-demo-v1.mp4 is missing; run pnpm render:demo-video");
} else {
  const stat = fs.statSync(video);
  if (stat.size < 100_000) {
    failures.push("docs/assets/fieldwork-demo-v1.mp4 is unexpectedly small");
  }
  verifyMedia(video);
}

if (packageJson.scripts?.["render:demo-video"] !== "node scripts/render-demo-video.mjs") {
  failures.push("package.json must expose pnpm render:demo-video");
}
if (packageJson.scripts?.["check:demo-video"] !== "node scripts/verify-demo-video.mjs") {
  failures.push("package.json must expose pnpm check:demo-video");
}

for (const [text, label] of [
  [readme, "README.md"],
  [development, "docs/DEVELOPMENT.md"],
  [releaseAudit, "docs/RELEASE_AUDIT.md"],
  [plan, "PLAN.md"],
]) {
  requireText(text, "docs/assets/fieldwork-demo-v1.mp4", `${label} must cite the demo video artifact`);
  requireText(text, "pnpm render:demo-video", `${label} must document demo-video regeneration`);
  requireText(text, "pnpm check:demo-video", `${label} must document demo-video verification`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("demo video ok");

function verifyMedia(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    failures.push(`ffprobe could not inspect demo video: ${result.stderr || result.stdout}`);
    return;
  }
  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    failures.push(`ffprobe returned invalid JSON: ${error.message}`);
    return;
  }
  const videoStream = metadata.streams?.find((stream) => stream.codec_type === "video");
  if (!videoStream) {
    failures.push("demo video must contain a video stream");
    return;
  }
  if (videoStream.codec_name !== "h264") {
    failures.push(`demo video must be h264, got ${videoStream.codec_name}`);
  }
  if (videoStream.width !== 1920 || videoStream.height !== 1080) {
    failures.push(`demo video must be 1920x1080, got ${videoStream.width}x${videoStream.height}`);
  }
  const duration = Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration < 59.5 || duration > 60.5) {
    failures.push(`demo video must be approximately 60 seconds, got ${metadata.format?.duration}`);
  }
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
