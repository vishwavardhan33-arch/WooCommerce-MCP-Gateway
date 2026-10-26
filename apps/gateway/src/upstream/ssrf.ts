import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// SSRF (server-side request forgery): the gateway makes HTTP requests to URLs that admins type in.
// A URL like http://169.254.169.254/ would make the gateway read the cloud provider's metadata
// service (which hands out credentials) and relay it. This guard decides which URLs we may call.
//
// Two rules:
//   1. ALWAYS blocked, no override: link-local and cloud-metadata addresses.
//   2. Blocked unless the hostname is in UPSTREAM_ALLOWED_HOSTS: private / cluster-internal addresses.
//      The woo-mcp server lives at a cluster-internal address, so it is allowlisted by name.
// Everything else (public internet) is allowed.

export class SsrfError extends Error {}

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"; 0.0.0.0 can reach localhost on some systems
alwaysBlocked.addSubnet("169.254.0.0", 16, "ipv4"); // IPv4 link-local, includes the metadata address 169.254.169.254
alwaysBlocked.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata (lives inside the 100.64/10 range)
alwaysBlocked.addSubnet("fe80::", 10, "ipv6"); // IPv6 link-local
alwaysBlocked.addAddress("fd00:ec2::254", "ipv6"); // AWS IPv6 metadata

const internal = new BlockList();
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
internal.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT, used by some cluster networks
internal.addAddress("::1", "ipv6"); // loopback
internal.addSubnet("fc00::", 7, "ipv6"); // IPv6 private (unique local)

// Names that mean "the metadata service" even before DNS is asked.
const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);

// An IPv4 address written inside IPv6 ("::ffff:169.254.169.254") reaches the same machine, so it
// must be judged as the IPv4 address it contains. The URL parser rewrites it to hex form
// ("::ffff:a9fe:a9fe"), so both spellings are handled. Without this, the metadata block is bypassable.
function unmapIPv4(ip: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return ip;
}

// "host" matches an entry exactly, or an entry like "*.svc.cluster.local" matches any subdomain.
// The dot in the suffix matters: "*.svc.cluster.local" must not match "evilsvc.cluster.local".
function isAllowlisted(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry,
  );
}

export interface SsrfOptions {
  allowedHosts: string[];
  /** Replaceable in tests so they need no real DNS. Returns every address the name resolves to. */
  lookup?: (hostname: string) => Promise<string[]>;
}

const defaultLookup = async (hostname: string): Promise<string[]> =>
  (await dnsLookup(hostname, { all: true })).map((r) => r.address);

/**
 * Throws SsrfError (with a message an admin can act on) unless the URL may be called.
 * Call it when a server is REGISTERED and again every time the gateway CONNECTS: DNS answers can
 * change after registration (DNS rebinding), so a check done once is not enough.
 * Known limit: a name could still change between this check and the connection a moment later;
 * closing that gap needs connecting to the checked IP directly, which we do not do.
 */
export async function assertUrlAllowed(rawUrl: string, options: SsrfOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("The URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`The URL scheme "${url.protocol}" is not allowed; use http or https`);
  }
  if (url.username || url.password) {
    throw new SsrfError("The URL must not contain a username or password; use the credential field instead");
  }

  // url.hostname is lower-case already; IPv6 literals come wrapped in [ ].
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfError(`The host "${host}" is a cloud metadata service and is never allowed`);
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (options.lookup ?? defaultLookup)(host);
    } catch {
      throw new SsrfError(`The host "${host}" could not be resolved`);
    }
  }
  if (addresses.length === 0) throw new SsrfError(`The host "${host}" could not be resolved`);

  const allowlisted = isAllowlisted(host, options.allowedHosts);
  // EVERY address must pass: a name that resolves to one public and one internal address is blocked.
  for (const address of addresses) {
    const ip = unmapIPv4(address);
    const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
    if (alwaysBlocked.check(ip, family)) {
      throw new SsrfError(`The host "${host}" points at a link-local or cloud-metadata address (${ip}), which is never allowed`);
    }
    if (internal.check(ip, family) && !allowlisted) {
      throw new SsrfError(
        `The host "${host}" points at an internal address (${ip}). If this is intended, add "${host}" to UPSTREAM_ALLOWED_HOSTS`,
      );
    }
  }
  return url;
}
