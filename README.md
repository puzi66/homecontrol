# homecontrol

A local home control system for the devices on your own network. It does three things:

1. **Discovers** everything on the LAN — including devices that never answer a ping — and works out what each one is.
2. **Keeps a registry** of the devices you actually care about, with names, rooms and drivers.
3. **Controls them**, either directly over their local protocols or through Home Assistant.

Everything runs on this machine and talks to devices over the LAN. No vendor cloud is involved except where a device gives you no other option.

---

## Running it

```bash
pnpm install
pnpm dev
```

Then open <http://localhost:9123>.

Hit **Add device** to sweep the network. Adopt whatever you want to control, give it a name and a room, and it lands on the dashboard.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dashboard + API with hot reload |
| `pnpm build` / `pnpm start` | Compiled production run |
| `pnpm typecheck` | Type check without emitting |
| `pnpm scan` | One-off scan straight to the terminal |
| `npx tsx src/cli/identify.ts [ip...]` | Vendor-specific probes (Tuya, Broadlink, extended ports, HTTP banners) |
| `npx tsx src/cli/miio-probe.ts [ip]` | Diagnose miio reachability for a specific device |

The interface is Hebrew and right-to-left. Latin technical values — addresses, MACs, port lists — are pinned LTR so bidi reordering cannot mangle them.

Configuration lives in `.env` — copy `.env.example` and edit. Every value has a working default except `HA_TOKEN`.

---

## Handing this to someone else

The project is portable; the state in `data/` is not. Ship the source, never the state.

### What to send

Everything except `node_modules/`, `dist/`, `data/` and `.env`. That is about 320 KB of source. `.gitignore` already excludes all four, so a `git archive` or a plain zip minus those directories is correct.

**`data/` must not travel.** It holds the device inventory for this house — every MAC and IP on the network — and `devices.json` also stores `driverConfig`, which is where the Hue bridge username and the vacuum token live once configured. Those are credentials to someone's home.

### What the recipient does

```bash
pnpm install
pnpm build
pnpm start
```

Then open <http://localhost:9123> and press **הוספת מכשיר** to sweep *their* network. Nothing is hardcoded to this house: subnets come from whatever adapters the machine has, and the device registry starts empty. Verified — a clean copy with no `data/` boots to zero devices and builds its own state from the first scan.

Optionally copy `.env.example` to `.env` and set `HOMECONTROL_LAT` / `HOMECONTROL_LON` so sunrise and sunset match their location. The default is Tel Aviv.

### Three things to tell them up front

**1. There is no authentication.** The server binds `0.0.0.0`, so anyone on the same LAN can open the dashboard and switch their devices on and off. That is fine on a trusted home network and not fine anywhere else. To limit it to the machine itself, set `HOMECONTROL_HOST=127.0.0.1`. Do not port-forward it.

**2. It is Windows-first.** Full functionality — the ARP sweep, WiFi listing, wireless-adapter labelling and gateway detection — is implemented against `powershell.exe` and `netsh`. On macOS or Linux the code degrades rather than crashes: `readArpTable()` falls back to `arp -a`, and the WiFi list and gateway detection return empty. That fallback path is written but **has not been tested on a non-Windows machine** — treat macOS/Linux as unverified, not as supported.

**3. Do not put the discovery engine in a container.** Docker Desktop on Windows and macOS cannot give a container real host networking, and without it the container sits on a private bridge network and sees none of the LAN — which is the entire point of this app. Run the Node process natively. The container in `docker-compose.yml` is for Home Assistant only.

## How discovery works

A plain ping sweep misses most smart devices, because plenty of them ignore ICMP. This runs eight passes instead, and merges the results by IP:

| Pass | What it catches |
| --- | --- |
| **ARP sweep** | Everything with an IP. Sends a UDP datagram to each address so the OS has to resolve its MAC, then reads the neighbour table. Needs no admin rights, unlike raw ICMP. |
| **mDNS** | Names and service types — Chromecast, Sonos, HomeKit, ESPHome, Matter, printers. |
| **SSDP/UPnP** | Model and manufacturer strings, pulled from each device's description XML. |
| **miio** | Xiaomi / Dreame / MOVA devices, via their handshake on UDP 54321. |
| **Broadlink** | IR blasters and plugs, via their discovery probe on UDP 80. Returns an exact model code and the device's own name. |
| **Magic Home** | LED controllers on TCP 5577, confirmed by handshake — also reports power state and current colour. |
| **TCP fingerprint** | ~22 ports that identify a device (1400 = Sonos, 8009 = Cast, 5577 = LED controller, 6668 = Tuya, 631 = printer…). |
| **Reverse DNS + OUI** | Hostnames, and the vendor behind each MAC. |

A ninth pass, the **Tuya** listener, only runs on a *deep scan* (the checkbox in the scan dialog, or `{"deep":true}` on the API). Tuya devices announce themselves on their own schedule rather than on request, so catching one means sitting on UDP 6666/6667 for ~25 seconds. Without it you still see that a host has port 6668 open — you just do not get its device id and product key.

