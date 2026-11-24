# pumpfun-replay-paper-bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satsuki-sys/pumpfun-replay-paper-bot/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/satsuki-sys/pumpfun-replay-paper-bot/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the make.fun competition
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity
(harness `agent-fun/replay/v2`, Node 22, `main.ts` at the repo root).

## Strategy

Most pump.fun curves die fast; a few run hard in their first hours. The bot watches every
curve's tape of recorded trades and buys only when several independent buyers are pushing SOL
in, the price is rising and still accelerating, and the curve is old enough that the launch
dump is behind it. It starts small (0.05 SOL), pyramids into strength up to 1.2 SOL per coin,
and exits whole on the first of: a 20% stop loss against cost, a 20% trailing stop once the
position is up 10%, fading flow, a whale sell, or a 1000-slot hold limit. A pacing probe keeps
the run above the guardrails (at least 20 distinct mints, each with a round trip of at least
0.01 SOL) when momentum entries alone fall behind pace.

Caps respected: at most 5 open positions, each buy at most 100 bps of the curve's real SOL
reserve, at most 16 orders per batch, no shorts, no leverage. Orders decided on a batch's
slot fill 2 slots later. The bot is deterministic: no clock, no environment, no randomness.

## Files

- `main.ts` — the strategy; run by the grader as `node /bot/main.ts`.
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts` shim, vendored byte for byte.
- `LICENSE` — MIT.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --stress
```
