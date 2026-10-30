import { NFA, frag, nfaBound } from './nfa';
import { ALPHABET } from './types';
import type { CharSet, Dfa, DfaInput, DfaResult } from './types';

/**
 * A table needing more NFA states than this fails the budget before its NFA is built. Counted
 * repeats multiply, so building one to find out could exhaust memory. No table of real routes
 * comes close: it would be about 100,000 routes, far over any DFA state budget.
 */
const MAX_NFA_STATES = 1 << 22;

/** Compiles `inputs` into one minimal DFA whose states hold every accepting tag. */
export function buildDfa(inputs: DfaInput[], options: { maxStates: number }): DfaResult {
  const raw = determinize(inputs, options.maxStates);
  return raw.ok ? { ok: true, dfa: minimize(raw.dfa) } : raw;
}

/**
 * Subset construction. Stops as soon as the state count passes `maxStates`, and reports that
 * count. If the NFA alone would pass MAX_NFA_STATES, nothing is built and `states` is the
 * NFA bound instead.
 *
 * A DFA state is keyed by its kernel: the NFA states in its closure that consume a symbol or
 * accept. States that only hold epsilon edges can't change what the DFA state does.
 */
export function determinize(inputs: DfaInput[], maxStates: number): DfaResult {
  let bound = 1;
  for (const input of inputs) bound += 1 + nfaBound(input.ast);
  if (bound > MAX_NFA_STATES) return { ok: false, reason: 'state-budget', states: bound };

  const nfa = new NFA();
  const root = nfa.add();
  inputs.forEach((input, index) => {
    const entry = nfa.add();
    nfa.eps[root].push(entry);
    nfa.accept[frag(nfa, input.ast, entry)] = index;
  });

  const size = nfa.eps.length;
  const { sets, edgeStart, edgeSet, edgeTo } = flattenEdges(nfa);
  const { epsStart, epsTo } = flattenEps(nfa);
  const { classOf, classes } = compressAlphabet(sets);
  const classesIn = sets.map((set) => classesOfSet(set, classOf, classes));

  const accept = Int32Array.from(nfa.accept);
  const inKernel = new Uint8Array(size);
  for (let s = 0; s < size; s += 1) {
    if (accept[s] >= 0 || edgeStart[s + 1] > edgeStart[s]) inKernel[s] = 1;
  }

  // `seen[s] === pass` marks s as visited, so that no pass has to clear the array.
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  const kernel = new Int32Array(size);
  let pass = 0;

  /** Writes the sorted kernel of the closure of `seeds` into `kernel`, returning its length. */
  const closeOver = (seeds: ArrayLike<number>): number => {
    pass += 1;
    let top = 0;
    let length = 0;
    for (let i = 0; i < seeds.length; i += 1) {
      const s = seeds[i];
      if (seen[s] !== pass) {
        seen[s] = pass;
        stack[top] = s;
        top += 1;
      }
    }
    while (top > 0) {
      top -= 1;
      const s = stack[top];
      if (inKernel[s] === 1) {
        kernel[length] = s;
        length += 1;
      }
      for (let e = epsStart[s]; e < epsStart[s + 1]; e += 1) {
        const t = epsTo[e];
        if (seen[t] !== pass) {
          seen[t] = pass;
          stack[top] = t;
          top += 1;
        }
      }
    }
    sortInts(kernel, length);
    return length;
  };

  const acceptSets = new Interner();
  const tagBuffer = new Int32Array(inputs.length);

  /** Interns the tags accepted in the first `length` kernel entries, or returns -1 if none. */
  const internTags = (length: number): number => {
    let count = 0;
    for (let i = 0; i < length; i += 1) {
      const index = accept[kernel[i]];
      if (index >= 0) {
        tagBuffer[count] = inputs[index].tag;
        count += 1;
      }
    }
    if (count === 0) return -1;
    sortInts(tagBuffer, count);
    let unique = 1;
    for (let i = 1; i < count; i += 1) {
      if (tagBuffer[i] !== tagBuffer[unique - 1]) {
        tagBuffer[unique] = tagBuffer[i];
        unique += 1;
      }
    }
    return acceptSets.intern(tagBuffer, unique);
  };

  const subsets = new Interner();
  const acceptOf: number[] = [];
  const startLength = closeOver([root]);
  subsets.intern(kernel, startLength);
  acceptOf.push(internTags(startLength));
  if (subsets.size > maxStates) return { ok: false, reason: 'state-budget', states: subsets.size };

  let trans = new Int32Array(classes * 1024);
  const targets: number[][] = Array.from({ length: classes }, () => []);

  for (let state = 0; state < subsets.size; state += 1) {
    const row = state * classes;
    if (row + classes > trans.length) {
      const grown = new Int32Array(trans.length * 2);
      grown.set(trans);
      trans = grown;
    }

    const { pool, offsets } = subsets;
    for (let i = offsets[state]; i < offsets[state + 1]; i += 1) {
      const s = pool[i];
      for (let e = edgeStart[s]; e < edgeStart[s + 1]; e += 1) {
        const inSet = classesIn[edgeSet[e]];
        const to = edgeTo[e];
        for (let j = 0; j < inSet.length; j += 1) targets[inSet[j]].push(to);
      }
    }

    for (let c = 0; c < classes; c += 1) {
      if (targets[c].length === 0) {
        trans[row + c] = -1;
        continue;
      }
      const length = closeOver(targets[c]);
      targets[c].length = 0;
      const known = subsets.size;
      const next = subsets.intern(kernel, length);
      if (next === known) {
        if (subsets.size > maxStates) {
          return { ok: false, reason: 'state-budget', states: subsets.size };
        }
        acceptOf.push(internTags(length));
      }
      trans[row + c] = next;
    }
  }

  const tagLists: Int32Array[] = [];
  for (let id = 0; id < acceptSets.size; id += 1) tagLists.push(acceptSets.get(id));
  return {
    ok: true,
    dfa: {
      states: subsets.size,
      classes,
      classOf,
      trans: trans.slice(0, subsets.size * classes),
      start: 0,
      accepts: acceptOf.map((id) => (id < 0 ? null : tagLists[id])),
    },
  };
}

