import dgram from 'node:dgram';
import { logger } from '../logger.js';
import { hostsInCidr, normaliseMac, powershell } from './net.js';

const log = logger('arp');

export interface ArpEntry {
  ip: string;
  mac: string;
  state: string;
}

/**
 * Nudge every host in the subnet so the OS resolves its MAC.
 *
 * We send a single UDP datagram to a high, almost certainly closed port. We do
 * not care about a reply — the point is that the kernel must ARP for the target
 * before it can send, which populates the neighbour table. This needs no raw
 * sockets and therefore no administrator rights, unlike ICMP ping.
 */
export async function pokeSubnet(cidr: string, concurrency: number, maxHosts: number): Promise<number> {
  const hosts = hostsInCidr(cidr, maxHosts);
  const socket = dgram.createSocket('udp4');
  // Errors here are expected and meaningless (ICMP port-unreachable comes back
  // as an async socket error on Windows); swallow them so we do not crash.
  socket.on('error', () => {});

  await new Promise<void>((resolve) => socket.bind(resolve));

  let cursor = 0;
  const payload = Buffer.from([0x00]);

  async function worker() {
    while (cursor < hosts.length) {
      const ip = hosts[cursor++]!;
      await new Promise<void>((resolve) => {
        try {
          socket.send(payload, 0, payload.length, 33_434, ip, () => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));

  // Give the stack a moment to complete the ARP exchanges we just triggered.
  await new Promise((r) => setTimeout(r, 1500));
  socket.close();

  log.debug(`poked ${hosts.length} hosts in ${cidr}`);
  return hosts.length;
}

/**
 * Read the OS neighbour table.
 *
 * Strategy per platform, first one that yields rows wins:
 *   Windows — Get-NetNeighbor, falling back to `arp -a`
 *   Linux / Android / macOS — `ip neigh`, then `arp -a`, then /proc/net/arp
 *
 * On Android none of these may work. `arp` and `ip` are not in the base Termux
 * install, and /proc/net/arp has been unreadable by unprivileged apps since
 * Android 10. When every strategy comes back empty the caller falls back to the
 * TCP liveness sweep in ./liveness.ts, which finds fewer devices but needs no
 * privileges at all.
 */
export async function readArpTable(): Promise<ArpEntry[]> {
  if (process.platform === 'win32') return readArpWindows();

  for (const strategy of [readIpNeigh, readArpUnix, readProcNetArp]) {
    const entries = await strategy();
    if (entries.length > 0) return entries;
  }
  log.debug('no neighbour table available on this platform');
  return [];
}

/** `ip neigh` — present on most Linux distros and in Termux with iproute2. */
async function readIpNeigh(): Promise<ArpEntry[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('ip', ['neigh', 'show'], { timeout: 15_000 }));
  } catch {
    return [];
  }

  const entries: ArpEntry[] = [];
  // "192.168.1.1 dev wlan0 lladdr b0:bb:e5:77:a7:b7 REACHABLE"
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\s.*lladdr\s+([0-9a-fA-F:]{17})\s*(\w+)?/.exec(line.trim());
    if (!m) continue;
    const mac = normaliseMac(m[2]!);
    if (!mac) continue;
    const state = (m[3] ?? 'unknown').toLowerCase();
    if (state === 'failed' || state === 'incomplete') continue;
    entries.push({ ip: m[1]!, mac, state });
  }
  return entries;
}

/** /proc/net/arp — readable on older Android and most Linux. */
async function readProcNetArp(): Promise<ArpEntry[]> {
  const fs = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await fs.readFile('/proc/net/arp', 'utf8');
  } catch {
    return [];
  }

  const entries: ArpEntry[] = [];
  for (const line of raw.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const mac = normaliseMac(cols[3]);
    if (!mac || !/^\d{1,3}(\.\d{1,3}){3}$/.test(cols[0]!)) continue;
    entries.push({ ip: cols[0]!, mac, state: 'stale' });
  }
  return entries;
}

async function readArpWindows(): Promise<ArpEntry[]> {
  const out = await powershell(
    'Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | ' +
      "Where-Object { $_.State -ne 'Unreachable' -and $_.State -ne 'Incomplete' } | " +
      'ForEach-Object { "$($_.IPAddress)|$($_.LinkLayerAddress)|$($_.State)" }',
  );

  const entries: ArpEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [ip, macRaw, state] = line.trim().split('|');
    if (!ip || !macRaw) continue;
    const mac = normaliseMac(macRaw);
    if (!mac) continue; // filters broadcast/multicast placeholder rows
    if (ip.endsWith('.255') || ip.startsWith('224.') || ip.startsWith('239.')) continue;
    entries.push({ ip, mac, state: state ?? 'unknown' });
  }

  // Fall back to arp -a if the cmdlet produced nothing (older Windows, restricted shell).
  return entries.length > 0 ? entries : readArpUnix();
}

async function readArpUnix(): Promise<ArpEntry[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('arp', ['-a'], { timeout: 15_000, windowsHide: true }));
  } catch {
    return [];
  }

  const entries: ArpEntry[] = [];
  // Matches both "? (192.168.1.1) at aa:bb:.." and Windows' "  192.168.1.1   aa-bb-.. dynamic"
  const re = /(\d{1,3}(?:\.\d{1,3}){3})[^\da-fA-F]+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;
  for (const m of stdout.matchAll(re)) {
    const ip = m[1]!;
    const mac = normaliseMac(m[2]!);
    if (!mac) continue;
    if (ip.endsWith('.255') || ip.startsWith('224.') || ip.startsWith('239.')) continue;
    entries.push({ ip, mac, state: 'stale' });
  }
  return entries;
}
