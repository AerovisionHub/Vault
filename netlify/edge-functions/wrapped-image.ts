// Generates the per-bank PNG used as the og:image for /wrapped/{cert}.
//
// Why this exists: wrapped-meta.js already rewrites og:title/description/url
// per bank (confirmed working), but og:image still pointed at the generic
// Vault logo, so every shared Wrapped link looked identical. This function
// renders a real 1200x630 PNG per bank at a stable URL, which
// wrapped-meta.js then points og:image/twitter:image at.
//
// Deliberately NO JSX. Netlify's Deno edge bundler's JSX pragma/importSource
// config isn't something we can verify from the build sandbox, and getting it
// wrong fails the whole edge function. React.createElement is transform-free
// and behaves identically. Same defensive reasoning as wrapped-meta.js's
// choice of string replacement over HTMLRewriter.
//
// Everything numeric here is a verbatim port of already-tested client-side
// logic in index.html — computeLendingScore(), computeMetricPercentile(),
// and the "only say Top X% when it's actually top half" framing rule. Do not
// re-derive these; keep them in sync with index.html and functions/mcp.js.
import React from "https://esm.sh/react@18.2.0";
import { ImageResponse } from "https://deno.land/x/og_edge/mod.ts";

const h = (type: string, props: Record<string, unknown>, ...children: unknown[]) =>
  React.createElement(type, props, ...children);

const FDIC_BASE = "https://banks.data.fdic.gov/api";
const BG = "linear-gradient(135deg, #1a1060, #2d1080)";
const CYAN = "#4db8ff";
const AMBER = "#fbbf24";

// Verbatim port of computeLendingScore() in index.html.
function computeLendingScore(fin: Record<string, unknown>) {
  const loanRatio = (Number(fin.LNLSNET) || 0) / (Number(fin.ASSET) || 1) * 100;
  const cap = Number(fin.RBC1AAJ) || 0;
  const delinq = Number(fin.NCLNLSR) || 0;
  const roa = Number(fin.ROA) || 0;
  return (
    Math.min(loanRatio, 100) * 0.35 +
    Math.min(cap, 25) * 4 * 0.20 +
    (100 - Math.min(delinq * 10, 100)) * 0.25 +
    Math.min(Math.max(roa * 50, 0), 100) * 0.20
  );
}

// Verbatim port of computeMetricPercentile() in index.html.
function computeMetricPercentile(
  peers: Array<Record<string, unknown>>,
  cert: string,
  ownValue: number,
  fieldName: string,
  higherIsBetter: boolean,
) {
  if (ownValue == null || isNaN(ownValue)) return null;
  const peerValues = peers
    .filter((p) => String(p.cert) !== String(cert))
    .map((p) => Number(p[fieldName]))
    .filter((v) => !isNaN(v));
  const all = [...peerValues, ownValue];
  const sorted = [...all].sort((a, b) => (higherIsBetter ? b - a : a - b));
  const idx = sorted.indexOf(ownValue);
  const total = sorted.length;
  if (idx < 0 || total === 0) return null;
  return { percentile: Math.round((1 - idx / total) * 100), rank: idx + 1, total };
}

