import type { RegisteredDevice } from '../registry/types.js';

/** Everything a driver gets when it is asked to do something. */
export interface DriverContext {
  ip: string;
  config: Record<string, unknown>;
  device: RegisteredDevice;
}

/** A configuration value the driver cannot work without. */
export interface DriverRequirement {
  key: string;
  label: string;
  hint: string;
  secret: boolean;
}

export interface DriverCommand {
  name: string;
  label: string;
  /** Parameters the caller must supply, as a JSON-ish description. */
  params?: { key: string; label: string; type: 'number' | 'string' | 'boolean' }[];
  run: (ctx: DriverContext, args: Record<string, unknown>) => Promise<unknown>;
}

export interface DriverState {
  online: boolean;
  /** Short human-readable summary, e.g. "Charging · 78%". */
  summary: string;
  /** Structured values for the dashboard to render. */
  values: Record<string, unknown>;
}

export interface Driver {
  id: string;
  label: string;
  /** Kinds this driver is meant for, used to suggest it in the UI. */
  kinds: string[];
  requires: DriverRequirement[];
  /** Check the device is reachable and the config is usable. */
  probe: (ctx: DriverContext) => Promise<{ ok: boolean; message: string }>;
  state: (ctx: DriverContext) => Promise<DriverState>;
  commands: DriverCommand[];
}

export class DriverError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'DriverError';
  }
}

/**
 * Read a required string from driverConfig or fail with a clear message.
 * Messages are Hebrew because they surface directly on the dashboard.
 */
export function requireConfig(ctx: DriverContext, key: string, hint: string): string {
  const value = ctx.config[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new DriverError(`חסר ${key} עבור ${ctx.device.name}. ${hint}`, 412);
  }
  return value.trim();
}
