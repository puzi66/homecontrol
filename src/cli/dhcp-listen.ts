/**
 * Listen for DHCP traffic and report what each client says about itself.
 *
 *   npx tsx src/cli/dhcp-listen.ts [minutes]
 *
 * Clients broadcast DISCOVER and REQUEST to 255.255.255.255:67, and those
 * packets carry fields a device will not reveal any other way:
 *
 *   option 12  hostname
 *   option 60  vendor class identifier — often names the firmware or vendor
 *   option 55  parameter request list — the ordering is a stack fingerprint
 *   option 61  client identifier
 *
 * This is the last passive avenue for a device that answers no probe and
 * broadcasts nothing else. The catch is timing: a client only speaks when it
 * boots or renews its lease, so with a one-hour lease you may wait half an hour
 * to hear from one. Binding port 67 usually needs administrator rights.
 */
import dgram from 'node:dgram';

const minutes = Number(process.argv[2] ?? 45);

const MESSAGE_TYPES: Record<number, string> = {
  1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 4: 'DECLINE',
  5: 'ACK', 6: 'NAK', 7: 'RELEASE', 8: 'INFORM',
};

interface Seen {
  mac: string;
  hostname: string | null;
  vendorClass: string | null;
  clientId: string | null;
  paramList: string | null;
  types: Set<string>;
  count: number;
}

const seen = new Map<string, Seen>();

function parse(buf: Buffer): void {
  // Minimum BOOTP frame plus the magic cookie.
  if (buf.length < 240) return;
  if (buf.readUInt32BE(236) !== 0x63825363) return;

  const mac = [...buf.subarray(28, 34)].map((b) => b.toString(16).padStart(2, '0')).join(':');

  const entry = seen.get(mac) ?? {
    mac,
    hostname: null,
    vendorClass: null,
    clientId: null,
    paramList: null,
    types: new Set<string>(),
    count: 0,
  };
  entry.count += 1;

  let at = 240;
  while (at < buf.length) {
    const code = buf[at]!;
    if (code === 255) break; // end
    if (code === 0) { at += 1; continue; } // pad

    const len = buf[at + 1] ?? 0;
    const value = buf.subarray(at + 2, at + 2 + len);
    at += 2 + len;

    switch (code) {
      case 53:
        entry.types.add(MESSAGE_TYPES[value[0] ?? 0] ?? String(value[0]));
        break;
      case 12:
        entry.hostname ??= value.toString('utf8').replace(/\0/g, '');
        break;
      case 60:
        entry.vendorClass ??= value.toString('utf8').replace(/\0/g, '');
        break;
      case 61:
        entry.clientId ??= value.toString('hex');
        break;
      case 55:
        entry.paramList ??= [...value].join(',');
        break;
      default:
        break;
    }
  }

  seen.set(mac, entry);

  const label = entry.vendorClass || entry.hostname || '(nothing named)';
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${mac}  ${[...entry.types].join('/')}  ${label}`);
}

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', (err) => {
  console.error(`cannot bind UDP 67: ${err.message}`);
  console.error('Ports below 1024 need administrator rights on Windows.');
  process.exit(1);
});

socket.on('message', (buf) => {
  try {
    parse(buf);
  } catch {
    /* malformed packet, ignore */
  }
});

socket.bind(67, () => {
  socket.setBroadcast(true);
  console.log(`listening on UDP 67 for ${minutes} minutes.`);
  console.log('Clients speak on boot and at lease renewal — power-cycling a device makes it talk immediately.\n');
});

await new Promise((r) => setTimeout(r, minutes * 60_000));
socket.close();

console.log(`\n${'='.repeat(64)}`);
console.log(`${seen.size} client(s) heard\n`);
for (const e of [...seen.values()].sort((a, b) => a.mac.localeCompare(b.mac))) {
  console.log(`${e.mac}   x${e.count}   ${[...e.types].join('/')}`);
  console.log(`  hostname      ${e.hostname ?? '—'}`);
  console.log(`  vendor class  ${e.vendorClass ?? '—'}`);
  console.log(`  param list    ${e.paramList ?? '—'}`);
  console.log(`  client id     ${e.clientId ?? '—'}`);
}
