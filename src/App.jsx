import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";

// ─── COVER IMAGE API ─────────────────────────────────
const COVER_BASE = "https://api.metabooks.com/api/v1/cover/";
// Try multiple token formats (full string, no space, UUID only)
const COVER_TOKEN = "93f03634-f8eb-4747-b870-46f9d24a7e76";
function coverUrl(code) {
  if (!code) return null;
  const clean = String(code).replace(/\D/g, "");
  if (clean.length !== 13) return null;
  return COVER_BASE + clean + "/m?access_token=" + COVER_TOKEN;
}

// Try to find an ISBN13 from any string (scans for 978/979 pattern)
function extractISBN(val) {
  if (!val) return null;
  const s = String(val).replace(/[\s-]/g, "");
  // Direct 13-digit check
  const d = s.replace(/\D/g, "");
  if (d.length === 13 && (d.startsWith("978") || d.startsWith("979"))) return d;
  // Regex scan for ISBN13 embedded in string
  const m = s.match(/(97[89]\d{10})/);
  return m ? m[1] : null;
}

// ─── CONSTANTS ───────────────────────────────────────
const TIERS = {
  liquidacao: { label: "Liquidação", color: "#DC2626", bg: "#FEE2E2", ring: "#FECACA", icon: "🔴", desc: "Sem vendas + estoque" },
  agressiva: { label: "Promo Agressiva", color: "#EA580C", bg: "#FFF7ED", ring: "#FED7AA", icon: "🟠", desc: ">36 meses cobertura" },
  moderada: { label: "Promo Moderada", color: "#CA8A04", bg: "#FEFCE8", ring: "#FEF08A", icon: "🟡", desc: "12–36 meses cobertura" },
  saudavel: { label: "Saudável", color: "#16A34A", bg: "#F0FDF4", ring: "#BBF7D0", icon: "🟢", desc: "<12 meses cobertura" },
};
const IPO_BANDS = [
  { min: 60, label: "Excelente", color: "#15803D", bg: "#DCFCE7" },
  { min: 45, label: "Saudável", color: "#4D7C0F", bg: "#ECFCCB" },
  { min: 30, label: "Atenção", color: "#A16207", bg: "#FEF9C3" },
  { min: 15, label: "Crítico", color: "#C2410C", bg: "#FFEDD5" },
  { min: 0, label: "Inviável", color: "#B91C1C", bg: "#FEE2E2" },
];
const getIPOBand = (s) => IPO_BANDS.find((b) => s >= b.min) || IPO_BANDS[4];
const fmt = (n, d = 0) => n != null && !isNaN(n) ? Number(n).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "–";
const fmtR = (n) => n != null && !isNaN(n) ? "R$ " + fmt(n, 2) : "–";
const r1 = (n) => Math.round(n * 10) / 10;

// ─── PRICE TIERS (auto-detected) ─────────────────────
const PRICE_TIERS = [
  { id: "economica", label: "Econômica", maxNormalDisc: 15, maxPromoDisc: 20, color: "#0891B2", bg: "#ECFEFF" },
  { id: "intermediaria", label: "Intermediária", maxNormalDisc: 40, maxPromoDisc: 45, color: "#7C3AED", bg: "#F5F3FF" },
  { id: "premium", label: "Premium", maxNormalDisc: 58, maxPromoDisc: 65, color: "#B45309", bg: "#FFFBEB" },
];

function detectPriceTier(discPct) {
  if (discPct <= 15) return PRICE_TIERS[0]; // econômica
  if (discPct <= 40) return PRICE_TIERS[1]; // intermediária
  return PRICE_TIERS[2]; // premium
}

// ─── IPO ENGINE ──────────────────────────────────────
function calcIPO(item, totalRev) {
  const cMg = (Math.max(0, Math.min(100, item.margin || 0)) / 100) * 20;
  let cTd = 10;
  if (item.qtyP1 > 0 && item.qtyP2 != null) {
    cTd = Math.max(0, Math.min(20, ((((item.qtyP2 - item.qtyP1) / item.qtyP1) * 100 + 50) / 100) * 20));
  }

  // Tier-aware price scoring
  let cPr = 10;
  if (item.listPrice > 0 && item.avgPrice > 0) {
    const discPct = (1 - item.avgPrice / item.listPrice) * 100;
    const tier = detectPriceTier(discPct);
    const normalCeil = tier.maxNormalDisc;
    const promoFloor = tier.maxPromoDisc;
    if (discPct <= normalCeil) {
      cPr = 20; // within healthy range
    } else if (discPct >= promoFloor) {
      cPr = 0; // at or beyond promo floor
    } else {
      cPr = r1(20 * (1 - (discPct - normalCeil) / (promoFloor - normalCeil)));
    }
    item._priceTier = tier;
    item._discPct = r1(discPct);
  }

  const cCt = Math.min(20, Math.log(1 + (totalRev > 0 ? (item.revenue / totalRev) * 100 : 0)) * 7);
  let cGi = 10;
  if (item.mesesEst != null) {
    cGi = item.mesesEst <= 3 ? 20 : item.mesesEst >= 24 ? 0 : 20 - ((item.mesesEst - 3) / 21) * 20;
  }
  return { ipo: r1(cMg + cTd + cPr + cCt + cGi), cMg: r1(cMg), cTd: r1(cTd), cPr: r1(cPr), cCt: r1(cCt), cGi: r1(cGi) };
}
function getTier(item) {
  if (item.mesesEst >= 900 || (item.estoque > 50 && (!item.vdaMes || item.vdaMes === 0))) return "liquidacao";
  if (item.mesesEst > 36) return "agressiva";
  if (item.mesesEst > 12) return "moderada";
  return "saudavel";
}
function getPromoPrice(item, tier) {
  if (tier === "liquidacao") return Math.max(item.cost * 1.05, item.avgPrice * 0.4);
  if (tier === "agressiva") return item.avgPrice * (1 - Math.min(0.45, Math.max(0.25, item.mesesEst / 1000)));
  if (tier === "moderada") return item.avgPrice * 0.85;
  return null;
}

// ─── PARSERS ─────────────────────────────────────────
// Normalize: lowercase, strip accents AND ordinal indicators (º ª)
function norm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[ºª°]/g, "")
    .trim();
}

function findCol(headers, patterns) {
  const nh = headers.map(norm);
  for (const p of patterns) {
    const np = norm(p);
    const i = nh.findIndex((h) => h.includes(np));
    if (i >= 0) return headers[i];
  }
  return null;
}

