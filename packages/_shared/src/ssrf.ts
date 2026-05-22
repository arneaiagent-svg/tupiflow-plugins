// Shared SSRF guard for plugin code that issues outbound fetches against
// user-influenced URLs. Mirrors `tupiflow/backend/src/lib/utils/assert-public-
// url.ts` byte-for-byte (modulo the export surface comment); keep the two in
// sync — drift between host and shim is the kind of split-brain that lets a
// plugin worker reach 169.254.169.254 while the host rejects the same URL.
//
// Parses the URL, resolves DNS, and rejects loopback / private / link-local /
// multicast / unspecified / cloud-metadata addresses. Does NOT trust the
// hostname alone — DNS rebinding can flip A records between the check and
// the connect; callers must additionally pass `redirect: "manual"` (or
// "error") and re-validate the Location header on every hop.
//
// Hand-rolled CIDR checks (no `ipaddr.js` dep) so the shim stays
// zero-dependency. Safe to import from main-bundle steps AND from worker
// fixtures (only uses `node:dns/promises`, which every Node runtime ships).

import { lookup } from "node:dns/promises";

const PORT_ALLOWLIST = new Set([80, 443, 8080, 8443, 8000, 3000, 8888]);
const CLOUD_METADATA_IPV4 = "169.254.169.254";

function isLoopbackV4(parts: number[]): boolean {
  return parts[0] === 127;
}

function isUnspecifiedV4(parts: number[]): boolean {
  return parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0;
}

// RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.
function isRfc1918V4(parts: number[]): boolean {
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  return false;
}

// Link-local: 169.254.0.0/16 (covers cloud metadata at 169.254.169.254).
function isLinkLocalV4(parts: number[]): boolean {
  return parts[0] === 169 && parts[1] === 254;
}

// Multicast 224.0.0.0/4 + reserved 240.0.0.0/4 + broadcast 255.255.255.255.
function isMulticastOrReservedV4(parts: number[]): boolean {
  return parts[0] >= 224;
}

// Carrier-grade NAT 100.64.0.0/10 — also private-ish, reject by default.
function isCgnatV4(parts: number[]): boolean {
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return nums;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = parseIpv4(ip);
  if (!parts) {
    // Unparseable v4 — be conservative and reject.
    return true;
  }
  return (
    isLoopbackV4(parts) ||
    isUnspecifiedV4(parts) ||
    isRfc1918V4(parts) ||
    isLinkLocalV4(parts) ||
    isMulticastOrReservedV4(parts) ||
    isCgnatV4(parts)
  );
}

// Expand an IPv6 string to its 8 16-bit groups (lower-cased, full-width).
// Returns null on unparseable input. Handles "::" compression and embedded
// IPv4 (e.g. "::ffff:1.2.3.4").
function expandIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  // Strip zone id (e.g. "fe80::1%eth0").
  const zone = ip.indexOf("%");
  if (zone >= 0) {
    ip = ip.slice(0, zone);
  }
  // Embedded IPv4: convert the dotted tail to two hex groups.
  const lastColon = ip.lastIndexOf(":");
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = ip.indexOf("::");
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    const before = ip.slice(0, doubleColon);
    const after = ip.slice(doubleColon + 2);
    head = before === "" ? [] : before.split(":");
    tail = after === "" ? [] : after.split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    head = head.concat(new Array(missing).fill("0")).concat(tail);
  } else {
    head = ip.split(":");
    if (head.length !== 8) {
      return null;
    }
  }
  if (head.length !== 8) {
    return null;
  }
  const groups: number[] = [];
  for (const g of head) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) {
      return null;
    }
    groups.push(Number.parseInt(g, 16));
  }
  return groups;
}

