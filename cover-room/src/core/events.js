// Tiny synchronous pub/sub. Event types and payloads: refs/design.md "Contracts".
export class Events {
  constructor() { this.map = new Map(); }

  on(type, fn) {
    let list = this.map.get(type);
    if (!list) { list = []; this.map.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this.map.get(type);
    if (!list) return;
    // Iterate a snapshot so handlers may unsubscribe while being called.
    for (const fn of list.slice()) fn(payload, type);
  }
}
