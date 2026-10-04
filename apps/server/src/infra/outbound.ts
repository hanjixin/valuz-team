/**
 * Guard for requests the server makes to an address a user supplied (a model
 * channel's endpoint, a connector's URL). Without it any member could make the
 * server probe its own network — cloud metadata, internal services, localhost.
 */
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { Config } from "./config.ts";

export class BlockedAddressError extends Error {}

function isPublic(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  return parsed.range() === "unicast";
}

/**
 * Throws unless `url` is http(s) and resolves only to public addresses.
 * `ALLOW_PRIVATE_UPSTREAMS=1` lifts the address check for self-hosted setups
 * whose model gateway lives on the same private network.
 */
export async function assertOutboundAllowed(config: Config, url: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new BlockedAddressError("not a valid URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:")
    throw new BlockedAddressError("only http and https endpoints are allowed");
  if (config.ALLOW_PRIVATE_UPSTREAMS) return;
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw new BlockedAddressError(`cannot resolve ${host}`);
  if (!addresses.every(isPublic))
    throw new BlockedAddressError("this endpoint is on a private network, which the server does not call");
}