/**
 * Hopcroft's algorithm, on the compressed classes, for a DFA with partial transitions.
 *
 * States that can't reach an accepting state are removed first, so -1 is the only dead state
 * and a transition into one of them equals having no transition. Blocks start out split by
 * accept set: results depend on every accepting tag, so states are never merged on the lowest
 * tag alone.
 *
 * Each pending (block, class) pair is a splitter. A partial transition function needs every
 * pair pending at the start, unlike a complete one, which can leave out a block. It costs
 * little: a pair with no incoming transitions only reads its block.
 */
export function minimize(dfa: Dfa): Dfa {
  const { states, classes, classOf, start, accepts } = dfa;
  const trans = dfa.trans.slice();
  let incoming = invert(trans, states, classes);

  const live = findLive(states, classes, accepts, incoming);
  if (live[start] === 0) {
    return {
      states: 1,
      classes,
      classOf,
      trans: new Int32Array(classes).fill(-1),
      start: 0,
      accepts: [null],
    };
  }
  if (removeDead(trans, states, classes, live)) incoming = invert(trans, states, classes);
  const { offsets, sources } = incoming;

  // Blocks hold ranges of `members`, so moving a state between ranges is a swap. Block 0 is
  // for states accepting nothing, and is left empty if there are none.
  const acceptSets = new Interner();
  const blockOf = new Int32Array(states).fill(-1);
  for (let s = 0; s < states; s += 1) {
    if (live[s] === 0) continue;
    const tags = accepts[s];
    blockOf[s] = tags === null ? 0 : acceptSets.intern(tags, tags.length) + 1;
  }

  const first = new Int32Array(states + 1);
  const end = new Int32Array(states + 1);
  let blocks = acceptSets.size + 1;
  for (let s = 0; s < states; s += 1) {
    if (blockOf[s] >= 0) end[blockOf[s]] += 1;
  }
  for (let b = 0, at = 0; b < blocks; b += 1) {
    first[b] = at;
    at += end[b];
    end[b] = first[b];
  }
  const members = new Int32Array(states);
  const position = new Int32Array(states);
  for (let s = 0; s < states; s += 1) {
    if (blockOf[s] < 0) continue;
    const p = end[blockOf[s]];
    members[p] = s;
    position[s] = p;
    end[blockOf[s]] += 1;
  }

  const pending = new Uint8Array((states + 1) * classes);
  const work: number[] = [];
  const enqueue = (block: number): void => {
    for (let c = 0; c < classes; c += 1) {
      pending[block * classes + c] = 1;
      work.push(block * classes + c);
    }
  };
  for (let b = 0; b < blocks; b += 1) enqueue(b);

  const splitter = new Int32Array(states);
  const marked = new Int32Array(states + 1);
  const touched = new Int32Array(states + 1);

  while (work.length > 0) {
    const pair = work.pop() as number;
    pending[pair] = 0;
    const block = Math.floor(pair / classes);
    const c = pair - block * classes;

    // Collected before any move, because splitting can reorder this block's own members.
    let count = 0;
    for (let p = first[block]; p < end[block]; p += 1) {
      const key = members[p] * classes + c;
      for (let j = offsets[key]; j < offsets[key + 1]; j += 1) {
        splitter[count] = sources[j];
        count += 1;
      }
    }

    // Move each source to the front of its block. Each state has one transition per class,
    // so no state appears twice.
    let touchedCount = 0;
    for (let i = 0; i < count; i += 1) {
      const s = splitter[i];
      const b = blockOf[s];
      if (marked[b] === 0) {
        touched[touchedCount] = b;
        touchedCount += 1;
      }
      const front = first[b] + marked[b];
      marked[b] += 1;
      const from = position[s];
      const other = members[front];
      members[front] = s;
      position[s] = front;
      members[from] = other;
      position[other] = from;
    }

    for (let i = 0; i < touchedCount; i += 1) {
      const b = touched[i];
      const inSplit = marked[b];
      const outside = end[b] - first[b] - inSplit;
      marked[b] = 0;
      if (outside === 0) continue;

      // The new block is always the smaller half. If (b, d) is pending, then both halves must
      // be, and it adds the second. If not, partitions are stable against b, so either half
      // is enough, and the smaller one is what bounds the work at O(n log n) per class. So
      // both cases come to the same thing: enqueue the new block.
      const added = blocks;
      blocks += 1;
      if (inSplit <= outside) {
        first[added] = first[b];
        end[added] = first[b] + inSplit;
        first[b] = end[added];
      } else {
        first[added] = first[b] + inSplit;
        end[added] = end[b];
        end[b] = first[added];
      }
      for (let p = first[added]; p < end[added]; p += 1) blockOf[members[p]] = added;
      enqueue(added);
    }
  }

  return quotient(dfa, trans, blockOf, blocks);
}

