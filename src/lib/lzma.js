'use strict';
/**
 * Pure-JavaScript LZMA ("LZMA alone" / .lzma) decoder, following the public-domain
 * reference decoder in the LZMA SDK (LzmaSpec). Used for Dukascopy .bi5 files,
 * which n8n Code nodes cannot decode natively (zlib has no LZMA).
 */

const PROB_INIT = 1024; // kBitModelTotal / 2
const TOP = 1 << 24;
const NUM_STATES = 12;
const POS_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const ALIGN_BITS = 4;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 128;
const MATCH_MIN_LEN = 2;

function probs(n) { return new Uint16Array(n).fill(PROB_INIT); }

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.range = 0xFFFFFFFF;
    this.code = 0;
    const b0 = this.byte();
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    if (b0 !== 0 || this.code === this.range) throw new Error('LZMA: corrupted range coder header');
  }

  byte() {
    if (this.pos >= this.buf.length) throw new Error('LZMA: unexpected end of input');
    return this.buf[this.pos++];
  }

  normalize() {
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }

  bit(p, i) {
    const v = p[i];
    const bound = (this.range >>> 11) * v;
    let bit;
    if (this.code < bound) {
      p[i] = v + ((2048 - v) >>> 5);
      this.range = bound;
      bit = 0;
    } else {
      p[i] = v - (v >>> 5);
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  direct(numBits) {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      this.range = this.range >>> 1;
      let t = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; t = 1; }
      this.normalize();
      res = res * 2 + t;
    }
    return res;
  }

  isFinishedOK() { return this.code === 0; }
}

function bitTree(rc, p, offset, numBits) {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rc.bit(p, offset + m);
  return m - (1 << numBits);
}

function bitTreeReverse(rc, p, offset, numBits) {
  let m = 1;
  let sym = 0;
  for (let i = 0; i < numBits; i++) {
    const b = rc.bit(p, offset + m);
    m = (m << 1) + b;
    sym |= b << i;
  }
  return sym;
}

class LenDecoder {
  constructor() {
    this.choice = probs(2);
    this.low = []; this.mid = [];
    for (let i = 0; i < 1 << POS_BITS_MAX; i++) { this.low.push(probs(8)); this.mid.push(probs(8)); }
    this.high = probs(256);
  }

  decode(rc, posState) {
    if (rc.bit(this.choice, 0) === 0) return bitTree(rc, this.low[posState], 0, 3);
    if (rc.bit(this.choice, 1) === 0) return 8 + bitTree(rc, this.mid[posState], 0, 3);
    return 16 + bitTree(rc, this.high, 0, 8);
  }
}

/**
 * @param {Uint8Array|Buffer} input  .lzma (alone) stream: props(1) dictSize(4 LE) unpackSize(8 LE) data
 * @returns {Uint8Array}
 */
