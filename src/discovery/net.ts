import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NetworkInterfaceInfo } from './types.js';

const execFileAsync = promisify(execFile);

/** Run a PowerShell one-liner and return stdout. Empty string on failure. */
export async function powershell(script: string, timeoutMs = 20_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
  } catch {
    return '';
  }
}

export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  // >>> 0 keeps the result unsigned; a leading octet >= 128 would otherwise go negative.
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

export function netmaskToPrefix(mask: string): number {
  const n = ipToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) bits++;
    else break;
  }
  return bits;
}

/** Expand a CIDR into its usable host addresses (network and broadcast excluded). */
export function hostsInCidr(cidr: string, max = 4096): string[] {
  const [base, prefixRaw] = cidr.split('/');
  if (!base || !prefixRaw) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(base) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  // /31 and /32 have no separate network/broadcast addresses.
  if (prefix >= 31) {
    const out: string[] = [];
    for (let n = network; n <= broadcast; n++) out.push(intToIp(n));
    return out;
  }

  const out: string[] = [];
  for (let n = network + 1; n < broadcast && out.length < max; n++) out.push(intToIp(n));
  return out;
}

export function hostCountForPrefix(prefix: number): number {
  if (prefix >= 31) return 2 ** (32 - prefix);
  return Math.max(0, 2 ** (32 - prefix) - 2);
}

/** Broadcast address for a CIDR, used for miio/SSDP broadcasts. */
export function broadcastForCidr(cidr: string): string {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(base!) & mask) >>> 0;
  return intToIp((network | (~mask >>> 0)) >>> 0);
}

/**
 * Ask Windows which adapters are wireless. Falls back to an empty set on
 * non-Windows or when the cmdlet is unavailable, in which case media is 'unknown'.
 */
async function wirelessAdapterNames(): Promise<Set<string>> {
  if (process.platform !== 'win32') return new Set();
  const out = await powershell(
    "Get-NetAdapter -Physical -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.PhysicalMediaType -match 'Wireless|802.11' -or $_.InterfaceDescription -match 'Wi-Fi|Wireless|WLAN' } | " +
      'Select-Object -ExpandProperty Name',
  );
  return new Set(
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * Every active IPv4 interface with a real subnet, deduplicated by CIDR.
 * Loopback and APIPA (169.254.x) addresses are skipped.
 */
export async function activeInterfaces(): Promise<NetworkInterfaceInfo[]> {
  const wireless = await wirelessAdapterNames();
  const out: NetworkInterfaceInfo[] = [];
  const seen = new Set<string>();

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;

      let prefix: number;
      try {
        prefix = netmaskToPrefix(a.netmask);
      } catch {
        continue;
      }
      // A /32 has no neighbours to find, and anything wider than /16 is not a home LAN.
      if (prefix >= 32 || prefix < 16) continue;

      const network = intToIp((ipToInt(a.address) & (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)) >>> 0);
      const cidr = `${network}/${prefix}`;
      if (seen.has(cidr)) continue;
      seen.add(cidr);

      out.push({
        name,
        address: a.address,
        mac: normaliseMac(a.mac),
        netmask: a.netmask,
        cidr,
        hostCount: hostCountForPrefix(prefix),
        media: wireless.has(name) ? 'wifi' : wireless.size > 0 ? 'wired' : 'unknown',
      });
    }
  }

  return out;
}

/** Normalise any MAC spelling to lowercase colon form, or null if unusable. */
export function normaliseMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  if (hex === '000000000000' || hex === 'ffffffffffff') return null;
  return hex.match(/.{2}/g)!.join(':');
}