function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) {
    return true;
  }
  // ::1 loopback or :: unspecified.
  const allZeroExceptLast =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0;
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — defer to v4 rules.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    (groups[5] === 0 || groups[5] === 0xff_ff)
  ) {
    const v4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return (
      isLoopbackV4(v4) ||
      isUnspecifiedV4(v4) ||
      isRfc1918V4(v4) ||
      isLinkLocalV4(v4) ||
      isMulticastOrReservedV4(v4) ||
      isCgnatV4(v4)
    );
  }
  // fc00::/7 unique local (fc.. or fd..).
  if ((groups[0] & 0xfe_00) === 0xfc_00) {
    return true;
  }
  // fe80::/10 link-local.
  if ((groups[0] & 0xff_c0) === 0xfe_80) {
    return true;
  }
  // ff00::/8 multicast.
  if ((groups[0] & 0xff_00) === 0xff_00) {
    return true;
  }
  // 64:ff9b::/96 NAT64, ::ffff:0:0/96 already handled above; treat 64:ff9b
  // as semi-private (it embeds a v4 destination).
  if (groups[0] === 0x64 && groups[1] === 0xff_9b) {
    const v4 = [
      (groups[6] >> 8) & 0xff,
      groups[6] & 0xff,
      (groups[7] >> 8) & 0xff,
      groups[7] & 0xff,
    ];
    return (
      isLoopbackV4(v4) ||
      isUnspecifiedV4(v4) ||
      isRfc1918V4(v4) ||
      isLinkLocalV4(v4) ||
      isMulticastOrReservedV4(v4) ||
      isCgnatV4(v4)
    );
  }
  return false;
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

function isLiteralIp(host: string): "v4" | "v6" | null {
  if (parseIpv4(host)) {
    return "v4";
  }
  if (host.includes(":")) {
    return expandIpv6(host) ? "v6" : null;
  }
  return null;
}

function rejectPort(port: number): string | null {
  if (port === 0) {
    return "port 0 is not allowed";
  }
  if (PORT_ALLOWLIST.has(port)) {
    return null;
  }
  if (port < 1024) {
    return `port ${port} is restricted; allowed low ports: ${[...PORT_ALLOWLIST]
      .filter((p) => p < 1024)
      .sort((a, b) => a - b)
      .join(", ")}`;
  }
  return null;
}

/**
 * Validate that a bare hostname (or IP literal) resolves to a public address.
 * Used by `assertPublicUrl` and by non-HTTP connectors (e.g. postgres URLs)
 * that need the same SSRF protection.
 */
export async function assertPublicHost(host: string): Promise<void> {
  const cleaned = stripBrackets(host);
  if (!cleaned) {
    throw new Error("host is empty");
  }
  const literal = isLiteralIp(cleaned);
  if (literal === "v4" && cleaned === CLOUD_METADATA_IPV4) {
    throw new Error("host targets cloud metadata endpoint");
  }
  if (literal === "v4" && isPrivateIpv4(cleaned)) {
    throw new Error(`host ${cleaned} is in a private range`);
  }
  if (literal === "v6" && isPrivateIpv6(cleaned)) {
    throw new Error(`host ${cleaned} is in a private range`);
  }
  if (literal) {
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(cleaned, { all: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DNS lookup failed for ${cleaned}: ${message}`);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${cleaned}`);
  }
  for (const addr of addresses) {
    if (addr.address === CLOUD_METADATA_IPV4) {
      throw new Error(`host ${cleaned} resolves to cloud metadata endpoint`);
    }
    if (addr.family === 4 && isPrivateIpv4(addr.address)) {
      throw new Error(
        `host ${cleaned} resolves to private address ${addr.address}`
      );
    }
    if (addr.family === 6 && isPrivateIpv6(addr.address)) {
      throw new Error(
        `host ${cleaned} resolves to private address ${addr.address}`
      );
    }
  }
}

/**
 * Validate that `input` points at a public IP, throwing on any URL that
 * resolves into a loopback / private / link-local / multicast / metadata
 * range. Use BEFORE every outbound `fetch(userControlledUrl, ...)` and
 * re-call on every redirect hop (set `redirect: "manual"` on the fetch).
 *
 * Returns the parsed `URL` on success so callers can pass `.toString()`
 * straight into `fetch`.
 */
export async function assertPublicUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `URL must use http: or https: (got ${url.protocol || "(empty)"})`
    );
  }

  const host = stripBrackets(url.hostname);
  if (!host) {
    throw new Error("URL has no hostname");
  }

  // Ports: reject explicit metadata-style probes and most low ports.
  const portStr = url.port;
  if (portStr) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`URL has an invalid port: ${portStr}`);
    }
    const portError = rejectPort(port);
    if (portError) {
      throw new Error(portError);
    }
  }

  await assertPublicHost(host);
  return url;
}