/** Builds the DFA with one state per block, numbered by each block's lowest state. */
function quotient(dfa: Dfa, trans: Int32Array, blockOf: Int32Array, blocks: number): Dfa {
  const { states, classes, classOf, start, accepts } = dfa;
  const idOf = new Int32Array(blocks).fill(-1);
  const representatives: number[] = [];
  for (let s = 0; s < states; s += 1) {
    const b = blockOf[s];
    if (b >= 0 && idOf[b] < 0) {
      idOf[b] = representatives.length;
      representatives.push(s);
    }
  }

  const merged = new Int32Array(representatives.length * classes);
  representatives.forEach((s, id) => {
    for (let c = 0; c < classes; c += 1) {
      const t = trans[s * classes + c];
      merged[id * classes + c] = t < 0 ? -1 : idOf[blockOf[t]];
    }
  });
  return {
    states: representatives.length,
    classes,
    classOf,
    trans: merged,
    start: idOf[blockOf[start]],
    accepts: representatives.map((s) => accepts[s]),
  };
}

/** Transitions by target: sources of (t, c) are `sources[offsets[t * classes + c] ..]`. */
function invert(
  trans: Int32Array,
  states: number,
  classes: number,
): { offsets: Int32Array; sources: Int32Array } {
  const size = states * classes;
  const offsets = new Int32Array(size + 1);
  for (let s = 0; s < states; s += 1) {
    for (let c = 0; c < classes; c += 1) {
      const t = trans[s * classes + c];
      if (t >= 0) offsets[t * classes + c + 1] += 1;
    }
  }
  for (let key = 0; key < size; key += 1) offsets[key + 1] += offsets[key];
  const sources = new Int32Array(offsets[size]);
  const next = offsets.slice();
  for (let s = 0; s < states; s += 1) {
    for (let c = 0; c < classes; c += 1) {
      const t = trans[s * classes + c];
      if (t >= 0) {
        const key = t * classes + c;
        sources[next[key]] = s;
        next[key] += 1;
      }
    }
  }
  return { offsets, sources };
}

