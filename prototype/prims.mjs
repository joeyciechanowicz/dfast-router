// Primitive costs on a realistic (fresh, flat, non-internalized) string.
const base = ["/portal/fr-FR/items/2800255","/catalog/items/83685","/catalog/discover","/portal/browse/gamma-alpha","/catalog/lists/standard/popular/omega","/portal/fr-FR/windows/dropoff/2026-01-01"];
const N = 1 << 16, M = N - 1;
const fresh = (s) => Buffer.from(s, "latin1").toString("latin1");
const urls = Array.from({ length: N }, (_, i) => fresh(base[i % base.length]));
let sink = 0; globalThis.keep = null;
function t(name, f) {
  for (let r = 0; r < 4; r++) f(4e6);
  let best = Infinity;
  for (let r = 0; r < 6; r++) { const a = process.hrtime.bigint(); f(2e7); const b = process.hrtime.bigint(); best = Math.min(best, Number(b - a) / 2e7); }
  console.log(name.padEnd(46), best.toFixed(2).padStart(7), "ns");
}
t("loop overhead (array load+length)", (k) => { for (let i = 0; i < k; i++) sink += urls[i & M].length; });
t("charCodeAt x1", (k) => { for (let i = 0; i < k; i++) sink += urls[i & M].charCodeAt(7); });
t("charCodeAt x8 (literal compare)", (k) => { for (let i = 0; i < k; i++) { const s = urls[i & M]; sink += (s.charCodeAt(0)===47&&s.charCodeAt(1)===112&&s.charCodeAt(2)===111&&s.charCodeAt(3)===114&&s.charCodeAt(4)===116&&s.charCodeAt(5)===97&&s.charCodeAt(6)===108&&s.charCodeAt(7)===47)?1:0; } });
t("s[i] === 'x' x8 (medley style)", (k) => { for (let i = 0; i < k; i++) { const s = urls[i & M]; sink += (s[0]==="/"&&s[1]==="p"&&s[2]==="o"&&s[3]==="r"&&s[4]==="t"&&s[5]==="a"&&s[6]==="l"&&s[7]==="/")?1:0; } });
t("startsWith(8 chars, pos)", (k) => { for (let i = 0; i < k; i++) sink += urls[i & M].startsWith("/portal/") ? 1 : 0; });
t("indexOf('/', 8)", (k) => { for (let i = 0; i < k; i++) sink += urls[i & M].indexOf("/", 8); });
t("indexOf('?') full scan", (k) => { for (let i = 0; i < k; i++) sink += urls[i & M].indexOf("?"); });
t("JS loop to next '/' from 8", (k) => { for (let i = 0; i < k; i++) { const s = urls[i & M], n = s.length; let j = 8; while (j < n && s.charCodeAt(j) !== 47) j++; sink += j; } });
t("slice 5 chars (eager param)", (k) => { for (let i = 0; i < k; i++) globalThis.keep = urls[i & M].slice(8, 13); });
t("slice 7 chars", (k) => { for (let i = 0; i < k; i++) globalThis.keep = urls[i & M].slice(1, 8); });
t("slice 14 chars (SlicedString)", (k) => { for (let i = 0; i < k; i++) globalThis.keep = urls[i & M].slice(1, 15); });
const d = {}; d["GET"] = 1; const nullProto = Object.create(null); nullProto.GET = 1; const key = () => "GET";
t("params = {} ; p[dynKey]=v (medley)", (k) => { const names = ["id", "locale", "list", "page", "x1", "y2"]; for (let i = 0; i < k; i++) { const p = {}; p[names[i % 6]] = "v"; globalThis.keep = p; } });
t("fixed-shape {locale,id} literal", (k) => { for (let i = 0; i < k; i++) globalThis.keep = { locale: "a", id: "b" }; });
t("Map.get(charcode) (medley child)", (k) => { const m = new Map([[105,1],[98,2],[100,3],[111,4],[115,5]]); const cs=[105,98,100,111,115]; for (let i = 0; i < k; i++) sink += m.get(cs[i%5]); });
t("Uint16Array table step", (k) => { const T = new Uint16Array(4096); for (let i=0;i<4096;i++) T[i]=(i*7)&4095; let st = 1; for (let i = 0; i < k; i++) st = T[st ^ (i & 63)]; sink += st; });
const map = new Map(urls.slice(0,6).map((u) => [u, 1]));
t("Map.get(fresh url) [hash each time]", (k) => { const b = Array.from({length:256},(_, i)=>fresh(base[i%6])); for (let i = 0; i < k; i++) { const u = fresh("x"); sink += map.get(b[i & 255]) ?? 0; } });
console.log(sink > 0 ? "" : " ");
