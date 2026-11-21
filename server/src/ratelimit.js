'use strict';

// In-process token buckets. One server process, so no shared store is needed.
// Keys are IPs or station ids; idle buckets are dropped so memory stays bounded.
class Limiter {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.buckets = new Map();
  }

  _bucket(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, t };
      this.buckets.set(key, b);
      if (this.buckets.size > 50000) this._sweep(t);
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.t) / 1000) * this.refillPerSec);
      b.t = t;
    }
    return b;
  }

  // Take one token. Returns { ok, retryAfterSec }.
  take(key) {
    const b = this._bucket(key);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / this.refillPerSec) };
  }

  // Check without consuming (used where only failures should count).
  peek(key) {
    const b = this._bucket(key);
    return b.tokens >= 1
      ? { ok: true, retryAfterSec: 0 }
      : { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / this.refillPerSec) };
  }

  _sweep(t) {
    for (const [k, b] of this.buckets) {
      if (t - b.t > 10 * 60 * 1000) this.buckets.delete(k);
    }
  }
}

module.exports = { Limiter };
