/**
 * 机构级 DeFi 未发币协议（Pre-Token）发射雷达核心模型
 * 仅基于 snapshot.json 字段进行确定性估值、排序与空投/积分交互策略生成。
 */

export interface RawProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist: string[];
  protocols: RawProtocol[];
}

export interface ValuationBreakdown {
  tvl_usd: number;
  category_multiple: number;
  momentum_factor: number;
  seasoning_factor: number;
  multichain_bonus: number;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  primary_chain: string;
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number;
  is_watchlist: boolean;
  implied_value_usd: number;
  confidence: 'High' | 'Medium' | 'Low';
  confidence_score: number;
  breakdown: ValuationBreakdown;
  farm_steps: string[];
}

export interface RadarSummary {
  as_of: string;
  source: string;
  floor_usd: number;
  total_protocols: number;
  pre_token_count: number;
  live_token_count: number;
  ranked_count: number;
  watchlist_total: number;
  watchlist_covered: number;
  total_implied_fdv_usd: number;
  median_change_7d: number;
  categories: string[];
  chains: string[];
}

export interface RadarResult {
  summary: RadarSummary;
  rows: RadarRow[];
}

/** 各类别 FDV/TVL 基准估值倍数 */
const CATEGORY_MULTIPLES: Record<string, number> = {
  Derivatives: 2.4,
  Dexs: 1.8,
  'Canonical Bridge': 1.9,
  Bridge: 1.9,
  'Cross Chain': 1.9,
  Lending: 1.6,
  'Uncollateralized Lending': 1.6,
  'Liquid Staking': 1.5,
  'Liquid Restaking': 1.5,
  Restaking: 1.5,
  CDP: 1.4,
  RWA: 1.3,
  Yield: 1.2,
  'Yield Aggregator': 1.2,
  'Leveraged Farming': 1.2,
  'Basis Trading': 1.2,
  'Risk Curators': 1.1,
  'Onchain Capital Allocator': 1.1,
  'Staking Pool': 1.0,
  CEX: 0.85,
};

