/**
 * Minimal DNS wire-format encoder/decoder — just enough for mDNS discovery.
 *
 * Written by hand rather than pulled from npm because every mDNS library on npm
 * either ships native bindings or drags in a large dependency tree, and we only
 * need four record types.
 */

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;

export interface ResourceRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  /** Decoded payload: string for PTR, string[] for TXT, object for SRV/A. */
  data: unknown;
}

export interface DnsMessage {
  id: number;
  flags: number;
  questions: { name: string; type: number; class: number }[];
  answers: ResourceRecord[];
  authorities: ResourceRecord[];
  additionals: ResourceRecord[];
}

/** Encode a dotted name as length-prefixed labels terminated by a zero byte. */
function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const label = Buffer.from(p, 'utf8');
    if (label.length > 63) throw new Error(`DNS label too long: ${p}`);
    chunks.push(Buffer.from([label.length]), label);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/**
 * Read a name at `offset`, following compression pointers.
 * Returns the name and the offset just past the name *in the current branch*
 * (pointer targets do not advance the caller's cursor).
 */
function decodeName(buf: Buffer, offset: number): { name: string; offset: number } {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let end = offset;
  let guard = 0;

  while (pos < buf.length) {
    if (guard++ > 128) break; // defensive: malformed packet with a pointer loop
    const len = buf[pos]!;

    if (len === 0) {
      pos += 1;
      if (!jumped) end = pos;
      break;
    }

    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (!jumped) {
        end = pos + 2;
        jumped = true;
      }
      if (pointer >= buf.length || pointer >= pos) break; // pointers must go backwards
      pos = pointer;
      continue;
    }

    pos += 1;
    if (pos + len > buf.length) break;
    labels.push(buf.subarray(pos, pos + len).toString('utf8'));
    pos += len;
    if (!jumped) end = pos;
  }

  return { name: labels.join('.'), offset: end };
}

function decodeRecord(buf: Buffer, offset: number): { record: ResourceRecord; offset: number } | null {
  const { name, offset: afterName } = decodeName(buf, offset);
  if (afterName + 10 > buf.length) return null;

  const type = buf.readUInt16BE(afterName);
  const klass = buf.readUInt16BE(afterName + 2);
  const ttl = buf.readUInt32BE(afterName + 4);
  const rdLength = buf.readUInt16BE(afterName + 8);
  const rdStart = afterName + 10;
  if (rdStart + rdLength > buf.length) return null;

  let data: unknown = buf.subarray(rdStart, rdStart + rdLength);

  switch (type) {
    case TYPE.A:
      if (rdLength === 4) data = Array.from(buf.subarray(rdStart, rdStart + 4)).join('.');
      break;
    case TYPE.PTR:
      data = decodeName(buf, rdStart).name;
      break;
    case TYPE.TXT: {
      const strings: string[] = [];
      let p = rdStart;
      while (p < rdStart + rdLength) {
        const len = buf[p]!;
        p += 1;
        if (p + len > rdStart + rdLength) break;
        strings.push(buf.subarray(p, p + len).toString('utf8'));
        p += len;
      }
      data = strings;
      break;
    }
    case TYPE.SRV: {
      if (rdLength >= 6) {
        data = {
          priority: buf.readUInt16BE(rdStart),
          weight: buf.readUInt16BE(rdStart + 2),
          port: buf.readUInt16BE(rdStart + 4),
          target: decodeName(buf, rdStart + 6).name,
        };
      }
      break;
    }
    default:
      break;
  }

  return { record: { name, type, class: klass, ttl, data }, offset: rdStart + rdLength };
}

export function decodeMessage(buf: Buffer): DnsMessage | null {
  if (buf.length < 12) return null;

  const msg: DnsMessage = {
    id: buf.readUInt16BE(0),
    flags: buf.readUInt16BE(2),
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };

  const counts = {
    qd: buf.readUInt16BE(4),
    an: buf.readUInt16BE(6),
    ns: buf.readUInt16BE(8),
    ar: buf.readUInt16BE(10),
  };

  let offset = 12;

  for (let i = 0; i < counts.qd; i++) {
    const { name, offset: after } = decodeName(buf, offset);
    if (after + 4 > buf.length) return msg;
    msg.questions.push({ name, type: buf.readUInt16BE(after), class: buf.readUInt16BE(after + 2) });
    offset = after + 4;
  }

  for (const [count, bucket] of [
    [counts.an, msg.answers],
    [counts.ns, msg.authorities],
    [counts.ar, msg.additionals],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const res = decodeRecord(buf, offset);
      if (!res) return msg;
      bucket.push(res.record);
      offset = res.offset;
    }
  }

  return msg;
}

/** Build an mDNS query packet asking for `type` records for each name. */
export function encodeQuery(names: string[], type: number = TYPE.PTR): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // mDNS queries use id 0
  header.writeUInt16BE(0, 2); // standard query, not truncated
  header.writeUInt16BE(names.length, 4);

  const questions = names.map((n) => {
    const encoded = encodeName(n);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // class IN (QU bit left clear: we want multicast answers)
    return Buffer.concat([encoded, tail]);
  });

  return Buffer.concat([header, ...questions]);
}