function decompress(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < 13) throw new Error('LZMA: input too short');
  let d = buf[0];
  if (d >= 9 * 5 * 5) throw new Error('LZMA: bad properties byte');
  const lc = d % 9; d = (d / 9) | 0;
  const lp = d % 5;
  const pb = (d / 5) | 0;
  let dictSize = (buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24)) >>> 0;
  if (dictSize < 4096) dictSize = 4096;
  let unknownSize = true;
  for (let i = 5; i < 13; i++) if (buf[i] !== 0xFF) unknownSize = false;
  let unpackSize = 0;
  if (!unknownSize) for (let i = 12; i >= 5; i--) unpackSize = unpackSize * 256 + buf[i];

  const rc = new RangeDecoder(buf, 13);
  let out = new Uint8Array(unknownSize ? Math.max(1 << 16, buf.length * 4) : unpackSize);
  let outPos = 0;
  const ensure = (n) => {
    if (outPos + n <= out.length) return;
    const grown = new Uint8Array(Math.max(out.length * 2, outPos + n));
    grown.set(out.subarray(0, outPos));
    out = grown;
  };
  const putByte = (b) => { ensure(1); out[outPos++] = b; };
  const getByte = (dist) => out[outPos - dist];

  const literal = probs(0x300 << (lc + lp));
  const posSlot = [];
  for (let i = 0; i < LEN_TO_POS_STATES; i++) posSlot.push(probs(1 << 6));
  const posDecoders = probs(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
  const align = probs(1 << ALIGN_BITS);
  const isMatch = probs(NUM_STATES << POS_BITS_MAX);
  const isRep = probs(NUM_STATES);
  const isRepG0 = probs(NUM_STATES);
  const isRepG1 = probs(NUM_STATES);
  const isRepG2 = probs(NUM_STATES);
  const isRep0Long = probs(NUM_STATES << POS_BITS_MAX);
  const lenDec = new LenDecoder();
  const repLenDec = new LenDecoder();

  let state = 0;
  let rep0 = 0; let rep1 = 0; let rep2 = 0; let rep3 = 0;
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  let remaining = unpackSize;

  const decodeDistance = (len) => {
    const lenState = len > LEN_TO_POS_STATES - 1 ? LEN_TO_POS_STATES - 1 : len;
    const slot = bitTree(rc, posSlot[lenState], 0, 6);
    if (slot < 4) return slot;
    const numDirectBits = (slot >>> 1) - 1;
    let dist = ((2 | (slot & 1)) << numDirectBits) >>> 0;
    if (slot < END_POS_MODEL_INDEX) {
      dist = (dist + bitTreeReverse(rc, posDecoders, dist - slot, numDirectBits)) >>> 0;
    } else {
      dist = (dist + ((rc.direct(numDirectBits - ALIGN_BITS) << ALIGN_BITS) >>> 0)) >>> 0;
      dist = (dist + bitTreeReverse(rc, align, 0, ALIGN_BITS)) >>> 0;
    }
    return dist;
  };

  for (;;) {
    if (!unknownSize && remaining === 0 && rc.isFinishedOK()) break;
    const posState = outPos & pbMask;
    if (rc.bit(isMatch, (state << POS_BITS_MAX) + posState) === 0) {
      if (!unknownSize && remaining === 0) throw new Error('LZMA: data after end');
      const prev = outPos > 0 ? getByte(1) : 0;
      const litState = ((outPos & lpMask) << lc) + (prev >>> (8 - lc));
      const base = 0x300 * litState;
      let sym = 1;
      if (state >= 7) {
        let matchByte = getByte(rep0 + 1);
        do {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = rc.bit(literal, base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | bit;
          if (matchBit !== bit) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | rc.bit(literal, base + sym);
      putByte(sym - 0x100);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      remaining--;
      continue;
    }
    let len;
    if (rc.bit(isRep, state) !== 0) {
      if (!unknownSize && remaining === 0) throw new Error('LZMA: data after end');
      if (outPos === 0) throw new Error('LZMA: rep match at start');
      if (rc.bit(isRepG0, state) === 0) {
        if (rc.bit(isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          putByte(getByte(rep0 + 1));
          remaining--;
          continue;
        }
      } else {
        let dist;
        if (rc.bit(isRepG1, state) === 0) dist = rep1;
        else {
          if (rc.bit(isRepG2, state) === 0) dist = rep2;
          else { dist = rep3; rep3 = rep2; }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = dist;
      }
      len = repLenDec.decode(rc, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = lenDec.decode(rc, posState);
      state = state < 7 ? 7 : 10;
      rep0 = decodeDistance(len);
      if (rep0 === 0xFFFFFFFF) {
        if (rc.isFinishedOK()) break;
        throw new Error('LZMA: end marker with unfinished range coder');
      }
      if (!unknownSize && remaining === 0) throw new Error('LZMA: data after end');
      if (rep0 >= dictSize || rep0 >= outPos) throw new Error('LZMA: invalid match distance');
    }
    len += MATCH_MIN_LEN;
    if (!unknownSize && remaining < len) throw new Error('LZMA: match exceeds declared size');
    ensure(len);
    for (let i = 0; i < len; i++) { out[outPos] = out[outPos - rep0 - 1]; outPos++; }
    remaining -= len;
  }
  return out.subarray(0, outPos);
}

module.exports = { decompress };