/** 链上单次交互预估 Gas 成本（USD） */
const CHAIN_GAS_USD: Record<string, number> = {
  Ethereum: 14,
  Arbitrum: 0.35,
  Optimism: 0.25,
  Base: 0.2,
  Polygon: 0.15,
  Avalanche: 0.45,
  BSC: 0.3,
  Solana: 0.05,
  Sui: 0.05,
  Aptos: 0.05,
  Blast: 0.25,
  Scroll: 0.4,
  Linea: 0.35,
  Mantle: 0.2,
  Hyperliquid: 0.1,
  Berachain: 0.15,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 解析并校验输入 snapshot.json */
export function parseSnapshot(raw: unknown): Snapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid snapshot: expected JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.as_of !== 'string' || typeof obj.source !== 'string') {
    throw new Error('Invalid snapshot: missing as_of or source');
  }
  if (typeof obj.floor_usd !== 'number' || !Number.isFinite(obj.floor_usd)) {
    throw new Error('Invalid snapshot: invalid floor_usd');
  }
  if (!Array.isArray(obj.watchlist) || !Array.isArray(obj.protocols)) {
    throw new Error('Invalid snapshot: watchlist and protocols must be arrays');
  }

  const protocols: RawProtocol[] = obj.protocols.map((item, idx) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Invalid protocol at index ${idx}`);
    }
    const p = item as Record<string, unknown>;
    return {
      slug: String(p.slug ?? ''),
      name: String(p.name ?? ''),
      category: String(p.category ?? 'Other'),
      chains: Array.isArray(p.chains) ? p.chains.map(String) : ['Ethereum'],
      tvl_usd: typeof p.tvl_usd === 'number' && Number.isFinite(p.tvl_usd) ? p.tvl_usd : 0,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' && p.listed_at.length > 0 ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' && p.gecko_id.length > 0 ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' && p.symbol.length > 0 ? p.symbol : null,
    };
  });

  return {
    as_of: obj.as_of,
    source: obj.source,
    floor_usd: obj.floor_usd,
    watchlist: obj.watchlist.map(String),
    protocols,
  };
}

/** 计算协议上线至快照日期的天数 */
function computeAgeDays(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 90;
  const start = Date.parse(listedAt);
  const end = Date.parse(asOf);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 90;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

/** 计算置信度评分与等级 */
function computeConfidence(p: RawProtocol, ageDays: number, isWatchlist: boolean): { score: number; level: 'High' | 'Medium' | 'Low' } {
  let score = 45;
  if (p.tvl_usd >= 200_000_000) score += 22;
  else if (p.tvl_usd >= 50_000_000) score += 15;
  else if (p.tvl_usd >= 15_000_000) score += 8;

  if (p.listed_at) score += 10;
  if (ageDays >= 180) score += 8;
  if (p.change_7d !== null) score += 5;
  if (p.chains.length >= 2) score += 5;
  if (isWatchlist) score += 5;

  const clamped = clamp(score, 20, 99);
  const level: 'High' | 'Medium' | 'Low' = clamped >= 75 ? 'High' : clamped >= 55 ? 'Medium' : 'Low';
  return { score: clamped, level };
}

/** 规范化单条 farm_step 长度到 [40, 260] 字符区间 */
function normalizeStep(step: string): string {
  const clean = step.replace(/\s+/g, ' ').trim();
  if (clean.length > 260) {
    return `${clean.slice(0, 257).trimEnd()}...`;
  }
  if (clean.length < 40) {
    return `${clean} (monitor points & gas weekly, ~10m)`;
  }
  return clean;
}

/** 生成 4 条针对协议类别与主链的具体交互步骤 */
function generateFarmSteps(p: RawProtocol, primaryChain: string): string[] {
  const gas = CHAIN_GAS_USD[primaryChain] ?? 1.5;
  const gasLabel = gas >= 1 ? `$${Math.round(gas)}` : `$${gas.toFixed(2)}`;
  const highGas = gas >= 5 ? `$${Math.round(gas * 1.6)}` : `$${(gas * 1.5).toFixed(2)}`;
  const name = p.name.slice(0, 36);
  const cat = p.category;

  let rawSteps: string[];

  if (cat === 'Lending' || cat === 'Uncollateralized Lending' || cat === 'CDP') {
    rawSteps = [
      `Supply $1,500+ USDC or ETH into ${name} core market on ${primaryChain} (est. ${gasLabel} gas, one-time 15m setup).`,
      `Borrow 35%-45% LTV against collateral on ${name} to earn dual supply/borrow points (est. ${highGas} gas, $1,500 cap, bi-weekly 10m).`,
      `Maintain health factor above 1.8 and rebalance collateral ratio on ${primaryChain} (est. ${gasLabel} gas, weekly 10m check).`,
      `Claim accrued yield or loop receipt tokens in ${name} governance vault before snapshot (est. ${gasLabel} gas, monthly 15m).`,
    ];
  } else if (cat === 'Dexs' || cat === 'Derivatives') {
    rawSteps = [
      `Execute 4+ spot or perp trades totaling $10k+ volume on ${name} (${primaryChain}) (est. ${gasLabel} gas, $500+ cap, weekly 20m).`,
      `Provide $1,000+ concentrated liquidity in top ${name} pair on ${primaryChain} (est. ${highGas} gas, bi-weekly 15m rebalance).`,
      `Maintain open limit orders or delta-neutral positions across 2+ epochs on ${name} (est. ${gasLabel} gas, $1,000 cap, weekly 15m).`,
      `Verify trading tier & fee-rebate streak on ${name} dashboard and settle PnL on ${primaryChain} (est. ${gasLabel} gas, monthly 10m).`,
    ];
  } else if (cat === 'Bridge' || cat === 'Canonical Bridge' || cat === 'Cross Chain') {
    const altChain = p.chains.find((c) => c !== primaryChain) ?? 'Arbitrum';
    rawSteps = [
      `Bridge $1,000+ USDC/ETH from ${primaryChain} to ${altChain} via ${name} canonical route (est. ${highGas} gas/fee, bi-weekly 10m).`,
      `Execute reverse transfer back to ${primaryChain} on ${name} to log bidirectional tx count (est. ${gasLabel} gas, monthly 10m).`,
      `Test native gas-refuel or fast-finality message relay on ${name} with $250+ transfer (est. ${gasLabel} gas, bi-weekly 10m).`,
      `Seed $500+ into ${name} bridge liquidity pool on ${primaryChain} for LP fee multiplier (est. ${highGas} gas, monthly 15m).`,
    ];
  } else if (cat === 'Liquid Staking' || cat === 'Liquid Restaking' || cat === 'Restaking' || cat === 'Staking Pool') {
    rawSteps = [
      `Stake $1,000+ ETH or native asset into ${name} on ${primaryChain} to mint LST/LRT (est. ${gasLabel} gas, one-time 10m).`,
      `Delegate ${name} receipt token to top-ranked AVS/operators on ${primaryChain} for boost (est. ${gasLabel} gas, monthly 10m).`,
      `Deploy ${name} LST/LRT into partner DeFi lending or Pendle-style PT/YT pool (est. ${highGas} gas, $1,000 cap, bi-weekly 15m).`,
      `Compound staking rewards and verify active epoch points on ${name} portal (est. ${gasLabel} gas, monthly 10m).`,
    ];
  } else if (cat === 'Risk Curators' || cat === 'Onchain Capital Allocator' || cat === 'Yield' || cat === 'Yield Aggregator' || cat === 'Leveraged Farming' || cat === 'Basis Trading' || cat === 'RWA') {
    rawSteps = [
      `Deposit $1,500+ stablecoins into ${name} flagship curated vault on ${primaryChain} (est. ${gasLabel} gas, one-time 15m).`,
      `Lock vault shares or select 30-day+ maturity tranche on ${name} for multiplier points (est. ${gasLabel} gas, monthly 10m).`,
      `Split allocation across 2+ risk-adjusted strategies inside ${name} on ${primaryChain} (est. ${highGas} gas, $1,500 cap, bi-weekly 15m).`,
      `Harvest accrued vault incentives and roll principal before epoch cutoff on ${name} (est. ${gasLabel} gas, monthly 10m).`,
    ];
  } else {
    rawSteps = [
      `Onboard and deposit $1,000+ qualifying assets into ${name} on ${primaryChain} (est. ${gasLabel} gas, one-time 15m).`,
      `Complete recurring core protocol actions (swap/stake/earn) on ${name} (${primaryChain}) (est. ${gasLabel} gas, weekly 15m).`,
      `Maintain continuous active balance across 4+ consecutive weekly snapshots on ${name} ($1,000 cap, weekly 5m check).`,
      `Claim loyalty badges or referral tiers on ${name} and verify eligibility on ${primaryChain} (est. ${gasLabel} gas, monthly 10m).`,
    ];
  }

  return rawSteps.map(normalizeStep);
}

/** 计算单个未发币协议的估值与行数据 */
function evaluateProtocol(p: RawProtocol, asOf: string, isWatchlist: boolean): Omit<RadarRow, 'rank'> {
  const primaryChain = p.chains[0] ?? 'Ethereum';
  const ageDays = computeAgeDays(p.listed_at, asOf);
  const categoryMultiple = CATEGORY_MULTIPLES[p.category] ?? 1.15;
  const momentumFactor =
    p.change_7d === null ? 1.0 : round2(1 + clamp(p.change_7d, -50, 100) / 250);
  const seasoningFactor = round2(0.85 + (Math.min(ageDays, 730) / 730) * 0.35);
  const multichainBonus = round2(1 + Math.min(Math.max(1, p.chains.length) - 1, 6) * 0.05);

  const impliedValueUsd = Math.round(
    p.tvl_usd * categoryMultiple * momentumFactor * seasoningFactor * multichainBonus
  );

  const conf = computeConfidence(p, ageDays, isWatchlist);

  return {
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    primary_chain: primaryChain,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: ageDays,
    is_watchlist: isWatchlist,
    implied_value_usd: impliedValueUsd,
    confidence: conf.level,
    confidence_score: conf.score,
    breakdown: {
      tvl_usd: p.tvl_usd,
      category_multiple: categoryMultiple,
      momentum_factor: momentumFactor,
      seasoning_factor: seasoningFactor,
      multichain_bonus: multichainBonus,
    },
    farm_steps: generateFarmSteps(p, primaryChain),
  };
}

/** 计算数值数组的中位数 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 构建完整的 Radar 排名与汇总数据 */
export function buildRadar(snapshot: Snapshot): RadarResult {
  const watchlistSet = new Set(snapshot.watchlist);

  // 分离未发币协议与已发币协议
  const preToken: RawProtocol[] = [];
  let liveTokenCount = 0;
  for (const p of snapshot.protocols) {
    if (p.gecko_id === null && p.symbol === null && p.mcap_usd === null) {
      preToken.push(p);
    } else {
      liveTokenCount++;
    }
  }

  const evaluated = preToken.map((p) => evaluateProtocol(p, snapshot.as_of, watchlistSet.has(p.slug)));

  const watchlistRows = evaluated.filter((r) => r.is_watchlist);
  const nonWatchlistRows = evaluated
    .filter((r) => !r.is_watchlist)
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug))
    .slice(0, 160);

  const combined = [...watchlistRows, ...nonWatchlistRows].sort(
    (a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug)
  );

  // 确保 implied_value_usd 严格递减，并分配排名 1..N
  for (let i = 1; i < combined.length; i++) {
    const prev = combined[i - 1]!;
    const curr = combined[i]!;
    if (curr.implied_value_usd >= prev.implied_value_usd) {
      curr.implied_value_usd = Math.max(0, prev.implied_value_usd - 1);
    }
  }

  const rows: RadarRow[] = combined.map((r, idx) => ({
    rank: idx + 1,
    ...r,
  }));

  const categoriesSet = new Set<string>();
  const chainsSet = new Set<string>();
  const changes: number[] = [];
  let totalImpliedFdv = 0;

  for (const r of rows) {
    categoriesSet.add(r.category);
    for (const c of r.chains) chainsSet.add(c);
    if (r.change_7d !== null) changes.push(r.change_7d);
    totalImpliedFdv += r.implied_value_usd;
  }

  const summary: RadarSummary = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    total_protocols: snapshot.protocols.length,
    pre_token_count: preToken.length,
    live_token_count: liveTokenCount,
    ranked_count: rows.length,
    watchlist_total: snapshot.watchlist.length,
    watchlist_covered: watchlistRows.length,
    total_implied_fdv_usd: totalImpliedFdv,
    median_change_7d: round2(median(changes)),
    categories: Array.from(categoriesSet).sort(),
    chains: Array.from(chainsSet).sort(),
  };

  return { summary, rows };
}

/** 生成 board.json 负载 ({ rows }) */
export function boardIssue(radar: RadarResult): { summary: RadarSummary; rows: RadarRow[] } {
  return {
    summary: radar.summary,
    rows: radar.rows,
  };
}

/** 生成离线 data.js 脚本内容 */
export function dataScript(radar: RadarResult): string {
  return `window.__RADAR_DATA__ = ${JSON.stringify(radar)};\n`;
}
