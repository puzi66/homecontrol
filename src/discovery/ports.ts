import net from 'node:net';

/**
 * Ports that actually tell us something about a home device. Deliberately short —
 * this is fingerprinting to identify a device, not a security scan.
 */
export const FINGERPRINT_PORTS: number[] = [
  22,    // ssh
  80,    // http admin / Hue API
  443,   // https
  445,   // smb — a PC or NAS
  554,   // rtsp — camera
  631,   // ipp — printer
  1400,  // Sonos control
  1883,  // mqtt broker
  3689,  // DAAP / AirPlay
  5000,  // synology / upnp
  5353,  // mdns (tcp variant, rare but telling)
  5577,  // magic home / ledenet LED controller
  6053,  // esphome native api
  6668,  // tuya local control
  8008,  // chromecast
  8009,  // chromecast tls
  8080,  // http alt
  8081,  // seen on cheap ESP smart devices; proprietary, silent to probes
  8123,  // home assistant
  8443,  // https alt
  9100,  // raw printing
  32400, // plex
];

/** Try to open a TCP connection; resolve true only on a completed handshake. */
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

/** Scan the fingerprint port list against one host. */
export async function scanPorts(ip: string, timeoutMs: number): Promise<number[]> {
  const results = await Promise.all(
    FINGERPRINT_PORTS.map(async (port) => ((await checkPort(ip, port, timeoutMs)) ? port : null)),
  );
  return results.filter((p): p is number => p !== null);
}

/**
 * Scan many hosts, capping the number of sockets open across the whole batch.
 *
 * The cap matters more than it looks. Scanning per-host — N hosts in flight,
 * each opening every port at once — multiplies out to hundreds of concurrent
 * sockets, and the resulting contention makes connects time out against ports
 * that are genuinely open. That shows up as ports randomly disappearing between
 * scans. So the work queue is flat over (host, port) pairs with one global
 * budget, and each probe gets a timeout long enough to survive a slow device.
 */
export async function scanPortsBatch(
  ips: string[],
  timeoutMs: number,
  socketBudget = 96,
  onHost?: (ip: string, ports: number[]) => void,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>(ips.map((ip) => [ip, []]));

  const jobs: { ip: string; port: number }[] = [];
  for (const ip of ips) {
    for (const port of FINGERPRINT_PORTS) jobs.push({ ip, port });
  }

  const remaining = new Map(ips.map((ip) => [ip, FINGERPRINT_PORTS.length]));
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]!;
      if (await checkPort(job.ip, job.port, timeoutMs)) {
        out.get(job.ip)!.push(job.port);
      }

      // Report a host once every one of its ports has been answered for.
      const left = remaining.get(job.ip)! - 1;
      remaining.set(job.ip, left);
      if (left === 0) onHost?.(job.ip, out.get(job.ip)!.sort((a, b) => a - b));
    }
  }

  await Promise.all(Array.from({ length: Math.min(socketBudget, jobs.length) }, worker));
  return out;
}
