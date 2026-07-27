/** What starts a rule running. */
export type Trigger =
  /** A wall-clock time, optionally limited to certain weekdays. */
  | { type: 'time'; at: string; days?: number[] }
  /** Sunrise or sunset, with an optional offset in minutes (may be negative). */
  | { type: 'sun'; event: 'sunrise' | 'sunset'; offsetMinutes?: number; days?: number[] }
  /** A device value crossing a threshold or simply changing. */
  | { type: 'deviceState'; deviceId: string; path: string; op: CompareOp; value?: unknown }
  /** A device appearing on or dropping off the network. */
  | { type: 'deviceOnline'; deviceId: string; online: boolean }
  /** Every N minutes, from when the engine started. */
  | { type: 'interval'; everyMinutes: number }
  /** Never fires on its own — the rule is a button the user presses. */
  | { type: 'manual' };

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'changed';

/** Extra checks that must all hold at the moment a trigger fires. */
export type Condition =
  | { type: 'timeWindow'; from: string; to: string }
  | { type: 'dayOfWeek'; days: number[] }
  | { type: 'deviceState'; deviceId: string; path: string; op: CompareOp; value?: unknown }
  | { type: 'deviceOnline'; deviceId: string; online: boolean };

/** What a rule does. Actions run in order. */
export type Action =
  | { type: 'command'; deviceId: string; command: string; args?: Record<string, unknown> }
  | { type: 'scene'; sceneId: string }
  | { type: 'delay'; seconds: number }
  | { type: 'note'; message: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  triggers: Trigger[];
  /** All conditions must pass. An empty list means "no extra checks". */
  conditions: Condition[];
  actions: Action[];
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastResult: 'ok' | 'failed' | 'skipped' | null;
  runCount: number;
}

/** A named bundle of actions, runnable in one tap. */
export interface Scene {
  id: string;
  name: string;
  /** Single emoji shown on the scene card. */
  icon: string;
  actions: Action[];
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

export interface LogEntry {
  id: string;
  at: string;
  /** Rule or scene name, or a device name for a direct command. */
  subject: string;
  kind: 'rule' | 'scene' | 'command';
  outcome: 'ok' | 'failed' | 'skipped';
  detail: string;
  /** Why it ran, e.g. "07:30" or "battery < 20". */
  because: string | null;
}

export interface AutomationFile {
  version: 1;
  rules: Rule[];
  scenes: Scene[];
  log: LogEntry[];
}

/** Human-readable summaries used by the dashboard and the log. */
export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case 'time':
      return `בשעה ${t.at}${t.days?.length ? ` (${dayNames(t.days)})` : ''}`;
    case 'sun': {
      const base = t.event === 'sunrise' ? 'זריחה' : 'שקיעה';
      const off = t.offsetMinutes ?? 0;
      if (off === 0) return `ב${base}`;
      return off > 0 ? `${off} דק׳ אחרי ה${base}` : `${Math.abs(off)} דק׳ לפני ה${base}`;
    }
    case 'deviceState':
      return t.op === 'changed' ? `כשמשתנה ${t.path}` : `כש-${t.path} ${t.op} ${String(t.value)}`;
    case 'deviceOnline':
      return t.online ? 'כשהמכשיר מתחבר' : 'כשהמכשיר מתנתק';
    case 'interval':
      return `כל ${t.everyMinutes} דק׳`;
    case 'manual':
      return 'הפעלה ידנית';
  }
}

export function describeAction(a: Action, nameOf: (id: string) => string): string {
  switch (a.type) {
    case 'command':
      return `${nameOf(a.deviceId)} → ${a.command}`;
    case 'scene':
      return `הפעל סצנה "${nameOf(a.sceneId)}"`;
    case 'delay':
      return `המתן ${a.seconds} שנ׳`;
    case 'note':
      return `רשום ביומן: ${a.message}`;
  }
}

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function dayNames(days: number[]): string {
  return days.map((d) => DAYS[d] ?? '?').join(', ');
}