/** Marks the states that can reach an accepting state. */
function findLive(
  states: number,
  classes: number,
  accepts: (Int32Array | null)[],
  incoming: { offsets: Int32Array; sources: Int32Array },
): Uint8Array {
  const { offsets, sources } = incoming;
  const live = new Uint8Array(states);
  const queue = new Int32Array(states);
  let tail = 0;
  for (let s = 0; s < states; s += 1) {
    if (accepts[s] !== null) {
      live[s] = 1;
      queue[tail] = s;
      tail += 1;
    }
  }
  for (let head = 0; head < tail; head += 1) {
    const t = queue[head];
    for (let j = offsets[t * classes]; j < offsets[(t + 1) * classes]; j += 1) {
      const s = sources[j];
      if (live[s] === 0) {
        live[s] = 1;
        queue[tail] = s;
        tail += 1;
      }
    }
  }
  return live;
}

/** Clears every transition from or to a dead state. Returns whether it changed anything. */
function removeDead(trans: Int32Array, states: number, classes: number, live: Uint8Array): boolean {
  let changed = false;
  for (let s = 0; s < states; s += 1) {
    for (let c = 0; c < classes; c += 1) {
      const t = trans[s * classes + c];
      if (t >= 0 && (live[s] === 0 || live[t] === 0)) {
        trans[s * classes + c] = -1;
        changed = true;
      }
    }
  }
  return changed;
}

/** Puts the NFA's edges in flat arrays, with `edgeSet` indexing the distinct `sets`. */
function flattenEdges(nfa: NFA): {
  sets: CharSet[];
  edgeStart: Int32Array;
  edgeSet: Int32Array;
  edgeTo: Int32Array;
} {
  const size = nfa.edges.length;
  const edgeStart = new Int32Array(size + 1);
  for (let s = 0; s < size; s += 1) edgeStart[s + 1] = edgeStart[s] + nfa.edges[s].length;
  const edgeSet = new Int32Array(edgeStart[size]);
  const edgeTo = new Int32Array(edgeStart[size]);

  const distinct = new Interner();
  const sets: CharSet[] = [];
  const bits = new Int32Array(Math.ceil(ALPHABET / 32));
  for (let s = 0; s < size; s += 1) {
    nfa.edges[s].forEach(([set, to], offset) => {
      bits.fill(0);
      for (let symbol = 0; symbol < ALPHABET; symbol += 1) {
        if (set[symbol] === 1) bits[symbol >>> 5] |= 1 << (symbol & 31);
      }
      const id = distinct.intern(bits, bits.length);
      if (id === sets.length) sets.push(set);
      edgeSet[edgeStart[s] + offset] = id;
      edgeTo[edgeStart[s] + offset] = to;
    });
  }
  return { sets, edgeStart, edgeSet, edgeTo };
}

function flattenEps(nfa: NFA): { epsStart: Int32Array; epsTo: Int32Array } {
  const size = nfa.eps.length;
  const epsStart = new Int32Array(size + 1);
  for (let s = 0; s < size; s += 1) epsStart[s + 1] = epsStart[s] + nfa.eps[s].length;
  const epsTo = new Int32Array(epsStart[size]);
  for (let s = 0; s < size; s += 1) epsTo.set(nfa.eps[s], epsStart[s]);
  return { epsStart, epsTo };
}

/** Groups symbols that no set tells apart, so that a table row needs one entry per class. */
function compressAlphabet(sets: CharSet[]): { classOf: Uint8Array; classes: number } {
  const classOf = new Uint8Array(ALPHABET);
  let classes = 1;
  for (const set of sets) {
    const renumber = new Int16Array(classes * 2).fill(-1);
    let next = 0;
    for (let symbol = 0; symbol < ALPHABET; symbol += 1) {
      const key = classOf[symbol] * 2 + set[symbol];
      if (renumber[key] < 0) {
        renumber[key] = next;
        next += 1;
      }
      classOf[symbol] = renumber[key];
    }
    classes = next;
  }
  return { classOf, classes };
}

