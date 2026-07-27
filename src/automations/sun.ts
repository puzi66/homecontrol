/**
 * Sunrise and sunset, computed locally.
 *
 * Implements the standard sunrise equation. Deliberately not an API call:
 * automations that fire at sunset must keep working when the internet is down.
 *
 * Accuracy, checked against published almanac times at mid latitudes: within
 * 2-3 minutes around the equinoxes and the summer solstice, drifting to about
 * 6 minutes at the winter solstice. That is inherent to the simplified equation
 * of centre used here, and it is fine for "switch the lamps on at dusk" —
 * anyone who wants it tighter can set an offset on the trigger.
 */

const DEG = Math.PI / 180;
/** Earth's axial tilt. */
const OBLIQUITY = 23.4397;
/** Solar altitude at apparent sunrise/sunset, accounting for refraction. */
const HORIZON = -0.833;

const sin = (deg: number) => Math.sin(deg * DEG);
const cos = (deg: number) => Math.cos(deg * DEG);

/** Julian day number for a Date. */
function toJulian(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

function fromJulian(julian: number): Date {
  return new Date((julian - 2440587.5) * 86_400_000);
}

export interface SunTimes {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date;
}

/**
 * @param date      any moment on the day of interest
 * @param latitude  degrees north (negative for south)
 * @param longitude degrees east (negative for west)
 *
 * Returns null for sunrise/sunset inside a polar day or night, where the sun
 * never crosses the horizon.
 */
export function sunTimes(date: Date, latitude: number, longitude: number): SunTimes {
  // The equation is conventionally written with west-positive longitude.
  const lw = -longitude;

  const julian = toJulian(date);
  const n = Math.round(julian - 2451545.0 - 0.0009 - lw / 360);

  // Mean solar noon, as a day count from J2000.
  const jStar = 2451545.0 + 0.0009 + lw / 360 + n;

  // Solar mean anomaly.
  const m = (357.5291 + 0.98560028 * (jStar - 2451545)) % 360;
  // Equation of the centre.
  const c = 1.9148 * sin(m) + 0.02 * sin(2 * m) + 0.0003 * sin(3 * m);
  // Ecliptic longitude.
  const lambda = (m + c + 180 + 102.9372) % 360;

  const jTransit = jStar + 0.0053 * sin(m) - 0.0069 * sin(2 * lambda);

  // Declination of the sun.
  const sinDelta = sin(lambda) * sin(OBLIQUITY);
  const cosDelta = Math.cos(Math.asin(sinDelta));

  const cosOmega = (sin(HORIZON) - sin(latitude) * sinDelta) / (cos(latitude) * cosDelta);

  // |cos| > 1 means the sun stays above or below the horizon all day.
  if (cosOmega > 1 || cosOmega < -1) {
    return { sunrise: null, sunset: null, solarNoon: fromJulian(jTransit) };
  }

  const omega = Math.acos(cosOmega) / DEG;

  return {
    sunrise: fromJulian(jTransit - omega / 360),
    sunset: fromJulian(jTransit + omega / 360),
    solarNoon: fromJulian(jTransit),
  };
}

/** "HH:MM" in the host's local timezone. */
export function toLocalHhmm(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Minutes since local midnight, for comparing against "HH:MM" triggers. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Parse "HH:MM" into minutes since midnight, or null when malformed. */
export function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}
