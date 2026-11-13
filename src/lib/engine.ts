// Foreman — the contractor engine. Pure, deterministic logic:
// planning, quoting, one-round negotiation, work checks, escrow math.
// Deterministic on purpose: the same task + budget always plans the same way,
// so judges can re-run a demo and get the same result.

import { AGENTS } from "@/data/seed";
import type {
  Agent,
  BusinessConfig,
  Job,
  Receipt,
  Subtask,
} from "@/lib/types";

/** Deterministic pseudo-random 0..1 from a string (FNV-1a hash). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtNEAR(n: number): string {
  return `${round2(n).toFixed(2)} NEAR`;
}

export const KIND_AGENT: Record<string, string> = {
  research: "scout",
  code: "forge",
  design: "pixel",
  write: "scribe",
  data: "ledger",
  marketing: "herald",
  audit: "sentinel",
  feed: "oracle",
};

const KIND_KEYWORDS: { kind: string; title: string; words: string[] }[] = [
  { kind: "research", title: "Market & competitor research", words: ["research", "market", "competitor", "survey", "users complain", "pricing"] },
  { kind: "code", title: "Build the feature", words: ["code", "contract", "app", "api", "website", "landing", "build", "develop", "feature", "swap"] },
  { kind: "design", title: "Design & branding", words: ["design", "brand", "logo", "ui", "ux", "mockup"] },
  { kind: "write", title: "Copy & content", words: ["write", "content", "copy", "blog", "docs", "copywriting"] },
  { kind: "data", title: "Data analysis", words: ["data", "analysis", "dashboard", "metrics", "analytics"] },
  { kind: "marketing", title: "Launch marketing", words: ["marketing", "social", "growth", "launch", "ads", "campaign", "post"] },
  { kind: "audit", title: "Security review", words: ["audit", "security", "review", "test", "pen-test"] },
  { kind: "feed", title: "Integration & data feeds", words: ["feed", "integration", "oracle", "webhook", "connector"] },
];

export function detectKinds(title: string, brief: string): { kind: string; title: string }[] {
  const text = `${title} ${brief}`.toLowerCase();
  const found: { kind: string; title: string }[] = [];
  for (const k of KIND_KEYWORDS) {
    if (k.words.some((w) => text.includes(w))) found.push({ kind: k.kind, title: k.title });
  }
  if (found.length === 0) found.push({ kind: "research", title: "Task research & plan" });
  return found.slice(0, 4);
}

export function agentForKind(kind: string): Agent {
  const id = KIND_AGENT[kind] ?? "scout";
  return AGENTS.find((a) => a.id === id) ?? AGENTS[0];
}

/** Break a task into subtasks that fit the budget. Never plans over budget. */
export function planTask(
  title: string,
  brief: string,
  budgetNEAR: number,
  config: BusinessConfig,
): { subtasks: Subtask[]; notes: string[] } {
  const notes: string[] = [];
  const kinds = detectKinds(title, brief);
  const cap = Math.min(budgetNEAR, config.maxSpendPerJobNEAR);
  if (budgetNEAR > config.maxSpendPerJobNEAR) {
    notes.push(
      `Budget ${fmtNEAR(budgetNEAR)} melebihi batas per-job ${fmtNEAR(config.maxSpendPerJobNEAR)} — Foreman merencanakan maksimal ${fmtNEAR(cap)}.`,
    );
  }
  let subtasks: Subtask[] = kinds.map((k, i) => {
    const agent = agentForKind(k.kind);
    return {
      id: uid("st"),
      title: k.title,
      kind: k.kind,
      agentId: agent.id,
      plannedNEAR: round2(Math.max(config.minPriceNEAR, agent.rateNEAR)),
      quoteNEAR: null,
      finalNEAR: null,
      status: "planned" as const,
      progress: 0,
      deliverable: null,
      checkScore: null,
      checkNote: null,
      attempts: 0,
    };
  });
  // Budget guard: drop the lowest-priority subtask until the plan fits.
  let total = subtasks.reduce((s, t) => s + t.plannedNEAR, 0);
  while (subtasks.length > 1 && total > cap) {
    const dropped = subtasks.pop()!;
    total -= dropped.plannedNEAR;
    notes.push(`Subtask "${dropped.title}" dicoret agar rencana muat di budget (${fmtNEAR(cap)}).`);
  }
  if (subtasks.length === 1 && total > cap) {
    subtasks[0].plannedNEAR = round2(cap);
    notes.push(`Harga "${subtasks[0].title}" ditekan ke ${fmtNEAR(cap)} agar muat di budget.`);
  }
  if (subtasks.length === 0) {
    notes.push("Tidak ada subtask yang bisa direncanakan dalam budget ini.");
  } else {
    notes.push(
      `Rencana: ${subtasks.length} subtask, total rencana ${fmtNEAR(total)} dari budget ${fmtNEAR(budgetNEAR)} — sisa ${fmtNEAR(budgetNEAR - total)} sebagai cadangan.`,
    );
  }
  return { subtasks, notes };
}

