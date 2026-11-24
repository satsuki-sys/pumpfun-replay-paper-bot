// pumpfun-replay-paper-bot: a momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: most pump.fun curves die fast, but a few run hard in their first hours. The bot watches
// every curve's tape of recorded trades and buys only when several independent buyers are pushing
// SOL in, the price is rising and still accelerating, and the curve is old enough that the launch
// dump is behind it. It starts small, pyramids into strength, and exits on a stop loss, a
// trailing stop, fading flow, a whale sell, or a hold-time limit. A pacing probe keeps the run
// above the guardrails (at least 20 distinct mints with a round trip of at least 0.01 SOL each)
// when the momentum entries alone fall behind pace.
//
// The grader runs `node /bot/main.ts`; the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte under vendor/. The bot is deterministic: no clock, no environment, no randomness;
// iteration is over insertion-ordered maps fed by the batch stream. Every batch it answers with
// at most hello.caps.max_orders_per_batch orders, and every order is decided on that batch's
// slot and fills 2 slots later (the harness latency), so slippage on buys is capped at 2000 bps
// and sells go out wide open.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Curve fees on a round trip: ~95 bps protocol + ~30 bps creator = 1.25%.
const CURVE_FEE = 0.0125;

// ---- tuning ---------------------------------------------------------------

const P = {
  /** Entry lookback, in slots. */
  window: 48,
  /** Net SOL in over the window to enter. */
  minNetSol: 0.8,
  /** Buy trades in the window. */
  minBuys: 5,
  /** Distinct buying wallets in the window. */
  minBuyers: 4,
  /** Price rise over the window, lower and upper bound. */
  minUp: 0.06,
  maxUp: 1.5,
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: 1.0,
  /** Price now must be at least this share of the window high. */
  nearHigh: 0.92,
  /** Largest single buyer may fund at most this share of the window's buy SOL. */
  maxBuyerShare: 0.6,
  /** Real SOL reserve bounds at entry. */
  minRqSol: 1,
  maxRqSol: 100,
  /** Slots after the CreateEvent before an entry is allowed. */
  minAge: 300,
  /** Total SOL a position may hold at cost. */
  stakeSol: 1.2,
  /** First buy of a position, SOL. */
  firstSol: 0.05,
  /** Each pyramid add, SOL. */
  addSol: 0.2,
  /** A pyramid add needs the price at least this far above the last buy's price. */
  addStep: 0.02,
  /** A pyramid add needs the position up at least this much. */
  addIfUp: 0.0,
  /** Slippage allowed on buys, bps. */
  buySlipBps: 2000,
  /** Stop loss vs cost. */
  stopLoss: 0.2,
  /** Trailing stop from the position's best close value. */
  trail: 0.2,
  /** The trailing stop arms once the position is up this much. */
  trailArm: 0.1,
  /** Fade window, slots, and the net outflow over it that exits. */
  fadeWindow: 24,
  fadeNetSol: -0.5,
  /** One recorded sell of at least this many SOL exits. */
  bigSellSol: 3,
  /** Max slots held (unless up a lot). */
  maxHold: 1000,
  /** Holding past maxHold is fine while up at least this much. */
  holdIfUp: 0.25,
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: 200,
  /** Most entries per curve over the run. */
  maxEntries: 2,
  /** Most momentum positions open at once (the rest of the 5 slots is for probes). */
  maxMain: 4,
  /** Guardrail pacing: aim for this many coins / fills over paceSecs of block time. */
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 21_600,
  /** One probe round trip costs this much SOL. */
  probeSol: 0.02,
  /** Most probe positions open at once. */
  maxProbes: 1,
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: 6,
};

// ---- per-curve tape -------------------------------------------------------

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position, fees included. */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** The bot's own filled orders and the coins they were on (harness closes excluded). */
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

const tapeOf = (mint: Pubkey): Tape => {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
};

/** Entry signal on a curve's tape at slot `now`, with its real SOL reserve in SOL. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < P.minRqSol || rqSol > P.maxRqSol) return false;
  if (t.created === null || now - t.created < P.minAge) return false;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.minBuys || byUser.size < P.minBuyers) return false;
  if (buySol - sellSol < P.minNetSol) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < P.minUp || up > P.maxUp) return false;
  if (last < high * P.nearHigh) return false;
  if (netNew <= 0 || netNew < P.accel * netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > P.maxBuyerShare * buySol) return false;
  return true;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** What a full sell of `tokens` fetches now, in SOL, after curve and tx fees. */
function closeValue(tokens: number, vq: number, vt: number, txSol: number): number {
  return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
      }
    }
    // Prune tapes to the longest lookback we use, plus a margin.
    const keep = Math.max(P.window, P.fadeWindow) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;

    // --- Exits first: every held position is checked against its stop, trail,
    // --- fade, whale-sell and hold-time rules, and sold whole on the first hit.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
      const tokens = Number(pos.token_amount);
      const value = closeValue(tokens, vq, vt, txSol);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < P.fadeNetSol) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > P.maxHold && value < cost * (1 + P.holdIfUp)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // --- Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // --- Entries and pyramid adds, on the mints traded in this batch.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMain - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = Math.min(P.firstSol, P.stakeSol);
      } else {
        // Pyramid into strength only: price stepped up from the last buy, the
        // position is not underwater, and SOL is still flowing in.
        if (h.exiting || !h.filled || h.invested >= P.stakeSol - 0.01) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * (1 + P.addStep)) continue;
        if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * (1 + P.addIfUp)) continue;
        if (flow(t, now, P.window) < 0) continue;
        if (rqSol > P.maxRqSol) continue;
        want = Math.min(P.addSol, P.stakeSol - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, P.maxExposureSol - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < 0.01) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
      free -= amount + txSol;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // --- Guardrail pacing: when the bot's own fills or coins lag the pace set
    // --- in block time, open a tiny probe round trip on a liquid traded coin.
    if (probes.size < P.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        const minRq = (P.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= P.maxProbes) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < P.probeSol + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)), max_slippage_bps: P.buySlipBps });
          probes.set(mint, false);
          free -= P.probeSol + txSol;
        }
      }
    }
    return orders;
  },
});
