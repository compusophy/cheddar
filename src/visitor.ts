/**
 * the network a visitor is on: what a limit "per visitor" is keyed on.
 *
 * an ipv4 address is one visitor, or one household, or one office. an ipv6 address is not: whoever
 * holds one holds the eighteen quintillion beside it, and can ask from a different one every time.
 * what identifies them is the first half, so for ipv6 that half is the visitor. an ipv4 address
 * written the ipv6 way is read as the ipv4 address it is, so one visitor is not two.
 */
export function network(ip: string): string {
  let a = String(ip || '').trim().toLowerCase();
  if (!a) return 'unknown';
  if (a.startsWith('[')) a = a.slice(1).replace(/\].*$/, ''); // [address]:port
  a = a.replace(/%.*$/, ''); // a zone, as in fe80::1%eth0
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(a)) return a.replace(/:\d+$/, '');
  const mapped = a.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  // write out the groups "::" stands for, and keep the first four of the eight
  const halves = a.split('::');
  if (halves.length > 2) return a;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups = tail === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a; // not an address this understands: used as it came
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
