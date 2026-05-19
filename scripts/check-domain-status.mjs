#!/usr/bin/env node
import dns from "node:dns/promises";
import process from "node:process";

const domain = process.env.FIELDWORK_DOMAIN || "fieldwork.dev";
const args = new Set(process.argv.slice(2));
const operatorRefresh = args.has("--operator-refresh");
const requireRegistered = args.has("--require-registered");
const requireDns = args.has("--require-dns");
const rdapUrl = `https://rdap.org/domain/${domain}`;

if (args.has("--help") || args.has("-h")) {
  console.log("usage: node scripts/check-domain-status.mjs --operator-refresh [--require-registered] [--require-dns]");
  console.log("Performs an operator-requested RDAP/DNS status refresh; it does not prove ownership.");
  process.exit(0);
}

if (!operatorRefresh) {
  console.error("Domain status refresh requires --operator-refresh.");
  console.error("This live RDAP/DNS lookup is not a routine local check and does not prove ownership.");
  process.exit(2);
}

const response = await fetch(rdapUrl, {
  headers: { accept: "application/rdap+json" },
  signal: AbortSignal.timeout(10_000),
});

let status = "unknown";
let rdap = null;
if (response.status === 404) {
  status = "unregistered";
} else if (!response.ok) {
  throw new Error(`RDAP lookup failed for ${domain}: HTTP ${response.status}`);
} else {
  rdap = await response.json();
  status = "registered";
}

const ns = await resolveOrEmpty("NS");
const a = await resolveOrEmpty("A");
const aaaa = await resolveOrEmpty("AAAA");

console.log(`domain status check: ${domain}`);
console.log(`rdap: ${rdapUrl}`);
console.log(`status: ${status}`);

if (rdap) {
  console.log(`registrar: ${registrarName(rdap) || "unknown"}`);
  for (const eventName of ["registration", "expiration", "last changed"]) {
    const date = eventDate(rdap, eventName);
    if (date) {
      console.log(`${eventName}: ${date}`);
    }
  }
}

console.log(`nameservers: ${ns.length > 0 ? ns.join(", ") : "none"}`);
console.log(`a: ${a.length > 0 ? a.join(", ") : "none"}`);
console.log(`aaaa: ${aaaa.length > 0 ? aaaa.join(", ") : "none"}`);

const failures = [];
if (requireRegistered && status !== "registered") {
  failures.push(`${domain} is not registered`);
}
if (requireDns && ns.length === 0) {
  failures.push(`${domain} has no NS records`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

if (requireRegistered || requireDns) {
  console.log("domain status ok");
}

async function resolveOrEmpty(rrtype) {
  try {
    return await dns.resolve(domain, rrtype);
  } catch (error) {
    if (["ENODATA", "ENOTFOUND", "ENODOMAIN"].includes(error.code)) {
      return [];
    }
    throw error;
  }
}

function registrarName(payload) {
  for (const entity of payload.entities || []) {
    if (entity.roles?.includes("registrar")) {
      return entity.vcardArray?.[1]?.find((entry) => entry[0] === "fn")?.[3];
    }
  }
  return null;
}

function eventDate(payload, action) {
  return (payload.events || []).find((event) => event.eventAction === action)?.eventDate;
}