function toNum(v) {
  let s = String(v || "0").trim();
  if (!s || s === "-" || s === "*") return 0;
  // Remove currency symbols and spaces
  s = s.replace(/[R$\s]/g, "");
  const hasDot = s.includes("."), hasCom = s.includes(",");
  if (hasDot && hasCom) {
    // Both present: last one is the decimal separator
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      // Brazilian: 2.236,000 → 2236.000
      return Number(s.replace(/\./g, "").replace(",", ".")) || 0;
    }
    // English: 1,234.56 → 1234.56
    return Number(s.replace(/,/g, "")) || 0;
  }
  if (hasCom && !hasDot) {
    // Only comma: could be "1,5" (decimal) or "1,000" (thousands)
    // If exactly 3 digits after comma → ambiguous, but treat as decimal (1.000 = 1)
    // For Brazilian thousands like "1,000" user would also have dots
    return Number(s.replace(",", ".")) || 0;
  }
  if (hasDot && !hasCom) {
    // Only dot: ALWAYS treat as English decimal
    // "31.217333" → 31.217, "69.9" → 69.9, "1.000" → 1 (acceptable edge case)
    return Number(s) || 0;
  }
  return Number(s) || 0;
}

// Scan ALL columns of a row for an ISBN13
function scanRowForISBN(row, headers) {
  for (const h of headers) {
    const isbn = extractISBN(row[h]);
    if (isbn) return isbn;
  }
  return null;
}

// Parse MAAAA format (e.g. 12024=Jan24, 102024=Oct24) → sortable key YYYYMM
function parseMesAno(val) {
  const s = String(val || "").trim().replace(/\D/g, "");
  if (s.length < 5 || s.length > 6) return null;
  const year = s.slice(-4);
  const month = s.slice(0, s.length - 4).padStart(2, "0");
  if (+month < 1 || +month > 12) return null;
  return year + month; // "202401"
}
function mesAnoLabel(yyyymm) {
  const m = +yyyymm.slice(4, 6);
  const y = yyyymm.slice(2, 4);
  return ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][m - 1] + "/" + y;
}

function parseSales(rows) {
  if (!rows.length) return { items: [], allMonths: [] };
  const h = Object.keys(rows[0]);
  const cC = findCol(h, ["codigo", "code", "item", "sku"]) || h[0];
  const cD = findCol(h, ["codigo sbb", "descri", "produto", "product", "nome"]) || h[1];
  const cQ = findCol(h, ["soma de qtd", "quantidade", "qtd", "qty", "volume", "vendas", "unidades"]);
  const cP = findCol(h, ["media de valor", "valor unitario", "preco medio", "preco med", "avg price", "prc med"]);
  const cL = findCol(h, ["preco de lista", "preco lista", "list price", "preco tabela"]);
  const cK = findCol(h, ["custo unitario", "custo", "cost", "cst med", "custo_med"]);
  const cR = findCol(h, ["receita", "revenue", "faturamento", "valor total"]);
  const cM = findCol(h, ["mes/ano", "mes ano", "mesano", "periodo", "month"]);
  const cEAN = findCol(h, [
    "ean", "isbn", "ean13", "isbn13", "gtin", "barcode", "cod barras",
    "3 n", "n de item", "no de item", "no item", "num item",
  ]);

  const allMonthsSet = new Set();
  const map = {};

  for (const row of rows) {
    const code = String(row[cC] || "").trim();
    if (!code) continue;
    const qty = toNum(row[cQ]), price = toNum(row[cP]), list = toNum(row[cL]), cost = toNum(row[cK]);
    const rev = toNum(row[cR]) || qty * price;
    const mesKey = cM ? parseMesAno(row[cM]) : null;
    if (mesKey) allMonthsSet.add(mesKey);

    let ean = cEAN ? String(row[cEAN] || "").trim() : "";
    const isbn = extractISBN(ean) || extractISBN(code) || scanRowForISBN(row, h);

    if (!map[code]) map[code] = { code, desc: String(row[cD] || ""), qty: 0, revenue: 0, _pw: 0, _lw: 0, _cw: 0, n: 0, ean, isbn: isbn || "", monthly: {} };
    map[code].qty += qty; map[code].revenue += rev;
    map[code]._pw += price * qty; map[code]._lw += list * qty; map[code]._cw += cost * qty; map[code].n += 1;
    if (!map[code].isbn && isbn) map[code].isbn = isbn;
    if (!map[code].ean && ean) map[code].ean = ean;

    // Accumulate monthly qty
    if (mesKey) {
      map[code].monthly[mesKey] = (map[code].monthly[mesKey] || 0) + qty;
    }
  }

  const allMonths = [...allMonthsSet].sort();
  const nMonths = allMonths.length || 12;

  // Calculate trend: compare avg of last half vs first half
  const half = Math.max(1, Math.floor(allMonths.length / 2));
  const firstHalf = allMonths.slice(0, half);
  const secondHalf = allMonths.slice(-half);

  const items = Object.values(map).map((it) => {
    const series = allMonths.map(m => it.monthly[m] || 0);
    // Trend: avg qty second half vs first half
    const avgP1 = firstHalf.reduce((s, m) => s + (it.monthly[m] || 0), 0) / firstHalf.length;
    const avgP2 = secondHalf.reduce((s, m) => s + (it.monthly[m] || 0), 0) / secondHalf.length;

    return {
      code: it.code, desc: it.desc, qty: it.qty, revenue: it.revenue, ean: it.ean || "", isbn: it.isbn || "",
      avgPrice: it.qty > 0 ? it._pw / it.qty : 0, listPrice: it.qty > 0 ? it._lw / it.qty : 0, cost: it.qty > 0 ? it._cw / it.qty : 0,
      margin: it._pw > 0 ? ((it._pw - it._cw) / it._pw) * 100 : 0,
      vdaMes: it.qty / nMonths,
      series,
      qtyP1: avgP1,
      qtyP2: avgP2,
    };
  });

  return { items, allMonths };
}

function parseStock(rows) {
  if (!rows.length) return { byCode: {} };
  const h = Object.keys(rows[0]);
  const cC = findCol(h, ["n item", "codigo", "code", "item", "sku"]) || h[0];
  const cQ = findCol(h, ["quantidade disponivel", "disponivel", "estoque", "stock", "saldo"]);
  const cD = findCol(h, ["descricao", "descri", "produto"]);
  const map = {};
  for (const row of rows) {
    const code = String(row[cC] || "").trim();
    if (!code) continue;
    const qty = toNum(row[cQ]);
    const desc = cD ? String(row[cD] || "") : "";
    // Aggregate stock by code (sum quantities if multiple rows per product)
    if (!map[code]) map[code] = { estoque: 0, descStock: desc };
    map[code].estoque += qty;
    if (!map[code].descStock && desc) map[code].descStock = desc;
  }
  return { byCode: map };
}