### Two reliability traps, both fixed

**Broadcast replies drop.** Measured against real hardware, a single miio broadcast round reliably loses one responder or another — repeat runs each missed a different device. Broadcast passes therefore repeat, and miio additionally unicast-probes every host the ARP pass found; the unicast pass is what actually decides whether something speaks miio.

**Port scans drop under their own load.** Scanning per-host, with each host opening every port at once, multiplies out to hundreds of concurrent sockets; the contention makes connects time out against ports that are genuinely open, so ports appear to vanish between scans. The fingerprint pass uses one flat work queue over (host, port) pairs with a single global socket budget, and a timeout long enough for slow IoT firmware. This is why a scan takes ~27s rather than ~14s — the extra time buys reproducible results.

Results are then classified into a device kind (`vacuum`, `speaker`, `hub`, `light`…) with a confidence level and a suggested driver.

**On the wireless question:** devices joined to the router's WiFi are ordinary IP hosts on the same subnet, so the sweep above already covers them — there is nothing separate to do. The **Wireless** tab is a different thing: it lists WiFi *access points in range* of this machine, via `netsh wlan`.

### A note on miio reliability

The miio broadcast is lossy — a single broadcast round reliably drops one responder or another, and which one it drops varies between runs. So discovery broadcasts three times **and** then unicast-probes every host the ARP pass found. The unicast pass is what actually decides whether something speaks miio; treat the broadcast as a fast first guess.

---

## Automations and scenes

A **scene** is a named list of actions you run in one tap — "לילה טוב" turns the lights off and docks the vacuum.

A **rule** is a sentence: *when* something happens, *only if* some conditions hold, *then* do these actions. The builder is a row of dropdowns that reads left-to-right as Hebrew; there is no YAML anywhere in the product.

**Triggers** — a wall-clock time (optionally limited to weekdays); sunrise or sunset with an offset; a device value crossing a threshold or simply changing; a device joining or leaving the network; every N minutes; or manual only.

**Conditions** — a time window (wrapping past midnight works: 22:00–06:00), specific weekdays, or a device value. All conditions must hold.

**Actions** — run a driver command with its parameters, run another scene, wait, or write a line to the log. They run in order, and the first failure aborts the rest: a rule that half-ran is worse than one that stopped and said so.

Everything lands in the **activity log**, which records what ran, what it did, and *why* it fired.

### How the engine behaves

Two clocks. A 15-second tick evaluates time, sun and interval triggers; a 20-second poll refreshes device state for both the watchers and the dashboard tiles.

Two details that matter:

- **Time triggers are deduplicated per minute.** Without that, a 15-second tick fires the same 07:30 rule four times.
- **State triggers are edge-triggered.** They fire on the transition into a matching value, not for as long as it matches — otherwise "battery below 20%" would fire every 20 seconds until the robot charged.

Sunrise and sunset are computed locally (`src/automations/sun.ts`) so dusk automations survive an internet outage. Accuracy against published times for Tel Aviv: within 2–3 minutes near the equinoxes and midsummer, drifting to ~6 minutes at the winter solstice. Set `HOMECONTROL_LAT` / `HOMECONTROL_LON` for a different location.

## Drivers

Each adopted device can have a driver. Drivers talk to devices directly over the LAN.

### `sonos` — Sonos speakers

Works with no configuration. UPnP/SOAP on port 1400.

`play`, `pause`, `stop`, `next`, `previous`, `setVolume`, `mute`

### `magichome` — Magic Home / LEDENET LED controller

Works with no configuration. Plaintext binary protocol on TCP 5577 — no pairing, key or account. This is the board inside most unbranded WiFi LED strip controllers and RGB bulbs.

`on`, `off`, `toggle`, `setColor`, `setWhite`

### `hue` — Philips Hue bridge

Needs a bridge username. Press the round button on the bridge, then:

```bash
curl -X POST http://localhost:9123/api/devices/<id>/command -H 'content-type: application/json' -d '{"command":"pair"}'
```

The username is stored automatically. Then: `allOn`, `allOff`, `setLight`.

### `mova` — MOVA / Dreame robot vacuum

**This one needs a token you cannot get from the network.**

A MOVA robot answers the miio handshake, so discovery finds and classifies it — but recent firmware returns `ffff…` in the token field once the robot has been paired to the MOVA Home app, withholding it. Local control is impossible without those 32 hex characters, and there is no way to obtain them over the network.

To get it, pick one:

- **From the app data** — extract `com.mova.smarthome` (or the Dreame app) app data from an Android device and read the token out of its SQLite store.
- **From the vendor cloud** — a token extractor tool logs into your MOVA/Dreame account and lists the tokens for every device on it.
- **Re-pair in a captured state** — reset the robot and pair it while capturing traffic; the token is exchanged in the clear during setup.

Once you have it:

