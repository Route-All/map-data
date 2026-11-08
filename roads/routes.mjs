// Road route relations → which routes each way carries. build.sh pipes one state's relations in as OPL:
//   osmium tags-filter <pbf> r/route=road -R | osmium cat -f opl | node routes.mjs > <work>/routes.tsv
// and tile.mjs keeps the result as the way's `routes` tag (format/roadTile.mjs TAGS): `network|ref|modifier|role` per
// relation, joined by ";". The app matches a permit's printed road to these (services/routeLabels.ts in the app):
// a Texas frontage road carrying the freeway's name is in no Interstate relation, so it is never the freeway.
import readline from 'node:readline';

// OPL escapes a space, comma, "=", "@" and anything not plain ASCII as %<hex code point>%.
const unescape = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
// The fields of one entry may not hold the separators: a relation's own ";" between refs becomes "/".
const field = (s) => String(s ?? '').replace(/[|;\t\r\n\x1f\0]/g, (c) => (c === ';' ? '/' : ' ')).trim();

/** One OPL relation line → [wayId, entry][], or [] for anything that is not a road route. */
export function relationEntries(line) {
  if (!line.startsWith('r')) return [];
  const parts = line.split(' ');
  const t = parts.find((p) => p.startsWith('T'))?.slice(1) ?? '';
  const m = parts.find((p) => p.startsWith('M'))?.slice(1) ?? '';
  const tags = Object.fromEntries(t ? t.split(',').map((kv) => { const eq = kv.indexOf('='); return [unescape(kv.slice(0, eq)), unescape(kv.slice(eq + 1))]; }) : []);
  if (tags.type !== 'route' || tags.route !== 'road' || !tags.ref) return [];
  const head = `${field(tags.network)}|${field(tags.ref)}|${field(tags.modifier)}`;
  return (m ? m.split(',') : []).filter((x) => x.startsWith('w')).map((x) => {
    const at = x.indexOf('@');
    return [x.slice(1, at), `${head}|${field(unescape(x.slice(at + 1)))}`];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const byWay = new Map();
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    for (const [way, entry] of relationEntries(line)) {
      const list = byWay.get(way) ?? [];
      if (!list.includes(entry)) list.push(entry);
      byWay.set(way, list);
    }
  }
  for (const [way, list] of byWay) process.stdout.write(`${way}\t${list.join(';')}\n`);
}