// ─── STORAGE ─────────────────────────────────────────
async function loadHist() {
  try { const r = localStorage.getItem("ipo-hist"); return r ? JSON.parse(r) : []; } catch { return []; }
}
async function saveHist(label, summary) {
  try {
    const arr = await loadHist();
    arr.push({ label, date: new Date().toISOString(), ...summary });
    if (arr.length > 24) arr.splice(0, arr.length - 24);
    localStorage.setItem("ipo-hist", JSON.stringify(arr));
    return arr;
  } catch { return []; }
}

// ─── SPARKLINE COMPONENT ─────────────────────────────
function Sparkline({ series, width = 80, height = 24, color = "#3B82F6" }) {
  if (!series || series.length < 2) return <span style={{ color: "#CBD5E1", fontSize: 10 }}>—</span>;
  const max = Math.max(...series, 1);
  const min = Math.min(...series, 0);
  const range = max - min || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x},${y}`;
  });
  // Color: green if trending up, red if down
  const avgFirst = series.slice(0, Math.ceil(series.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(series.length / 2);
  const avgSecond = series.slice(-Math.ceil(series.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(series.length / 2);
  const trendColor = avgSecond >= avgFirst ? "#16A34A" : "#DC2626";
  // Fill area
  const fillPts = `0,${height} ${pts.join(" ")} ${width},${height}`;
  return (
    <svg width={width} height={height} style={{ display: "block", flexShrink: 0 }}>
      <polygon points={fillPts} fill={trendColor} opacity={0.1} />
      <polyline points={pts.join(" ")} fill="none" stroke={trendColor} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r={2} fill={trendColor} />
    </svg>
  );
}

// ─── COVER IMAGE COMPONENT ──────────────────────────
const coverCache = {};

function Cover({ code, size = 36 }) {
  const [src, setSrc] = useState(null);
  const [status, setStatus] = useState("idle");
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);
  const url = coverUrl(code);

  // Lazy load: only fetch when element is visible
  useEffect(() => {
    if (!ref.current || !url) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } }, { rootMargin: "100px" });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [url]);

  useEffect(() => {
    if (!visible || !url) return;
    if (coverCache[code] === "err") { setStatus("err"); return; }
    if (coverCache[code]) { setSrc(coverCache[code]); setStatus("ok"); return; }
    setStatus("loading");

    fetch(url, { referrerPolicy: "no-referrer", mode: "cors" })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(blob => {
        const blobUrl = URL.createObjectURL(blob);
        coverCache[code] = blobUrl;
        setSrc(blobUrl);
        setStatus("ok");
      })
      .catch(() => {
        // Fallback: try direct URL
        coverCache[code] = url;
        setSrc(url);
        setStatus("direct");
      });
  }, [visible, url, code]);

  const box = { width: size, height: size * 1.4, borderRadius: 3, border: "1px solid #E2E8F0", flexShrink: 0 };

  if (!url) return <div ref={ref} style={{ ...box, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, color: "#CBD5E1" }}>📖</div>;
  if (status === "err") return <div style={{ ...box, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, color: "#CBD5E1" }}>📖</div>;
  if (!src) return <div ref={ref} style={{ ...box, background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.25, color: "#CBD5E1" }}>⏳</div>;
  return (
    <img ref={ref} src={src} alt="" referrerPolicy="no-referrer"
      onError={() => { coverCache[code] = "err"; setStatus("err"); }}
      style={{ ...box, objectFit: "cover", background: "#F8FAFC" }}
    />
  );
}

// ─── MAIN ────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState("upload");
  const [salesRaw, setSalesRaw] = useState(null);
  const [stockRaw, setStockRaw] = useState(null);
  const [salesFn, setSalesFn] = useState("");
  const [stockFn, setStockFn] = useState("");
  const [monthsBack, setMonthsBack] = useState(0); // 0 = all
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("ipo");
  const [sortDir, setSortDir] = useState("desc");
  const [fTier, setFTier] = useState("all");
  const [fBand, setFBand] = useState("all");
  const [fPriceTier, setFPriceTier] = useState("all");
  const [search, setSearch] = useState("");
  const [sel, setSel] = useState(null);
  const [hist, setHist] = useState([]);
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState("");
  const [dbg, setDbg] = useState("");

  useEffect(() => {
    loadHist().then(setHist);
    const d = new Date();
    setLabel(["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"][d.getMonth()] + "/" + d.getFullYear());
  }, []);

  const readCSV = useCallback((file) => new Promise((res, rej) => {
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: (r) => res(r.data), error: rej });
  }), []);

  const onFile = useCallback(async (file, setData, setName) => {
    if (!file) return;
    setName(file.name);
    try { setData(await readCSV(file)); setError(null); } catch (e) { setError("Erro: " + e.message); }
  }, [readCSV]);

  const go = useCallback(() => {
    if (!salesRaw?.length) { setError("Envie o relatório de vendas."); return; }
    setError(null); setLoading(true);
    setTimeout(() => { setStep("results"); setLoading(false); }, 50);
  }, [salesRaw]);

  const { results, detectedMonths, totalMonths } = useMemo(() => {
    if (!salesRaw) return { results: [], detectedMonths: [], totalMonths: 0 };

    // Detect all months in raw data first
    const h = Object.keys(salesRaw[0] || {});
    const cM = findCol(h, ["mes/ano", "mes ano", "mesano", "periodo", "month"]);
    const rawMonths = [...new Set(salesRaw.map(r => cM ? parseMesAno(r[cM]) : null).filter(Boolean))].sort();
    const totalMonths = rawMonths.length;

    // Filter rows to last N months if selected
    let filteredRows = salesRaw;
    let activeMonths = rawMonths;
    if (monthsBack > 0 && rawMonths.length > monthsBack) {
      activeMonths = rawMonths.slice(-monthsBack);
      const activeSet = new Set(activeMonths);
      filteredRows = salesRaw.filter(r => {
        const mk = cM ? parseMesAno(r[cM]) : null;
        return mk && activeSet.has(mk);
      });
    }

    const { items: sales, allMonths: months } = parseSales(filteredRows);
    const { byCode: stock } = stockRaw ? parseStock(stockRaw) : { byCode: {} };
    const totalRev = sales.reduce((s, i) => s + i.revenue, 0);
    const items = sales.map((item) => {
      // Direct match: Código (vendas) = Nº Item (estoque)
      const si = stock[item.code] || null;
      const estoque = si?.estoque ?? null;
      const mesesEst = estoque != null && item.vdaMes > 0 ? estoque / item.vdaMes : estoque > 0 ? 999 : null;
      const isbn = item.isbn || extractISBN(item.code) || extractISBN(item.ean) || "";
      const e = { ...item, estoque, mesesEst, descStock: si?.descStock || "", isbn };
      const ipo = calcIPO(e, totalRev);
      const tier = estoque != null ? getTier({ ...e, mesesEst }) : "saudavel";
      const pp = tier !== "saudavel" ? getPromoPrice(e, tier) : null;
      const pm = pp && pp > 0 ? ((pp - e.cost) / pp) * 100 : null;
      const trend = item.qtyP1 > 0 ? ((item.qtyP2 - item.qtyP1) / item.qtyP1) * 100 : (item.qtyP2 > 0 ? 100 : 0);
      return { ...e, ...ipo, tier, pp: pp ? r1(pp) : null, pm: pm ? r1(pm) : null, band: getIPOBand(ipo.ipo), trend: r1(trend) };
    });

    return { results: items, detectedMonths: months, totalMonths };
  }, [salesRaw, stockRaw, monthsBack]);

  useEffect(() => {
    if (!detectedMonths.length) return;
    const m = detectedMonths;
    const withISBN = results.filter(i => i.isbn).length;
    const withCover = results.filter(i => coverUrl(i.code)).length;
    const withStock = results.filter(i => i.estoque != null).length;
    setDbg(`${m.length}/${totalMonths} meses (${mesAnoLabel(m[0])}→${mesAnoLabel(m[m.length-1])}) | ${withStock}/${results.length} com estoque | ${withCover} com capa`);
  }, [detectedMonths, results, totalMonths]);

  const filtered = useMemo(() => {
    let l = results;
    if (fTier !== "all") l = l.filter(r => r.tier === fTier);
    if (fBand !== "all") l = l.filter(r => r.band.label === fBand);
    if (fPriceTier !== "all") l = l.filter(r => r._priceTier?.id === fPriceTier);
    if (search) { const t = search.toLowerCase(); l = l.filter(r => r.code.toLowerCase().includes(t) || r.desc.toLowerCase().includes(t) || (r.descStock || "").toLowerCase().includes(t) || (r.isbn || "").includes(t)); }
    return [...l].sort((a, b) => sortDir === "desc" ? (b[sortKey] ?? -1e9) - (a[sortKey] ?? -1e9) : (a[sortKey] ?? 1e9) - (b[sortKey] ?? 1e9));
  }, [results, fTier, fBand, fPriceTier, search, sortKey, sortDir]);

  const stats = useMemo(() => {
    if (!results.length) return null;
    const ws = results.filter(r => r.estoque != null);
    const tRev = results.reduce((s, r) => s + r.revenue, 0);
    const ti = { liquidacao: 0, agressiva: 0, moderada: 0, saudavel: 0 };
    ws.forEach(r => { ti[r.tier]++; });
    return {
      skus: results.length, skusEst: ws.length, tRev,
      avgIPO: results.reduce((s, r) => s + r.ipo, 0) / results.length,
      avgMg: results.reduce((s, r) => s + r.margin, 0) / results.length,
      tEst: ws.reduce((s, r) => s + (r.estoque || 0), 0),
      vlP: ws.filter(r => r.tier !== "saudavel").reduce((s, r) => s + (r.estoque || 0) * (r.cost || 0), 0),
      rcP: ws.filter(r => r.pp).reduce((s, r) => s + (r.estoque || 0) * (r.pp || 0), 0),
      p45: tRev > 0 ? results.filter(r => r.ipo >= 45).reduce((s, r) => s + r.revenue, 0) / tRev * 100 : 0,
      ti, withISBN: results.filter(r => r.isbn).length,
    };
  }, [results]);

  const prev = useMemo(() => hist.length ? hist[hist.length - 1] : null, [hist]);

  const doSave = useCallback(async () => {
    if (!stats) return;
    const h = await saveHist(label, { skus: stats.skus, avgIPO: r1(stats.avgIPO), avgMg: r1(stats.avgMg), tRev: Math.round(stats.tRev), tEst: stats.tEst, vlP: Math.round(stats.vlP), p45: r1(stats.p45), ti: stats.ti });
    setHist(h); setSaved("Salvo!"); setTimeout(() => setSaved(""), 3000);
  }, [stats, label]);

  const doExport = useCallback(() => {
    if (!filtered.length) return;
    const csv = Papa.unparse(filtered.map(r => ({
      Codigo: r.code, ISBN: r.isbn || "", EAN: r.ean || "", Descricao: r.descStock || r.desc, IPO: r.ipo, Faixa: r.band.label,
      CategoriaPreco: r._priceTier?.label || "", DescontoPct: r._discPct ?? "",
      Tier: TIERS[r.tier]?.label || "", Margem: r1(r.margin), PrecoMedio: r1(r.avgPrice),
      PrecoLista: r1(r.listPrice), Custo: r1(r.cost), Quantidade: r.qty, Receita: Math.round(r.revenue),
      Estoque: r.estoque ?? "", MesesEstoque: r.mesesEst != null ? (r.mesesEst >= 900 ? "999" : Math.round(r.mesesEst)) : "",
      Tendencia: r.trend ?? "", PrecoPromo: r.pp ?? "", MargemPromo: r.pm ?? "",
    })), { delimiter: ";" });
    const b = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const u = URL.createObjectURL(b);
    Object.assign(document.createElement("a"), { href: u, download: "ipo_" + label.replace("/", "-") + ".csv" }).click();
    URL.revokeObjectURL(u);
  }, [filtered, label]);

  const doSort = (k) => { sortKey === k ? setSortDir(d => d === "asc" ? "desc" : "asc") : (setSortKey(k), setSortDir("desc")); };

  // ═══════════════════ UPLOAD ═══════════════════
  if (step === "upload") {
    return (
      <div style={U.page}>
        <div style={{ maxWidth: 620, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={U.badge}>
              <span style={{ fontSize: 16 }}>📊</span>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: "#1D4ED8" }}>SBB — ÍNDICE DE PERFORMANCE DE OFERTA</span>
            </div>
            <h1 style={U.h1}>IPO Dashboard</h1>
            <p style={{ fontSize: 13, color: "#64748B", margin: 0 }}>Suba seus CSVs, receba análise automática com sugestões de promoção e capas dos produtos</p>
          </div>

          <div style={{ ...U.card, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 0.8 }}>Rótulo</span>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Fev/2026" style={U.input} />
            <span style={{ fontSize: 10, color: "#CBD5E1", whiteSpace: "nowrap" }}>p/ histórico</span>
          </div>

          <FileBox label="Relatório de Vendas" tag="Obrigatório" color="#2563EB" name={salesFn}
            hint="CSV com: Código, Descrição, Qtd, Preço Médio, Preço Lista, Custo, Mes/Ano (MAAAA)."
            onFile={f => onFile(f, setSalesRaw, setSalesFn)} />
          <FileBox label="Posição de Estoque" tag="Recomendado" color="#059669" name={stockFn}
            hint="CSV: Código, 3º Nº de Item (ISBN), Qtd Disponível, Descrição."
            onFile={f => onFile(f, setStockRaw, setStockFn)} />

          <div style={U.card}>
            <div style={U.lbl}>Período de análise</div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {[0, 3, 6, 12, 18, 24].map(m => (
                <button key={m} onClick={() => setMonthsBack(m)} style={{
                  ...U.pBtn, flex: "0 0 auto",
                  ...(monthsBack === m ? { border: "2px solid #3B82F6", background: "#EFF6FF", color: "#1D4ED8", fontWeight: 700 } : {}),
                }}>{m === 0 ? "Todos" : m + " meses"}</button>
              ))}
            </div>
            {salesRaw && <p style={{ fontSize: 10, color: "#94A3B8", margin: "6px 0 0" }}>
              {totalMonths} meses detectados no CSV{monthsBack > 0 ? ` · usando últimos ${Math.min(monthsBack, totalMonths)}` : ""}
            </p>}
          </div>

          {hist.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={U.sum}>📅 Histórico ({hist.length} análises salvas)</summary>
              <div style={{ paddingTop: 6 }}>
                {hist.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: "#64748B", padding: "5px 0", borderBottom: "1px solid #F1F5F9" }}>
                    <b style={{ color: "#334155" }}>{h.label}</b>
                    <span>{new Date(h.date).toLocaleDateString("pt-BR")}</span>
                    <span>IPO {h.avgIPO}</span>
                    <span>Mg {h.avgMg}%</span>
                    <span>{h.skus} SKUs</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {error && <div style={{ marginTop: 10, padding: "9px 12px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", color: "#DC2626", fontSize: 12 }}>⚠️ {error}</div>}

          <button onClick={go} disabled={loading || !salesRaw} style={{
            width: "100%", marginTop: 16, padding: 14, borderRadius: 10, border: "none", fontSize: 15, fontWeight: 700,
            cursor: salesRaw ? "pointer" : "default", transition: "all 0.2s",
            background: salesRaw ? "linear-gradient(135deg,#1D4ED8,#2563EB)" : "#F1F5F9",
            color: salesRaw ? "#FFF" : "#CBD5E1",
            boxShadow: salesRaw ? "0 2px 12px rgba(37,99,235,0.25)" : "none",
          }}>
            {loading ? "Processando..." : "Analisar Portfólio"}
          </button>

          <div style={{ marginTop: 12, padding: "10px 14px", background: "#FFFBEB", border: "1px solid #FEF08A", borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: "#92400E", fontWeight: 700, marginBottom: 4 }}>📷 Para exibir capas dos produtos:</div>
            <div style={{ fontSize: 11, color: "#A16207", lineHeight: 1.6 }}>
              Inclua uma coluna com <b>ISBN13</b> (978xxx ou 979xxx) no CSV.
              Pode ser: <code style={{ background: "#FEF3C7", padding: "1px 4px", borderRadius: 3 }}>EAN</code>,
              <code style={{ background: "#FEF3C7", padding: "1px 4px", borderRadius: 3 }}>ISBN</code>,
              <code style={{ background: "#FEF3C7", padding: "1px 4px", borderRadius: 3 }}>3º Nº de Item</code>, ou
              até o próprio <code style={{ background: "#FEF3C7", padding: "1px 4px", borderRadius: 3 }}>Código</code> se for ISBN13.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════ RESULTS ═══════════════════
  return (
    <div style={P.page}>
      {/* Topbar */}
      <div style={P.topbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 15 }}>📊</span>
          <b style={{ fontSize: 14, color: "#1E293B" }}>IPO Dashboard</b>
          <span style={P.chip}>{stats?.skus} SKUs · {detectedMonths.length}m · {label}</span>
          {stats?.withISBN > 0 && <span style={{ ...P.chip, background: "#DCFCE7", color: "#15803D" }}>📷 {stats.withISBN} capas</span>}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <button onClick={doSave} style={P.btnGreen}>{saved ? "✓ " + saved : "💾 Salvar"}</button>
          <button onClick={doExport} style={P.btnBlue}>⬇ Exportar CSV</button>
          <button onClick={() => { setStep("upload"); setSel(null); }} style={P.btnGray}>← Nova análise</button>
        </div>
      </div>

      <div style={{ padding: "16px 18px 60px", maxWidth: 1280, margin: "0 auto" }}>
        {/* Debug bar */}
        {dbg && <div style={{ fontSize: 10, color: "#94A3B8", background: "#F8FAFC", border: "1px solid #F1F5F9", borderRadius: 6, padding: "5px 10px", marginBottom: 10, fontFamily: "monospace" }}>🔍 {dbg}</div>}

        {/* KPIs */}
        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 8, marginBottom: 16 }}>
            <KCard l="IPO Médio" v={fmt(stats.avgIPO, 1)} s="de 100" c={getIPOBand(stats.avgIPO).color} d={prev ? r1(stats.avgIPO - prev.avgIPO) : null} />
            <KCard l="Receita" v={fmtR(stats.tRev)} s={detectedMonths.length + "m"} c="#1D4ED8" d={prev ? Math.round(stats.tRev - prev.tRev) : null} money />
            <KCard l="Margem Média" v={fmt(stats.avgMg, 1) + "%"} s="portfólio" c="#7C3AED" d={prev ? r1(stats.avgMg - prev.avgMg) : null} sf="pp" />
            <KCard l="Estoque" v={fmt(stats.tEst)} s={stats.skusEst + " SKUs"} c="#0891B2" />
            <KCard l="Capital Parado" v={fmtR(stats.vlP)} s=">12m cobertura" c={stats.vlP > 1e6 ? "#DC2626" : "#D97706"} d={prev ? Math.round(stats.vlP - prev.vlP) : null} money inv />
            <KCard l="Meta ≥45" v={fmt(stats.p45, 1) + "%"} s={stats.p45 >= 75 ? "✓ Atingida" : "⚠ Meta 75%"} c={stats.p45 >= 75 ? "#15803D" : "#D97706"} d={prev ? r1(stats.p45 - prev.p45) : null} sf="pp" />
          </div>
        )}

        {/* Tier cards */}
        {stats && stats.skusEst > 0 && (
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {Object.entries(TIERS).map(([k, t]) => (
              <button key={k} onClick={() => setFTier(fTier === k ? "all" : k)} style={{
                flex: "1 1 130px", padding: "10px 12px", borderRadius: 10, cursor: "pointer", textAlign: "left", transition: "all 0.15s",
                background: fTier === k ? t.bg : "#FFFFFF",
                border: fTier === k ? "2px solid " + t.color : "1px solid #E2E8F0",
                boxShadow: fTier === k ? "0 1px 6px " + t.color + "22" : "0 1px 3px rgba(0,0,0,0.04)",
              }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: t.color }}>{stats.ti[k]}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B" }}>{t.icon} {t.label}</div>
              </button>
            ))}
          </div>
        )}

        {/* Search & filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ position: "relative", flex: "1 1 200px" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar código, descrição ou ISBN..."
              style={{ width: "100%", padding: "9px 12px 9px 32px", borderRadius: 8, fontSize: 13, background: "#FFF", border: "1px solid #E2E8F0", color: "#1E293B", outline: "none", boxSizing: "border-box" }} />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "#94A3B8" }}>🔍</span>
          </div>
          <select value={fBand} onChange={e => setFBand(e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, fontSize: 13, background: "#FFF", border: "1px solid #E2E8F0", color: "#334155", cursor: "pointer" }}>
            <option value="all">Todas as faixas</option>
            {IPO_BANDS.map(b => <option key={b.label} value={b.label}>{b.label} (≥{b.min})</option>)}
          </select>
          <select value={fPriceTier} onChange={e => setFPriceTier(e.target.value)} style={{ padding: "9px 12px", borderRadius: 8, fontSize: 13, background: "#FFF", border: "1px solid #E2E8F0", color: "#334155", cursor: "pointer" }}>
            <option value="all">Todas as categorias</option>
            {PRICE_TIERS.map(t => <option key={t.id} value={t.id}>{t.label} (até {t.maxNormalDisc}%)</option>)}
          </select>
          <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>{filtered.length} itens</span>
        </div>

        {/* Table */}
        <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#F8FAFC" }}>
                  <th style={{ ...P.th, width: 42, textAlign: "center" }}></th>
                  {COL_DEF.map(c => (
                    <th key={c.k} onClick={() => doSort(c.k)} style={{
                      ...P.th, textAlign: c.a || "right", minWidth: c.w,
                      color: sortKey === c.k ? "#2563EB" : "#94A3B8",
                    }}>
                      {c.h} {sortKey === c.k ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 300).map((r, i) => {
                  const ti = TIERS[r.tier];
                  const isSel = sel?.code === r.code;
                  return (
                    <tr key={r.code + i} onClick={() => setSel(isSel ? null : r)}
                      style={{
                        cursor: "pointer", transition: "background 0.1s",
                        background: isSel ? "#EFF6FF" : i % 2 ? "#FAFBFC" : "#FFF",
                        borderBottom: "1px solid #F1F5F9",
                      }}>
                      <td style={{ padding: "4px 6px", textAlign: "center", verticalAlign: "middle" }}>
                        <Cover code={r.code} size={28} />
                      </td>
                      <td style={P.td}>
                        <span style={{ display: "inline-block", padding: "2px 7px", borderRadius: 5, fontWeight: 800, fontSize: 12, color: r.band.color, background: r.band.bg }}>
                          {fmt(r.ipo, 1)}
                        </span>
                      </td>
                      <td style={{ ...P.td, fontFamily: "'SF Mono','Cascadia Code',monospace", fontSize: 10.5, color: "#64748B", textAlign: "right" }}>{r.code}</td>
                      <td style={{ ...P.td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", color: "#334155" }}>
                        {r.descStock || r.desc || "–"}
                        {r._priceTier && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 4, background: r._priceTier.bg, color: r._priceTier.color, fontWeight: 700 }}>{r._priceTier.label[0]}</span>}
                      </td>
                      <td style={{ ...P.td, textAlign: "center", padding: "4px 4px" }}>
                        <Sparkline series={r.series} width={80} height={22} />
                      </td>
                      <td style={{ ...P.td, color: r.margin < 20 ? "#DC2626" : r.margin < 40 ? "#D97706" : "#15803D", fontWeight: 600 }}>{fmt(r.margin, 1)}%</td>
                      <td style={P.td}>{fmtR(r.avgPrice)}</td>
                      <td style={P.td}>{fmt(r.qty)}</td>
                      <td style={{ ...P.td, fontWeight: 600, color: "#334155" }}>{fmtR(r.revenue)}</td>
                      <td style={{ ...P.td, color: r.estoque == null ? "#E2E8F0" : "#334155" }}>{r.estoque != null ? fmt(r.estoque) : "–"}</td>
                      <td style={{ ...P.td, fontWeight: 600, color: r.mesesEst == null ? "#E2E8F0" : r.mesesEst > 36 ? "#DC2626" : r.mesesEst > 12 ? "#D97706" : "#15803D" }}>
                        {r.mesesEst == null ? "–" : r.mesesEst >= 900 ? "∞" : fmt(r.mesesEst)}
                      </td>
                      <td style={P.td}>
                        {ti && r.tier !== "saudavel" && (
                          <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: ti.bg, color: ti.color, fontWeight: 600, whiteSpace: "nowrap", border: "1px solid " + ti.ring }}>
                            {ti.icon} {ti.label}
                          </span>
                        )}
                      </td>
                      <td style={{ ...P.td, color: "#B45309", fontWeight: 700 }}>{r.pp ? fmtR(r.pp) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 300 && <div style={{ padding: 10, textAlign: "center", fontSize: 11, color: "#94A3B8" }}>Mostrando 300 de {filtered.length}. Use filtros para refinar.</div>}
        </div>

        {/* Detail panel */}
        {sel && (() => {
          const ti = TIERS[sel.tier];
          return (
            <div style={{ marginTop: 16, background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 14, padding: 20, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", gap: 20, marginBottom: 16 }}>
                <div style={{ flexShrink: 0 }}>
                  <Cover code={sel.code} size={120} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#1E293B", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sel.descStock || sel.desc}
                  </h3>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94A3B8" }}>{sel.code}</span>
                    {sel.isbn && <span style={{ fontFamily: "monospace", fontSize: 11, color: "#94A3B8" }}>ISBN {sel.isbn}</span>}
                    <span style={{ padding: "2px 8px", borderRadius: 5, fontWeight: 800, fontSize: 14, color: sel.band.color, background: sel.band.bg }}>
                      IPO {fmt(sel.ipo, 1)}
                    </span>
                    <span style={{ fontSize: 12, color: sel.band.color, fontWeight: 600 }}>{sel.band.label}</span>
                  </div>
                  {coverUrl(sel.code) && (
                    <div style={{ marginTop: 6, fontSize: 10, color: "#94A3B8" }}>
                      📷 EAN: <code style={{ background: "#F1F5F9", padding: "1px 4px", borderRadius: 3 }}>{sel.code}</code>
                      {sel.isbn && sel.isbn !== sel.code ? <>{" · "}ISBN: <code style={{ background: "#F1F5F9", padding: "1px 4px", borderRadius: 3 }}>{sel.isbn}</code></> : null}
                      {" · "}
                      <a href={coverUrl(sel.code)} target="_blank" rel="noreferrer" style={{ color: "#3B82F6" }}>Abrir capa ↗</a>
                    </div>
                  )}
                </div>
              </div>

              {/* Monthly performance sparkline */}
              {sel.series && sel.series.length > 1 && (() => {
                const W = 540, H = 100, PAD = { t: 4, b: 18, l: 36, r: 8 };
                const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
                const max = Math.max(...sel.series, 1);
                const barW = Math.max(2, (cw / sel.series.length) - 2);
                const avgFirst = sel.series.slice(0, Math.ceil(sel.series.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(sel.series.length / 2);
                const avgSecond = sel.series.slice(-Math.ceil(sel.series.length / 2)).reduce((a, b) => a + b, 0) / Math.ceil(sel.series.length / 2);
                const trendColor = avgSecond >= avgFirst ? "#16A34A" : "#DC2626";
                // Y-axis ticks
                const ySteps = [0, Math.round(max / 2), Math.round(max)];
                return (
                  <div style={{ background: "#F8FAFC", borderRadius: 10, padding: "12px 16px", marginBottom: 16, border: "1px solid #E2E8F0" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 0.8 }}>Vendas mensais</span>
                      <span style={{ fontSize: 10, color: trendColor, fontWeight: 700 }}>
                        {sel.trend >= 0 ? "▲" : "▼"} {Math.abs(sel.trend).toFixed(1)}% tendência
                      </span>
                    </div>
                    <svg width={W} height={H} style={{ display: "block" }}>
                      {/* Grid lines */}
                      {ySteps.map(v => {
                        const y = PAD.t + ch - (v / max) * ch;
                        return <g key={v}>
                          <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="#E2E8F0" strokeWidth={0.5} strokeDasharray={v > 0 ? "3,3" : "0"} />
                          <text x={PAD.l - 4} y={y + 3} textAnchor="end" fontSize={8} fill="#94A3B8">{v}</text>
                        </g>;
                      })}
                      {/* Bars */}
                      {sel.series.map((v, i) => {
                        const x = PAD.l + (i / sel.series.length) * cw + 1;
                        const barH = Math.max(1, (v / max) * ch);
                        const y = PAD.t + ch - barH;
                        const isZero = v === 0;
                        return <rect key={i} x={x} y={isZero ? PAD.t + ch - 1 : y} width={barW} height={isZero ? 1 : barH}
                          fill={isZero ? "#E2E8F0" : trendColor} opacity={isZero ? 0.5 : 0.7} rx={1} />;
                      })}
                      {/* Month labels */}
                      {detectedMonths.map((m, i) => {
                        const show = i % Math.max(1, Math.floor(detectedMonths.length / 10)) === 0 || i === detectedMonths.length - 1;
                        if (!show) return null;
                        const x = PAD.l + (i / sel.series.length) * cw + barW / 2;
                        return <text key={m} x={x} y={H - 2} textAnchor="middle" fontSize={8} fill="#94A3B8">{mesAnoLabel(m)}</text>;
                      })}
                    </svg>
                  </div>
                );
              })()}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
                {[
                  { l: "Margem", v: sel.cMg, c: "#7C3AED", bg: "#F5F3FF" },
                  { l: "Tendência", v: sel.cTd, c: "#2563EB", bg: "#EFF6FF" },
                  { l: "Preço", v: sel.cPr, c: "#0891B2", bg: "#ECFEFF", sub: sel._priceTier ? sel._priceTier.label : null },
                  { l: "Contribuição", v: sel.cCt, c: "#D97706", bg: "#FFFBEB" },
                  { l: "Giro", v: sel.cGi, c: "#059669", bg: "#ECFDF5" },
                ].map(x => (
                  <div key={x.l} style={{ background: x.bg, borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 10, color: "#64748B", fontWeight: 600 }}>{x.l}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: x.c }}>{x.v}</div>
                    <div style={{ height: 4, background: "#E2E8F0", borderRadius: 2, marginTop: 5, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: (x.v / 20 * 100) + "%", background: x.c, borderRadius: 2, transition: "width 0.4s" }} />
                    </div>
                    {x.sub ? (
                      <div style={{ fontSize: 8, color: x.c, marginTop: 3, fontWeight: 700 }}>{x.sub}</div>
                    ) : (
                      <div style={{ fontSize: 9, color: "#CBD5E1", marginTop: 2 }}>de 20</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Price tier context */}
              {sel._priceTier && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, padding: "8px 12px", borderRadius: 8, background: sel._priceTier.bg, border: "1px solid #E2E8F0" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: sel._priceTier.color }}>{sel._priceTier.label}</span>
                  <span style={{ fontSize: 11, color: "#64748B" }}>
                    Desc. praticado: <b>{fmt(sel._discPct, 1)}%</b>
                  </span>
                  <span style={{ fontSize: 10, color: "#94A3B8" }}>
                    (faixa normal: até {sel._priceTier.maxNormalDisc}% · promo: até {sel._priceTier.maxPromoDisc}%)
                  </span>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 6, marginBottom: 14 }}>
                {[
                  ["Preço Médio", fmtR(sel.avgPrice)], ["Preço Lista", fmtR(sel.listPrice)],
                  ["Custo", fmtR(sel.cost)], ["Margem", fmt(sel.margin, 1) + "%"],
                  ["Desconto", sel._discPct != null ? fmt(sel._discPct, 1) + "%" : "N/D"],
                  ["Estoque", sel.estoque != null ? fmt(sel.estoque) : "N/D"],
                  ["Meses Est.", sel.mesesEst == null ? "N/D" : sel.mesesEst >= 900 ? "∞" : fmt(sel.mesesEst)],
                ].map(([l, v]) => (
                  <div key={l} style={{ background: "#F8FAFC", borderRadius: 7, padding: "7px 10px", border: "1px solid #F1F5F9" }}>
                    <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600 }}>{l}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#1E293B" }}>{v}</div>
                  </div>
                ))}
              </div>

              {sel.pp && (
                <div style={{ padding: 14, borderRadius: 10, background: ti?.bg || "#FFFBEB", border: "1px solid " + (ti?.ring || "#FEF08A") }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: ti?.color, marginBottom: 4 }}>{ti?.icon} Sugestão: {ti?.label}</div>
                  <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.8 }}>
                    Preço promocional: <b style={{ color: "#B45309" }}>{fmtR(sel.pp)}</b>
                    {sel.avgPrice > 0 && <> ({fmt((1 - sel.pp / sel.avgPrice) * 100)}% de desconto)</>}
                    <br />
                    Margem na promoção: <b style={{ color: sel.pm > 20 ? "#15803D" : "#DC2626" }}>{fmt(sel.pm, 1)}%</b>
                    <span style={{ margin: "0 8px", color: "#CBD5E1" }}>·</span>
                    Receita potencial: <b style={{ color: "#1D4ED8" }}>{fmtR((sel.estoque || 0) * sel.pp)}</b>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── SUB-COMPONENTS ──────────────────────────────────
function FileBox({ label, tag, color, name, hint, onFile }) {
  const ref = useRef();
  const [drag, setDrag] = useState(false);
  return (
    <div onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={e => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}
      onClick={() => ref.current?.click()}
      style={{
        background: name ? color + "08" : drag ? color + "06" : "#FFF",
        border: name ? "2px solid " + color : drag ? "2px dashed " + color : "1.5px dashed #CBD5E1",
        borderRadius: 10, padding: "13px 14px", marginBottom: 8, cursor: "pointer", transition: "all 0.15s",
      }}>
      <input ref={ref} type="file" accept=".csv,.txt,.tsv" onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); }} style={{ display: "none" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: name ? color + "15" : "#F8FAFC", fontSize: 16, border: "1px solid " + (name ? color + "33" : "#E2E8F0") }}>
          {name ? "✓" : "📁"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: name ? color : "#334155" }}>{label}</span>
            <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: "#F1F5F9", color: "#94A3B8" }}>{tag}</span>
          </div>
          <div style={{ fontSize: 11, color: name ? "#059669" : "#94A3B8", marginTop: 2 }}>{name ? "✓ " + name : hint}</div>
        </div>
      </div>
    </div>
  );
}

function SmallFile({ label, name, n, onFile }) {
  const ref = useRef();
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, color: "#94A3B8", marginBottom: 3, fontWeight: 600 }}>{label}</div>
      <button onClick={() => ref.current?.click()} style={{
        padding: "6px 10px", borderRadius: 6, background: "#FFF", border: "1px solid #E2E8F0",
        color: name ? "#059669" : "#94A3B8", fontSize: 11, cursor: "pointer", fontWeight: 600,
      }}>
        {name ? "✓ " + n + " linhas" : "Escolher CSV..."}
      </button>
      <input ref={ref} type="file" accept=".csv,.txt" onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); }} style={{ display: "none" }} />
    </div>
  );
}

function KCard({ l, v, s, c, d, money, sf = "", inv }) {
  const up = inv ? d < 0 : d > 0;
  return (
    <div style={{ background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "10px 12px", borderLeft: "3px solid " + c, boxShadow: "0 1px 3px rgba(0,0,0,0.03)" }}>
      <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{l}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 1 }}>
        <span style={{ fontSize: 10, color: "#CBD5E1" }}>{s}</span>
        {d != null && d !== 0 && (
          <span style={{ fontSize: 10, fontWeight: 700, color: up ? "#15803D" : "#DC2626" }}>
            {up ? "▲" : "▼"} {money ? fmtR(Math.abs(d)) : fmt(Math.abs(d), 1) + sf}
          </span>
        )}
      </div>
    </div>
  );
}

const COL_DEF = [
  { k: "ipo", h: "IPO", w: 52 }, { k: "code", h: "Código", w: 100 },
  { k: "desc", h: "Descrição", w: 200, a: "left" }, { k: "trend", h: "Tendência", w: 90, a: "center" }, { k: "margin", h: "Mg%", w: 50 },
  { k: "avgPrice", h: "P.Méd", w: 72 }, { k: "qty", h: "Qtd", w: 60 },
  { k: "revenue", h: "Receita", w: 85 }, { k: "estoque", h: "Est.", w: 60 },
  { k: "mesesEst", h: "Meses", w: 50 }, { k: "tier", h: "Ação", w: 115 },
  { k: "pp", h: "P.Promo", w: 78 },
];

const U = {
  page: { minHeight: "100vh", background: "linear-gradient(180deg, #F8FAFC 0%, #EFF6FF 100%)", fontFamily: "'Segoe UI','SF Pro Display',-apple-system,sans-serif", color: "#334155", padding: "24px 18px" },
  badge: { display: "inline-flex", alignItems: "center", gap: 8, background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 8, padding: "5px 14px", marginBottom: 14 },
  h1: { fontSize: 30, fontWeight: 800, margin: "0 0 5px", letterSpacing: -0.8, color: "#0F172A" },
  card: { background: "#FFF", border: "1px solid #E2E8F0", borderRadius: 10, padding: "13px 16px", marginBottom: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  lbl: { fontSize: 10, fontWeight: 700, color: "#94A3B8", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.8 },
  pBtn: { flex: 1, padding: "9px 12px", borderRadius: 7, border: "1px solid #E2E8F0", background: "#F8FAFC", color: "#64748B", fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" },
  input: { flex: 1, padding: "7px 10px", borderRadius: 7, background: "#F8FAFC", border: "1px solid #E2E8F0", color: "#1E293B", fontSize: 13, outline: "none" },
  sum: { cursor: "pointer", fontSize: 11, color: "#94A3B8", padding: "5px 0", fontWeight: 600 },
};

const P = {
  page: { minHeight: "100vh", background: "#F1F5F9", fontFamily: "'Segoe UI','SF Pro Display',-apple-system,sans-serif", color: "#334155" },
  topbar: { background: "rgba(255,255,255,0.95)", borderBottom: "1px solid #E2E8F0", padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(8px)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  chip: { fontSize: 10, color: "#94A3B8", padding: "2px 8px", background: "#F1F5F9", borderRadius: 4, fontWeight: 600 },
  btnGreen: { padding: "6px 12px", borderRadius: 7, background: "#F0FDF4", border: "1px solid #BBF7D0", color: "#15803D", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  btnBlue: { padding: "6px 12px", borderRadius: 7, background: "#EFF6FF", border: "1px solid #BFDBFE", color: "#1D4ED8", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  btnGray: { padding: "6px 12px", borderRadius: 7, background: "#F8FAFC", border: "1px solid #E2E8F0", color: "#64748B", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  th: { padding: "9px 6px", fontWeight: 700, fontSize: 10.5, cursor: "pointer", whiteSpace: "nowrap", borderBottom: "2px solid #E2E8F0", letterSpacing: 0.3, textAlign: "right" },
  td: { padding: "7px 6px", textAlign: "right", color: "#475569" },
};