```bash
curl -X PATCH http://localhost:9123/api/devices/<the robot's MAC> \
  -H 'content-type: application/json' \
  -d '{"driverConfig":{"token":"<32 hex chars>"}}'
```

Then `start`, `stop`, `dock`, `locate`, `setFanSpeed` become available.

**Before trusting the property map**, run `dump`. The siid/piid numbers in `src/drivers/mova.ts` are the map Dreame uses across most current models, but they shift between model generations and have not been verified against a live token. `dump` walks the low service ids and reports what your specific robot exposes; correct the map via `driverConfig.map` if anything differs.

---

## Home Assistant

`docker-compose.yml` runs Home Assistant alongside this project:

```bash
docker compose up -d
```

It comes up on <http://localhost:8123>. Create an account, then add a long-lived access token (profile → Security) to `.env` as `HA_TOKEN`.

The split is deliberate. HA owns the integrations that already exist and work well — Hue, Sonos, Cast, Xiaomi, Matter. This project owns discovery, the device registry, and any logic worth writing ourselves. `src/ha/client.ts` is the seam: list entities, call services, check availability.

Note the compose file uses bridge networking with a published port, because Docker Desktop on Windows does not support `network_mode: host`. HA's *automatic* discovery relies on host networking, so add integrations by IP from Settings → Devices & services. Discovery on our side is unaffected — it runs natively, not in a container.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Status, device count, whether a scan is running |
| `GET` | `/api/interfaces` | Active adapters and their subnets |
| `POST` | `/api/scan` | Start a sweep (202, returns immediately) |
| `GET` | `/api/scan` | Last scan result |
| `WS` | `/api/scan/stream` | Live scan progress; replays events for late joiners |
| `GET` | `/api/wifi` | Access points in range |
| `GET` | `/api/devices` | Adopted devices and rooms |
| `POST` | `/api/devices` | Adopt a device |
| `PATCH` | `/api/devices/:id` | Rename, assign a room, set driver config |
| `DELETE` | `/api/devices/:id` | Remove |
| `POST` | `/api/rooms` | Add a room |
| `GET` | `/api/drivers` | Driver catalogue with commands |
| `GET` | `/api/devices/:id/state` | Live state read from the device |
| `POST` | `/api/devices/:id/probe` | Reachability + config check |
| `POST` | `/api/devices/:id/command` | Run a driver command |
| `GET` | `/api/ha/status` | Home Assistant reachability |
| `GET` | `/api/ha/entities` | HA entities, filtered by domain |
| `POST` | `/api/ha/service` | Call an HA service |

---

## Layout

```
src/
├── discovery/       the six-pass scan engine
│   ├── index.ts     orchestrator
│   ├── arp.ts       UDP-poke sweep + neighbour table
│   ├── mdns.ts      multicast DNS  (dns-wire.ts is a hand-rolled DNS codec)
│   ├── ssdp.ts      UPnP M-SEARCH + description XML
│   ├── miio.ts      Xiaomi/Dreame handshake
│   ├── broadlink.ts IR blaster / plug discovery + model codes
│   ├── tuya.ts      passive Tuya broadcast listener (deep scan only)
│   ├── ports.ts     TCP fingerprinting, globally socket-budgeted
│   ├── wifi.ts      netsh wlan
│   ├── oui.ts       MAC vendor lookup, offline table + cached online fallback
│   └── classify.ts  device-kind inference
├── registry/        JSON-backed store of adopted devices
├── drivers/         hue, sonos, mova, magichome (+ the miio binary protocol)
├── ha/              Home Assistant REST client
├── web/             dashboard (no build step, no framework)
└── cli/             scan and miio-probe diagnostics
```

State lives in `data/` — `devices.json` is the registry, `oui-cache.json` caches vendor lookups. Both are gitignored; `devices.json` holds device tokens, so keep it off any share.

---

## Devices that resist identification

Some smart devices give up nothing. The pattern worth knowing: a host that
accepts a TCP connection and then stays completely silent, sending no bytes no
matter what you send it. Cheap ESP-based gear does this a lot on ports like
8081 — the protocol is proprietary and there is no handshake to guess.

If a scan leaves you with unidentified hosts, two routes are far cheaper than
more probing:

1. **Check the phone app** that controls them. Whichever app has the same number
   of devices in it is the answer.
2. **Read the router's DHCP lease table.** Devices usually send a hostname when
   they take a lease, and those names (`ESP_1A2B3C`, `smartplug-3`) identify them
   instantly. This needs the router login, which is why the tool cannot do it
   for you.

Hosts that expose no open ports at all are holding an outbound cloud connection
and listening on nothing. Only the app or the DHCP table will identify those.

### A note on the vendor table

`src/discovery/oui.ts` carries a small built-in OUI table so scans work offline.
Every entry in it has been checked against the IEEE registry. **Do not add
prefixes from memory** — a wrong entry there is worse than a missing one, because
the table shadows the online lookup and so never gets corrected. An early version
of that file had seven fabricated entries, and the symptom was a TP-Link extender
being confidently reported as a Tuya device for several scans.