async function fetchJSON(url: string, ms: number) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Same peer set the client-side card uses — get_lender_rankings via the MCP
// endpoint, rather than re-implementing the institutions+financials join that
// has a real bug history (see the skill's hard-won bugs list).
async function fetchPeers(origin: string, stateCode: string) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  try {
    const resp = await fetch(`${origin}/.netlify/functions/mcp`, {
      method: "POST",
      // Tagged so this render doesn't inflate real MCP usage numbers — every
      // Wrapped share would otherwise look like a third-party tool call.
      headers: { "Content-Type": "application/json", "X-Vault-Source": "og-image" },
      signal: c.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_lender_rankings", arguments: { state: stateCode, asset_size: "all", limit: 100 } },
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data?.result?.content?.[0]?.text;
    if (!text) return null;
    return JSON.parse(text).rankings || [];
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const fmtPct = (v: number | null, digits: number) => (v == null || isNaN(v) ? "—" : v.toFixed(digits) + "%");

function statBox(value: string, label: string) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: "300px",
        backgroundColor: "rgba(255,255,255,0.06)",
        borderRadius: "16px",
        padding: "14px 10px",
        marginLeft: "10px",
        marginRight: "10px",
      },
    },
    h("div", { style: { fontSize: 36, color: "#ffffff", fontWeight: 700 } }, value),
    h(
      "div",
      { style: { fontSize: 18, color: "rgba(255,255,255,0.55)", marginTop: "6px", letterSpacing: "1px" } },
      label,
    ),
  );
}

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const cert = (url.pathname.split("/").pop() || "").replace(/\.png$/i, "").replace(/\D/g, "");

  let name = "Vault Wrapped";
  let sub = "vaultbot.ai · Free FDIC data";
  let score: number | null = null;
  let badge: string | null = null;
  let capitalRatio: number | null = null;
  let roa: number | null = null;
  let delinq: number | null = null;

  if (cert) {
    const [instJson, finJson] = await Promise.all([
      fetchJSON(`${FDIC_BASE}/institutions?filters=CERT%3A${cert}&fields=NAME,CITY,STALP,ASSET&limit=1`, 5000),
      fetchJSON(
        `${FDIC_BASE}/financials?filters=CERT%3A${cert}&fields=REPDTE,ASSET,RBC1AAJ,ROA,NCLNLSR,LNLSNET&limit=1&sort_by=REPDTE&sort_order=DESC`,
        5000,
      ),
    ]);
    const inst = instJson?.data?.[0]?.data;
    const fin = finJson?.data?.[0]?.data;

    if (inst?.NAME) {
      name = inst.NAME;
      sub = `${inst.CITY}, ${inst.STALP} · CERT ${cert}`;
    }
    if (fin) {
      capitalRatio = fin.RBC1AAJ != null ? Number(fin.RBC1AAJ) : null;
      roa = fin.ROA != null ? Number(fin.ROA) : null;
      delinq = fin.NCLNLSR != null ? Number(fin.NCLNLSR) : null;
      // Uses the INSTITUTION's ASSET, not the financials row's — matches
      // loadWrapped() in index.html exactly, so the image can't disagree
      // with the page it previews.
      score = Number(computeLendingScore({ ...fin, ASSET: inst?.ASSET ?? fin.ASSET }).toFixed(1));

      if (inst?.STALP) {
        const peers = await fetchPeers(url.origin, inst.STALP);
        if (peers && peers.length) {
          const r = computeMetricPercentile(peers, cert, score, "lending_score", true);
          if (r) {
            // Framing rule, same as index.html: "Top X%" only when actually
            // in the top half; otherwise a plain, factual rank.
            const topPct = 100 - r.percentile;
            badge = topPct <= 50 ? `Top ${topPct}% in ${inst.STALP}` : `#${r.rank} of ${r.total} in ${inst.STALP}`;
          }
        }
      }
    }
  }

  // Long bank names need to shrink or they blow the card's height budget.
  const nameSize = name.length > 55 ? 38 : name.length > 42 ? 46 : name.length > 30 ? 54 : 64;

  const children: unknown[] = [
    h(
      "div",
      { style: { fontSize: 20, color: CYAN, letterSpacing: "3px", marginBottom: "10px" } },
      "// VAULT WRAPPED",
    ),
    h(
      "div",
      { style: { fontSize: nameSize, color: "#ffffff", fontWeight: 700, textAlign: "center", lineHeight: 1.15 } },
      name,
    ),
    h("div", { style: { fontSize: 22, color: "rgba(255,255,255,0.55)", marginTop: "10px" } }, sub),
  ];

  if (score != null) {
    children.push(
      h("div", { style: { fontSize: 104, color: CYAN, fontWeight: 700, lineHeight: 1, marginTop: "14px" } }, String(score)),
      h(
        "div",
        { style: { fontSize: 20, color: "rgba(255,255,255,0.6)", letterSpacing: "2px", marginTop: "4px" } },
        "LENDING SCORE",
      ),
    );
    if (badge) {
      children.push(
        h(
          "div",
          {
            style: {
              display: "flex",
              marginTop: "12px",
              padding: "10px 26px",
              backgroundColor: "rgba(251,191,36,0.15)",
              border: `2px solid rgba(251,191,36,0.4)`,
              borderRadius: "30px",
              fontSize: 26,
              fontWeight: 700,
              color: AMBER,
            },
          },
          badge,
        ),
      );
    }
    children.push(
      h(
        "div",
        { style: { display: "flex", flexDirection: "row", marginTop: "24px" } },
        statBox(fmtPct(capitalRatio, 1), "CAPITAL RATIO"),
        statBox(fmtPct(roa, 2), "ROA"),
        statBox(fmtPct(delinq, 2), "NONCURRENT LOANS"),
      ),
    );
  } else {
    children.push(
      h(
        "div",
        { style: { fontSize: 30, color: "rgba(255,255,255,0.7)", marginTop: "40px", textAlign: "center" } },
        "Bank & credit union intelligence, free from public FDIC data",
      ),
    );
  }

  const footer = h(
    "div",
    { style: { display: "flex", flexDirection: "row", alignItems: "center", fontSize: 22 } },
    h("span", { style: { color: "#ffffff", fontWeight: 700 } }, "Vault"),
    h("span", { style: { color: CYAN, fontWeight: 700 } }, "."),
    h("span", { style: { color: "rgba(255,255,255,0.45)" } }, "  \u00b7  vaultbot.ai  \u00b7  Free FDIC data"),
  );

  // If satori/og_edge fails for any reason (font fetch, an unsupported style,
  // a runtime change), fall back to the generic static OG image rather than
  // returning a 500 — a crawler that gets an error shows NO preview image at
  // all, which is strictly worse than today's generic one.
  try {
  return new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "#1a1060",
          backgroundImage: BG,
          padding: "40px 60px",
          fontFamily: "sans-serif",
        },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", width: "100%" } },
        ...children,
      ),
      footer,
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // LinkedIn/X cache their own crawl anyway; this keeps repeat crawls
        // and any human hitting the URL directly off the render path.
        "cache-control": "public, max-age=3600",
        "netlify-cdn-cache-control": "public, max-age=86400, durable",
      },
    },
  );
  } catch (_e) {
    return Response.redirect("https://vaultbot.ai/og-image.png?v=4", 302);
  }
}

export const config = { path: "/wrapped-image/*" };
