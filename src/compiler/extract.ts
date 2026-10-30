import { captureRegExp } from './pattern';
import { SLASH } from './types';
import type { Ast, Extractor, ParseFragment, Segment, Variant } from './types';

/** What a segment's body can look like. A static segment has no name. */
interface Part {
  name: string | null;
  width: number; // fixed width in code units, or -1 if variable
  crosses: boolean; // may contain `/`
}

function widthOf(ast: Ast): number {
  switch (ast.t) {
    case 'set':
      return 1;
    case 'cat': {
      let width = 0;
      for (const x of ast.xs) {
        const w = widthOf(x);
        if (w < 0) return -1;
        width += w;
      }
      return width;
    }
    case 'alt': {
      const widths = ast.xs.map(widthOf);
      return widths.every((w) => w === widths[0]) ? widths[0] : -1;
    }
    case 'rep': {
      if (ast.min !== ast.max) return -1;
      const width = widthOf(ast.x);
      return width < 0 ? -1 : width * ast.min;
    }
  }
}

function mayCross(ast: Ast): boolean {
  if (ast.t === 'set') return ast.set[SLASH] === 1;
  if (ast.t === 'rep') return mayCross(ast.x);
  return ast.xs.some(mayCross);
}

function partOf(segment: Segment, parse: ParseFragment): Part {
  if (segment.kind === 'static') return { name: null, width: segment.value.length, crosses: false };
  if (segment.kind === 'wildcard') return { name: segment.name, width: -1, crosses: true };
  if (segment.source === null) return { name: segment.name, width: -1, crosses: false };
  const parsed = parse(segment.source);
  // A fragment the parser can't read could hold anything, so assume the worst of it.
  if (!parsed.ok) return { name: segment.name, width: -1, crosses: true };
  return { name: segment.name, width: widthOf(parsed.ast), crosses: mayCross(parsed.ast) };
}

/** For each part, the characters after it to the end of the path, or -1 if that isn't fixed. */
function tailWidths(parts: Part[]): number[] {
  const tails = new Array<number>(parts.length).fill(0);
  for (let k = parts.length - 2; k >= 0; k -= 1) {
    const next = parts[k + 1];
    tails[k] = next.width < 0 || tails[k + 1] < 0 ? -1 : tails[k + 1] + 1 + next.width;
  }
  return tails;
}

/**
 * The body of `(s, e) => params`, or null if some param needs a RegExp. Every boundary it uses is
 * forced: a fixed width, a fixed distance from the end, or the first `/` after a param that can't
 * hold one. So it finds the only split there is, which is the one `RegExp.exec` would find.
 */
function fastBody(v: Variant, parts: Part[]): string | null {
  const tails = tailWidths(parts);
  const lines: string[] = [];
  const fields = new Map<string, string>(); // a repeated name keeps the last capture, as `exec` would
  let base = ''; // base + offset is the position of the `/` before the current part
  let offset = 0;
  const at = (o: number): string => {
    if (base === '') return String(o);
    return o === 0 ? base : `${base}+${o}`;
  };

  for (let k = 0; k < parts.length; k += 1) {
    const { name, width, crosses } = parts[k];
    const start = at(offset + 1);
    let end: string;
    if (width >= 0) end = at(offset + 1 + width);
    else if (tails[k] >= 0) end = tails[k] === 0 ? 'e' : `e-${tails[k]}`;
    else if (!crosses) {
      end = `p${lines.length}`;
      lines.push(`const ${end}=s.indexOf("/",${start});`);
    } else return null;

    if (name !== null) fields.set(name, `s.slice(${start},${end})`);
    if (width >= 0) offset += 1 + width;
    else {
      base = end;
      offset = 0;
    }
  }

  for (const [name, value] of Object.entries(v.defaults)) fields.set(name, JSON.stringify(value));
  const entries = [...fields].map(([name, value]) => `${JSON.stringify(name)}:${value}`);
  return `${lines.join('')}return {${entries.join(',')}};`;
}

function regExpExtractor(v: Variant): Extractor {
  const regex = captureRegExp(v);
  const names: string[] = [];
  for (const segment of v.segments) if (segment.kind !== 'static') names.push(segment.name);
  names.push(...Object.keys(v.defaults));
  return (path, end) => {
    // Only called on a path this variant matched, so the groups are there.
    const groups = regex.exec(path.slice(0, end))!.groups!;
    const params: Record<string, string> = {};
    names.forEach((name, i) => {
      params[name] = groups[`__p${i}`] ?? '';
    });
    return params;
  };
}

/**
 * Returns `(path, end)` to params, or null for a variant with no params and no defaults. `path` must
 * start with `/`, and `end` is where its path part ends, before any `?`. Picks the cheapest method
 * that is correct for this variant: fixed offsets, then anchoring from the end, then `indexOf('/')`,
 * then `RegExp.exec`.
 */
export function buildExtractor(v: Variant, parse: ParseFragment): Extractor | null {
  const parts = v.segments.map((segment) => partOf(segment, parse));
  const hasDefaults = Object.keys(v.defaults).length > 0;
  if (!hasDefaults && parts.every((part) => part.name === null)) return null;

  // The empty match of `/:a(.+)/*` can overlap the wildcard's own variant. See captureRegExp.
  const overlaps = hasDefaults && parts.some((part) => part.width < 0 && part.crosses);
  const body = overlaps ? null : fastBody(v, parts);
  return body === null ? regExpExtractor(v) : (new Function('s', 'e', body) as Extractor);
}