/** The agent quotes a price: planned ±15%, deterministic per agent+task. */
export function quoteFor(agent: Agent, plannedNEAR: number, salt: string): number {
  const jitter = (hash01(`${agent.id}:${salt}`) - 0.5) * 0.3;
  return round2(Math.max(0.5, plannedNEAR * (1 + jitter)));
}

/**
 * One-round negotiation (agents-track requirement):
 * quote within +10% of plan -> accept as-is. Otherwise Foreman counters once
 * at the planned price with reasoning. Flexible agents accept a counter at
 * >=80% of their quote; firm agents need >=90%. Otherwise they walk away.
 */
export function negotiate(
  agent: Agent,
  plannedNEAR: number,
  quoteNEAR: number,
): { outcome: "accepted" | "walked-away"; finalNEAR: number | null; note: string } {
  if (quoteNEAR <= plannedNEAR * 1.1) {
    return {
      outcome: "accepted",
      finalNEAR: quoteNEAR,
      note: `Quote ${fmtNEAR(quoteNEAR)} masih dalam +10% dari rencana — diterima tanpa negosiasi.`,
    };
  }
  const threshold = agent.flexible ? 0.8 : 0.9;
  if (plannedNEAR >= quoteNEAR * threshold) {
    return {
      outcome: "accepted",
      finalNEAR: plannedNEAR,
      note: `Quote ${fmtNEAR(quoteNEAR)} di atas rencana. Foreman menawar sekali di ${fmtNEAR(plannedNEAR)} ("budget klien segitu, scope tetap") — ${agent.name} menerima.`,
    };
  }
  return {
    outcome: "walked-away",
    finalNEAR: null,
    note: `Quote ${fmtNEAR(quoteNEAR)} terlalu jauh di atas rencana ${fmtNEAR(plannedNEAR)}. Foreman menawar sekali — ${agent.name} menolak dan mundur. Foreman akan cari agen lain atau coret subtask ini.`,
  };
}

/** Foreman checks a delivery: score from agent rating + deterministic check. Pass >= 80. */
export function checkWork(
  agent: Agent,
  subtask: Subtask,
): { pass: boolean; score: number; note: string } {
  const score = Math.min(100, Math.round(agent.rating * 18 + hash01(`${subtask.id}:${subtask.attempts}`) * 10));
  const pass = score >= 80;
  return {
    pass,
    score,
    note: pass
      ? `Lolos cek: kelengkapan, kualitas, dan kesesuaian brief terpenuhi (skor ${score}/100). Pembayaran dilepas dari escrow.`
      : `Gagal cek (skor ${score}/100): ada bagian yang tidak sesuai brief. Foreman minta revisi sekali sebelum bayar.`,
  };
}

export function deliverableText(agent: Agent, subtask: Subtask): string {
  const map: Record<string, string> = {
    research: `Laporan riset 6 halaman: 5 kompetitor, kisaran harga, 12 keluhan pengguna teratas + rekomendasi positioning.`,
    code: `Build selesai: fitur jalan di preview, 14 test lolos, README update, dan demo link terlampir.`,
    design: `Paket desain: 3 varian hero, logo + brand kit, dan mockup desktop/mobile (Figma link).`,
    write: `Naskah final: 1.200 kata, tone sesuai brief, headline + CTA, sudah proofread.`,
    data: `Dashboard + dataset: 3 chart utama, kesimpulan, dan file CSV mentah terlampir.`,
    marketing: `Paket launch: 5 post X, 1 thread, dan kalender posting 7 hari.`,
    audit: `Laporan audit: 2 temuan medium + 5 low, rekomendasi perbaikan, dan checklist re-test.`,
    feed: `Integrasi jalan: feed live, webhook terpasang, dan dokumentasi endpoint.`,
  };
  return `${agent.name} menyerahkan: ${map[subtask.kind] ?? "Hasil kerja sesuai brief."}`;
}

/** Revenue split on every payout (business-track requirement). */
export function splitPayment(
  amountNEAR: number,
  config: BusinessConfig,
): { agent: number; treasury: number } {
  const agent = round2((amountNEAR * config.agentSharePct) / 100);
  return { agent, treasury: round2(amountNEAR - agent) };
}

export function newReceipt(
  jobId: string,
  kind: string,
  from: string,
  to: string,
  amountNEAR: number,
  note: string,
  status: Receipt["status"],
  subtaskId?: string,
): Receipt {
  return {
    id: uid("rc"),
    at: new Date().toISOString(),
    kind,
    jobId,
    subtaskId,
    from,
    to,
    amountNEAR: round2(amountNEAR),
    note,
    status,
  };
}

export function newJob(
  title: string,
  brief: string,
  budgetNEAR: number,
  subtasks: Subtask[],
  notes: string[],
): Job {
  const locked = round2(subtasks.reduce((s, t) => s + t.plannedNEAR, 0));
  return {
    id: uid("job"),
    title,
    brief,
    budgetNEAR,
    status: "active",
    escrowLocked: locked,
    escrowReleased: 0,
    escrowRefunded: 0,
    subtasks,
    receipts: [],
    createdAt: new Date().toISOString(),
    log: notes,
  };
}
