// JSON for the relay. Harklight keeps numbers exactly as written: an agent may
// declare an answer value such as 18446744073709551617, which a JavaScript
// number cannot hold. This parser keeps any number whose text a JavaScript
// number would not reproduce as a RawNumber holding the original text, and
// stringify writes that text back unchanged. It also records duplicate object
// member names, which the answer-form grammar must refuse.

export class RawNumber {
  constructor(readonly text: string) {}
  /** True when the text is a JSON integer (no fraction, no exponent). */
  get isInteger(): boolean {
    return /^-?(0|[1-9][0-9]*)$/.test(this.text);
  }
  toJSON(): never {
    throw new Error('RawNumber must be written with relay stringify');
  }
}

/** Member names that appeared more than once, per parsed object. */
const duplicates = new WeakMap<object, string[]>();

export function duplicateKeys(o: object): string[] {
  return duplicates.get(o) ?? [];
}

export function isInteger(v: unknown): boolean {
  return (typeof v === 'number' && Number.isInteger(v)) || (v instanceof RawNumber && v.isInteger);
}

/** Integer value as a bigint, for range checks on numbers of any size. */
export function integerValue(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (v instanceof RawNumber && v.isInteger) return BigInt(v.text);
  return null;
}

export function parse(text: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`bad JSON at ${i}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const str = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      const c = text[i++];
      if (c === undefined) fail();
      if (c === '"') return out;
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(e in map)) fail();
          out += map[e];
        }
      } else {
        if (c < ' ') fail();
        out += c;
      }
    }
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = Object.create(null);
      const dups: string[] = [];
      ws();
      if (text[i] === '}') {
        i++;
        return o;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        ws();
        if (text[i++] !== ':') fail();
        const v = value();
        if (Object.prototype.hasOwnProperty.call(o, k)) {
          if (!dups.includes(k)) dups.push(k);
        } else o[k] = v;
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== '}') fail();
        if (dups.length) duplicates.set(o, dups);
        return o;
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i++] !== ']') fail();
        return a;
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) return (i += 4), true;
    if (text.startsWith('false', i)) return (i += 5), false;
    if (text.startsWith('null', i)) return (i += 4), null;
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail();
    const lexeme = m![0];
    i += lexeme.length;
    const n = Number(lexeme);
    return Number.isFinite(n) && String(n) === lexeme ? n : new RawNumber(lexeme);
  };
  const out = value();
  ws();
  if (i !== text.length) fail();
  return out;
}

/** Compact JSON. Raw numbers are written as their original text. With
 * `sortKeys`, object members are written in code point order of their names,
 * as the Server encodes. */
export function stringify(v: unknown, opts: { sortKeys?: boolean } = {}): string {
  if (v === null) return 'null';
  // The Server holds integers as integers, so it writes -0 as 0.
  if (v instanceof RawNumber) return opts.sortKeys && v.text === '-0' ? '0' : v.text;
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => stringify(x === undefined ? null : x, opts)).join(',')}]`;
      let keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
      if (opts.sortKeys) keys = keys.sort(compareCodePoints);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify((v as Record<string, unknown>)[k], opts)}`).join(',')}}`;
    }
    default:
      return 'null';
  }
}

function compareCodePoints(a: string, b: string): number {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(ea.length, eb.length); i++) if (ea[i] !== eb[i]) return ea[i] - eb[i];
  return ea.length - eb.length;
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stringify(a, { sortKeys: true }) === stringify(b, { sortKeys: true });
}
