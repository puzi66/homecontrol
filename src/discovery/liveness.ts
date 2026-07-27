import net from 'node:net';
import { logger } from '../logger.js';

const log = logger('liveness');

/**
 * Find live hosts without reading the neighbour table.
 *
 * The ARP sweep is the best host-finder we have — it sees every device with an
 * IP, whether or not it listens on anything. But it depends on the OS exposing
 * its neighbour table, and Android does not: `arp` and `ip` are absent from a
 * base Termux install and /proc/net/arp has been unreadable by unprivileged
 * apps since Android 10.
 *
 * So this is the fallback: try to open a TCP connection to a small set of ports
 * on every address in the subnet. A completed handshake proves the host is
 * there. No privileges, no platform-specific commands.
 *
 * The honest limitation: a device with no open TCP ports is invisible to this.
 * Plenty of cloud-only IoT gear holds an outbound connection and listens on
 * nothing at all — those show up under an ARP sweep and cannot show up here.
 * Discovery reports which method it used so the gap is visible rather than
 * silently pretended away.
 */

/**
 * Ports chosen for hit rate rather than for fingerprinting: between them these
 * cover routers, PCs, printers, casting targets and the smart-home protocols
 * this project speaks.
 */
const LIVENESS_PORTS = [
  80,    // http — routers, cameras, a great many IoT devices
  443,   // https
  22,    // ssh
  445,   // smb — PCs and NAS boxes
  1400,  // sonos
  5577,  // magic home / ledenet
  6668,  // tuya local control
  8009,  // chromecast
  8081,  // seen on cheap ESP devices
];

function checkPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));

    try {
      socket.connect(port, ip);
    } catch {
      done(false);
    }
  });
}

export interface LiveHost {
  ip: string;
  openPorts: number[];
}

/**
 * Sweep a list of addresses. Uses one flat work queue over (host, port) pairs
 * with a single global socket budget — the same reason as the fingerprint pass:
 * scanning per-host opens hundreds of sockets at once and the contention makes
 * genuinely open ports time out.
 *
 * Stops probing a host as soon as one port answers; liveness is the only
 * question here, and the fingerprint pass will enumerate ports properly later.
 */
export async function tcpLivenessSweep(
  ips: string[],
  timeoutMs = 1200,
  socketBudget = 128,
  onHost?: (host: LiveHost) => void,
): Promise<LiveHost[]> {
  const found = new Map<string, number[]>();
  const settled = new Set<string>();

  const jobs: { ip: string; port: number }[] = [];
  // Port-major order, so every host gets its port 80 probe before any host gets
  // its port 8081 probe. Common ports therefore resolve most hosts early.
  for (const port of LIVENESS_PORTS) {
    for (const ip of ips) jobs.push({ ip, port });
  }

  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]!;
      if (settled.has(job.ip)) continue; // already proven alive

      if (await checkPort(job.ip, job.port, timeoutMs)) {
        settled.add(job.ip);
        const ports = [job.port];
        found.set(job.ip, ports);
        onHost?.({ ip: job.ip, openPorts: ports });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(socketBudget, jobs.length) }, worker));

  const hosts = [...found.entries()].map(([ip, openPorts]) => ({ ip, openPorts }));
  log.info(`TCP liveness sweep found ${hosts.length} host(s) across ${ips.length} address(es)`);
  return hosts;
}
