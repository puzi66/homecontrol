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

/** Read the OS neighbour table. Uses Get-NetNeighbor on Windows, `arp -a` elsewhere. */
export async function readArpTable(): Promise<ArpEntry[]> {
  return process.platform === 'win32' ? readArpWindows() : readArpUnix();
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
