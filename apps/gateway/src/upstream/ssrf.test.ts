import { describe, expect, it } from "vitest";
import { assertUrlAllowed, SsrfError, type SsrfOptions } from "./ssrf.js";

// DNS is faked: each test says what a name "resolves" to.
const dns = (map: Record<string, string[]>): SsrfOptions["lookup"] => async (host) => {
  const found = map[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};
const opts = (allowedHosts: string[] = [], map: Record<string, string[]> = {}): SsrfOptions => ({ allowedHosts, lookup: dns(map) });
const blocked = (url: string, o: SsrfOptions) => expect(assertUrlAllowed(url, o)).rejects.toBeInstanceOf(SsrfError);

describe("always blocked: metadata and link-local", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.0.1/",
    "http://[fe80::1]/",
    "http://[fd00:ec2::254]/",
    "http://100.100.100.200/",
    "http://0.0.0.0/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ])("%s", (url) => blocked(url, opts()));

  it("even when the host is on the allowlist", async () => {
    await blocked("http://169.254.169.254/", opts(["169.254.169.254"]));
    await blocked("http://metadata.google.internal/", opts(["metadata.google.internal"]));
  });

  it("IPv4 hidden inside IPv6, in both spellings", async () => {
    await blocked("http://[::ffff:169.254.169.254]/", opts());
    await blocked("http://[::ffff:a9fe:a9fe]/", opts());
  });

  it("a normal-looking name that RESOLVES to a metadata address (DNS rebinding)", async () => {
    await blocked("http://innocent.example.com/", opts(["innocent.example.com"], { "innocent.example.com": ["169.254.169.254"] }));
  });
});

describe("internal addresses need the allowlist", () => {
  it.each(["http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.1/", "http://127.0.0.1:3000/", "http://[::1]/", "http://localhost/"])(
    "%s is blocked by default",
    (url) => blocked(url, opts([], { localhost: ["127.0.0.1"] })),
  );

  it("the decimal spelling of 127.0.0.1 is still recognised", () => blocked("http://2130706433/", opts()));

  it("an allowlisted name may resolve to a private address", async () => {
    const o = opts(["platform-woo-mcp"], { "platform-woo-mcp": ["10.43.12.7"] });
    await expect(assertUrlAllowed("http://platform-woo-mcp/mcp", o)).resolves.toBeInstanceOf(URL);
  });

  it("an allowlisted IP literal is allowed", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1:9000/mcp", opts(["127.0.0.1"]))).resolves.toBeInstanceOf(URL);
  });

  it("wildcards match subdomains only", async () => {
    const map = { "woo.platform.svc.cluster.local": ["10.43.0.9"], "evilsvc.cluster.local": ["10.43.0.9"], "svc.cluster.local": ["10.43.0.9"] };
    const o = opts(["*.svc.cluster.local"], map);
    await expect(assertUrlAllowed("http://woo.platform.svc.cluster.local/", o)).resolves.toBeInstanceOf(URL);
    await blocked("http://evilsvc.cluster.local/", o);
    await blocked("http://svc.cluster.local/", o);
  });

  it("a name that is not allowlisted but resolves to a private address is blocked", () =>
    blocked("http://intranet.example.com/", opts([], { "intranet.example.com": ["10.1.2.3"] })));

  it("one internal address among public ones is enough to block", () =>
    blocked("http://mixed.example.com/", opts([], { "mixed.example.com": ["93.184.216.34", "10.1.2.3"] })));
});

describe("allowed", () => {
  it("a public name and a public IP, including just outside the private 172.16/12 range", async () => {
    await expect(assertUrlAllowed("https://mcp.example.com/mcp", opts([], { "mcp.example.com": ["93.184.216.34"] }))).resolves.toBeInstanceOf(URL);
    await expect(assertUrlAllowed("http://172.32.0.1/", opts())).resolves.toBeInstanceOf(URL);
  });
});

describe("malformed input", () => {
  it.each(["not a url", "file:///etc/passwd", "ftp://example.com/", "http://user:pw@example.com/"])("%s", (url) =>
    blocked(url, opts([], { "example.com": ["93.184.216.34"] })),
  );

  it("a name that does not resolve is rejected with a clear message", async () => {
    await expect(assertUrlAllowed("http://nope.invalid/", opts())).rejects.toThrow(/could not be resolved/);
  });
});
