import { BlockList, isIP } from "node:net";

export interface CandidateMediaDnsAnswer {
  address: string;
  family: 4 | 6;
}

const VOLCANO_CANDIDATE_MEDIA_HOSTS = new Set([
  "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
  // Tokenhex's overseas Seedance route returns finished media from this
  // Volcano TOS region. Keep the Clash fake-IP exception host-exact and dev-only.
  "ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com",
  "ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com",
  // Candidate verification may deliberately relay a completed production
  // asset back into an isolated local runtime.  Clash-style fake DNS must be
  // accepted for this exact first-party delivery host under the same explicit
  // dev/test gate; arbitrary hosts and every production runtime still fail
  // closed below.
  "assets.fanjin.top",
  "cg-comfyui-prod.tos-cn-beijing.volces.com",
  // Private source reads use the signed bucket origin instead of the CDN.
  "fanjin-prod-assets-20260618.tos-s3-cn-beijing.volces.com",
]);
const CANDIDATE_FAKE_IP_ADDRESSES = new BlockList();
CANDIDATE_FAKE_IP_ADDRESSES.addSubnet("198.18.0.0", 15, "ipv4");

function ipv6Groups(rawAddress: string): number[] | null {
  let address = rawAddress.trim().toLowerCase();
  if (isIP(address) !== 6 || address.includes("%")) return null;

  const lastColon = address.lastIndexOf(":");
  const dottedTail = lastColon >= 0 ? address.slice(lastColon + 1) : "";
  if (dottedTail.includes(".")) {
    if (isIP(dottedTail) !== 4) return null;
    const octets = dottedTail.split(".").map(Number);
    address = `${address.slice(0, lastColon + 1)}${(
      octets[0] * 256 + octets[1]
    ).toString(16)}:${(
      octets[2] * 256 + octets[3]
    ).toString(16)}`;
  }

  const doubleColon = address.indexOf("::");
  if (doubleColon !== -1 && address.indexOf("::", doubleColon + 2) !== -1) {
    return null;
  }
  const left = (doubleColon === -1 ? address : address.slice(0, doubleColon))
    .split(":")
    .filter(Boolean);
  const right = (doubleColon === -1 ? "" : address.slice(doubleColon + 2))
    .split(":")
    .filter(Boolean);
  const missing = 8 - left.length - right.length;
  if ((doubleColon === -1 && missing !== 0) || (doubleColon !== -1 && missing < 1)) {
    return null;
  }
  const groups = [
    ...left,
    ...Array.from({ length: doubleColon === -1 ? 0 : missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, 16));
}

/** Extracts IPv4 from the two special ::ffff IPv4 embedding prefixes. */
export function embeddedIpv4FromIpv6Address(rawAddress: string): string | null {
  const groups = ipv6Groups(rawAddress);
  if (!groups) return null;
  const standardMapped = groups.slice(0, 6).every((group, index) => (
    group === [0, 0, 0, 0, 0, 0xffff][index]
  ));
  const translated = groups.slice(0, 6).every((group, index) => (
    group === [0, 0, 0, 0, 0xffff, 0][index]
  ));
  if (!standardMapped && !translated) return null;
  const high = groups[6];
  const low = groups[7];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Candidate-only compatibility for Clash-style RFC 2544 fake DNS answers.
 *
 * This must never become a generic private-address bypass: production,
 * arbitrary hosts, literal URL IPs, and every range except 198.18/15 still
 * fail closed. macOS may report the same Clash fake IP twice, once as IPv4 and
 * once as an IPv4-translatable IPv6 alias; only that exact alias is accepted.
 */
export function isCandidateVolcanoFakeIpDnsAnswer(
  url: URL,
  answer: CandidateMediaDnsAnswer,
): boolean {
  const hostname = url.hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  const environmentAllowsCompatibility = (
    process.env.NODE_ENV === "test"
    && process.env.FANJIN_REAL_CANDIDATE_ALLOW_VOLCANO_FAKE_IP_DNS === "1"
  ) || (
    ["dev", "development"].includes(process.env.NODE_ENV || "")
    && process.env.FANJIN_DEV_ALLOW_VOLCANO_FAKE_IP_DNS === "1"
  );
  let localStorageHostname: string | null = null;
  if (["dev", "development"].includes(process.env.NODE_ENV || "")
    && process.env.FANJIN_DEV_ALLOW_VOLCANO_FAKE_IP_DNS === "1") {
    try {
      const storageUrl = new URL(process.env.FANJIN_OBJECT_STORAGE_CDN_URL || "");
      if (storageUrl.protocol === "https:" && !storageUrl.username && !storageUrl.password
        && (storageUrl.port === "" || storageUrl.port === "443")) {
        localStorageHostname = storageUrl.hostname.toLowerCase().replace(/\.$/u, "");
      }
    } catch {}
  }
  let candidateIpv4: string | null = null;
  if (answer.family === 4 && isIP(answer.address) === 4) {
    candidateIpv4 = answer.address;
  } else if (answer.family === 6 && isIP(answer.address) === 6) {
    candidateIpv4 = embeddedIpv4FromIpv6Address(answer.address);
  }
  return (
    environmentAllowsCompatibility
    && url.protocol === "https:"
    && (url.port === "" || url.port === "443")
    && (VOLCANO_CANDIDATE_MEDIA_HOSTS.has(hostname) || hostname === localStorageHostname)
    && candidateIpv4 !== null
    && CANDIDATE_FAKE_IP_ADDRESSES.check(candidateIpv4, "ipv4")
  );
}
