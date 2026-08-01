import { logger } from '../logger.js';
import { registry } from '../registry/store.js';
import { castDriver } from './cast.js';
import { hueDriver } from './hue.js';
import { magicHomeDriver } from './magichome.js';
import { movaDriver } from './mova.js';
import { sonosDriver } from './sonos.js';
import { switcherDriver } from './switcher.js';
import { tuyaDriver } from './tuya.js';
import { DriverError, type Driver, type DriverContext, type DriverState } from './types.js';

const log = logger('drivers');

const DRIVERS: Driver[] = [
  hueDriver, sonosDriver, movaDriver, magicHomeDriver, switcherDriver, tuyaDriver, castDriver,
];

export const driversById = new Map(DRIVERS.map((d) => [d.id, d]));

/** Serialisable driver catalogue for the dashboard. */
export function driverCatalogue() {
  return DRIVERS.map((d) => ({
    id: d.id,
    label: d.label,
    kinds: d.kinds,
    requires: d.requires,
    commands: d.commands.map((c) => ({ name: c.name, label: c.label, params: c.params ?? [] })),
  }));
}

function contextFor(deviceId: string): { driver: Driver; ctx: DriverContext } {
  const device = registry.get(deviceId);
  if (!device) throw new DriverError('device not found', 404);
  if (!device.driver) throw new DriverError(`${device.name} has no driver assigned`, 412);

  const driver = driversById.get(device.driver);
  if (!driver) throw new DriverError(`unknown driver "${device.driver}"`, 400);

  return { driver, ctx: { ip: device.ip, config: device.driverConfig, device } };
}

export async function probeDevice(deviceId: string): Promise<{ ok: boolean; message: string }> {
  const { driver, ctx } = contextFor(deviceId);
  return driver.probe(ctx);
}

export async function deviceState(deviceId: string): Promise<DriverState> {
  const { driver, ctx } = contextFor(deviceId);
  return driver.state(ctx);
}

/**
 * Run a driver command.
 *
 * A command may return `{ config }`, which is merged into the device's stored
 * driverConfig — that is how Hue pairing persists the username it is handed
 * exactly once.
 */
export async function runCommand(
  deviceId: string,
  commandName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const { driver, ctx } = contextFor(deviceId);

  const command = driver.commands.find((c) => c.name === commandName);
  if (!command) {
    const available = driver.commands.map((c) => c.name).join(', ');
    throw new DriverError(`unknown command "${commandName}". Available: ${available}`, 400);
  }

  log.info(`${ctx.device.name}: ${driver.id}.${commandName}`);
  const result = await command.run(ctx, args);

  if (result && typeof result === 'object' && 'config' in result) {
    const patch = (result as { config: Record<string, unknown> }).config;
    await registry.update(deviceId, { driverConfig: { ...ctx.device.driverConfig, ...patch } });
    log.info(`${ctx.device.name}: stored ${Object.keys(patch).join(', ')}`);
  }

  return result;
}

export { DriverError };
