# Foreman — the general contractor agent for the NEAR agent economy

**Built for [NEAR HACKATHON: Build Beyond Boundaries](https://nearhackathon.com) (1–14 Nov 2026).**
Tracks: **Agent Economy** + **Autonomous Business**.

Give Foreman a task and a budget. It breaks the work into parts, hires specialist
agents, negotiates quotes, checks the work, and pays out — everything inside your
budget, settled on NEAR.

- **Live demo:** https://hendrik123906.github.io/foreman-near/
- **Demo video:** https://www.youtube.com/watch?v=TODO (upload pending — see below)
- **License:** MIT

## Try it — do X, see Y

| Do this | You will see |
|---|---|
| Open the demo, click **“Jalankan demo loop”** | A full hire → negotiate → check → pay loop for a landing-page + research task (budget 50 NEAR), finishing in under 2 minutes, with a running log |
| Open **My Jobs** → click the finished job | Each subtask with its quote, agreed price, check score, and receipt |
| Open **Marketplace** → click **Hire** on any agent | A new job with that agent, ready for a quote |
| Open **My Jobs** → on a subtask click **Minta quote → Negosiasi → Mulai kerja → Majukan kerja → Cek hasil kerja → Bayar dari escrow** | The whole contractor lifecycle, one step at a time |
| Open **Business Console** → turn on the **kill switch** | New jobs and payments are blocked until you turn it off |
| Open **Business Console** → move the revenue-split slider | The agent/treasury split changes for the next payout |
| Open **Ledger** → click **Export JSON** | Every receipt as a downloadable JSON file |
| Open **NEAR Live** → click **Cek saldo** (default: `test.near`) | A real NEAR testnet account balance, fetched live from `rpc.testnet.near.org` |
| Open **NEAR Live** → click **Minta quote** | A real dry quote from NEAR Intents 1Click: 1 USDC (Ethereum) → wNEAR |

## How it works

1. **Plan.** Foreman reads keywords in your title + brief (research, build, design,
   writing, data, marketing, audit, integration) and splits the task into subtasks.
   The plan never exceeds your budget — subtasks are dropped, lowest priority
   first, until it fits.
2. **Quote.** Each agent quotes a price (planned ±15%, deterministic per agent +
   task so a demo is reproducible).
3. **Negotiate — once.** A quote within +10% of the plan is accepted as-is.
   Otherwise Foreman counters once at the planned price. Flexible agents accept
   a counter at ≥80% of their quote; firm agents need ≥90%. Otherwise the agent
   walks away and Foreman finds a replacement.
4. **Escrow.** Funds are locked when the job is created. Agents are paid only
   after their work passes the check.
5. **Check.** Foreman scores each delivery (pass ≥ 80/100, from the agent's
   rating + a deterministic quality check). Fail twice → automatic refund.
6. **Pay + split.** On a pass, the payout is split by the Business Console rules
   (default 90% agent / 10% treasury) and a receipt is written to the public
   Ledger. Unspent escrow is refunded when the job finishes.

The Business Console is the "autonomous business" half: max spend per day and
per job, minimum price, auto-approve threshold, revenue split, and a kill switch.
A human sets the constraints; Foreman runs the loop inside them.

## What is real vs simulated — stated honestly

- **Real, live:** NEAR testnet account lookup (public RPC, read-only) and the
  NEAR Intents 1Click dry quote (`dry=true`: computed only, no deposit, no
  execution). Both run in the browser against public endpoints, no keys.
- **Simulated in the browser (labelled in the UI):** escrow, agent payments,
  treasury split, and refunds. They are real working logic with a full state
  machine, but they do not move tokens on-chain yet. The next step is an
  on-chain escrow contract on NEAR testnet — not claimed here.

The demo asks for no wallet, stores no seed, and signs no transaction.

## Tech

- Next.js 16 (App Router) + React 19 + Tailwind CSS v4, static export
  (`output: 'export'`) — hosted on GitHub Pages, no server.
- State lives in `localStorage` (`foreman-state-v1`); "Reset demo" restores the
  seed data (one finished job + receipts).
- No backend, no database, no paid services.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # static export to ./out
```

To serve the export: `npx serve out` (or any static server).

## Project structure

```
src/app/page.tsx        # the whole app UI (tabs: Foreman / Marketplace / My Jobs /
                        #   Business Console / Ledger / NEAR Live)
src/app/layout.tsx      # metadata
src/lib/engine.ts       # planning, quoting, negotiation, checks, escrow math
src/lib/near.ts         # live NEAR testnet lookup + Intents 1Click dry quote
src/lib/store.ts        # localStorage persistence + seed data
src/lib/types.ts        # domain types
src/data/seed.ts        # 8 specialist agents + demo task + default config
```

## Credits

Built by Bambang Hendri (solo) for the NEAR Hackathon. Demo video recorded with
Playwright + ffmpeg. NEAR Intents 1Click docs: https://docs.near-intents.org.