/** The classes that make up `set`. Every class is wholly inside or outside each set. */
function classesOfSet(set: CharSet, classOf: Uint8Array, classes: number): Uint8Array {
  const present = new Uint8Array(classes);
  for (let symbol = 0; symbol < ALPHABET; symbol += 1) {
    if (set[symbol] === 1) present[classOf[symbol]] = 1;
  }
  const list: number[] = [];
  for (let c = 0; c < classes; c += 1) {
    if (present[c] === 1) list.push(c);
  }
  return Uint8Array.from(list);
}

/** Sorts the first `length` entries of `values` ascending. */
function sortInts(values: Int32Array, length: number): void {
  if (length > 32) {
    values.subarray(0, length).sort();
    return;
  }
  for (let i = 1; i < length; i += 1) {
    const value = values[i];
    let j = i - 1;
    for (; j >= 0 && values[j] > value; j -= 1) values[j + 1] = values[j];
    values[j + 1] = value;
  }
}

/**
 * Gives equal integer sequences the same id, in order of first appearance, without building a
 * string key for each one. The sequences are kept in one pool: id's are
 * `pool[offsets[id] .. offsets[id + 1]]`.
 */
class Interner {
  size = 0;
  pool = new Int32Array(1 << 12);
  offsets = new Int32Array(1 << 10);
  private hashes = new Int32Array(1 << 10);
  private slots = new Int32Array(1 << 11).fill(-1); // open addressing: id, or -1 if free

  intern(key: Int32Array, length: number): number {
    const hash = hashInts(key, length);
    const mask = this.slots.length - 1;
    let slot = hash & mask;
    for (; this.slots[slot] >= 0; slot = (slot + 1) & mask) {
      const id = this.slots[slot];
      if (this.hashes[id] === hash && this.matches(id, key, length)) return id;
    }
    return this.append(key, length, hash, slot);
  }

  get(id: number): Int32Array {
    return this.pool.slice(this.offsets[id], this.offsets[id + 1]);
  }

  private matches(id: number, key: Int32Array, length: number): boolean {
    const start = this.offsets[id];
    if (this.offsets[id + 1] - start !== length) return false;
    for (let i = 0; i < length; i += 1) {
      if (this.pool[start + i] !== key[i]) return false;
    }
    return true;
  }

  private append(key: Int32Array, length: number, hash: number, slot: number): number {
    const id = this.size;
    if (id + 2 > this.offsets.length) {
      this.offsets = resized(this.offsets, this.offsets.length * 2);
      this.hashes = resized(this.hashes, this.hashes.length * 2);
    }
    const start = this.offsets[id];
    if (start + length > this.pool.length) {
      this.pool = resized(this.pool, Math.max(this.pool.length * 2, start + length));
    }
    for (let i = 0; i < length; i += 1) this.pool[start + i] = key[i];
    this.offsets[id + 1] = start + length;
    this.hashes[id] = hash;
    this.slots[slot] = id;
    this.size += 1;
    if (this.size * 2 > this.slots.length) this.rehash();
    return id;
  }

  private rehash(): void {
    const slots = new Int32Array(this.slots.length * 2).fill(-1);
    const mask = slots.length - 1;
    for (let id = 0; id < this.size; id += 1) {
      let slot = this.hashes[id] & mask;
      while (slots[slot] >= 0) slot = (slot + 1) & mask;
      slots[slot] = id;
    }
    this.slots = slots;
  }
}

function resized(values: Int32Array, length: number): Int32Array<ArrayBuffer> {
  const grown = new Int32Array(length);
  grown.set(values);
  return grown;
}

function hashInts(values: Int32Array, length: number): number {
  let hash = length | 0;
  for (let i = 0; i < length; i += 1) hash = Math.imul(hash ^ values[i], 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 15), 0x5bd1e995);
  return hash ^ (hash >>> 13);
}
