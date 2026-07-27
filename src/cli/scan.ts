/** Standalone scan runner: `pnpm scan`. Prints a table of everything found. */
import { scanNetwork } from '../discovery/index.js';

const args = new Set(process.argv.slice(2));

const result = await scanNetwork(
  {
    skipPortScan: args.has('--no-ports'),
    skipWifi: args.has('--no-wifi'),
  },
  (event) => {
    if (event.phase === 'stage') console.log(`  … ${event.message}`);
  },
);

console.log('\nInterfaces');
for (const i of result.interfaces) {
  console.log(`  ${i.name.padEnd(14)} ${i.address.padEnd(16)} ${i.cidr.padEnd(19)} ${i.media}`);
}

console.log(`\nDevices (${result.devices.length})`);
console.log(
  `  ${'IP'.padEnd(16)}${'MAC'.padEnd(19)}${'KIND'.padEnd(10)}${'VENDOR'.padEnd(30)}${'NAME'.padEnd(24)}PORTS`,
);
for (const d of result.devices) {
  console.log(
    `  ${d.ip.padEnd(16)}${(d.mac ?? '-').padEnd(19)}${d.kind.padEnd(10)}` +
      `${(d.vendor ?? '-').slice(0, 28).padEnd(30)}${(d.hostname ?? '-').slice(0, 22).padEnd(24)}` +
      `${d.openPorts.join(',') || '-'}`,
  );
  const notable = Object.entries(d.evidence).filter(([k]) => k.startsWith('miio') || k === 'modelName');
  for (const [k, v] of notable) console.log(`      ${k} = ${v}`);
}

if (result.wifiNetworks.length > 0) {
  console.log(`\nWiFi networks (${result.wifiNetworks.length})`);
  for (const w of result.wifiNetworks.slice(0, 15)) {
    const mark = w.connected ? '*' : ' ';
    console.log(
      `  ${mark} ${w.ssid.slice(0, 28).padEnd(30)}${String(w.signal ?? '-').padStart(3)}%  ` +
        `ch ${String(w.channel ?? '-').padStart(3)}  ${w.band ?? ''}  ${w.authentication ?? ''}`,
    );
  }
}

console.log(`\nDone in ${result.durationMs}ms`);
