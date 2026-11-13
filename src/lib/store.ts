// Foreman — local persistence. State lives in the browser (localStorage);
// nothing leaves the user's machine. Seeded on first load with one finished
// job so the Ledger tab shows real receipts immediately.

import { DEFAULT_CONFIG } from "@/data/seed";
import { newReceipt, uid } from "@/lib/engine";
import type { AppState, Job } from "@/lib/types";

const KEY = "foreman-state-v1";

function seedState(): AppState {
  const job: Job = {
    id: uid("job"),
    title: "Website copy refresh for a NEAR wallet",
    brief: "Rewrite the landing copy and publish a launch post.",
    budgetNEAR: 12,
    status: "done",
    escrowLocked: 0,
    escrowReleased: 8,
    escrowRefunded: 4,
    subtasks: [
      {
        id: uid("st"),
        title: "Copy & content",
        kind: "write",
        agentId: "scribe",
        plannedNEAR: 3,
        quoteNEAR: 3.1,
        finalNEAR: 3,
        status: "paid",
        progress: 100,
        deliverable: "Scribe menyerahkan: Naskah final: 1.200 kata, tone sesuai brief, headline + CTA, sudah proofread.",
        checkScore: 92,
        checkNote: "Lolos cek: kelengkapan, kualitas, dan kesesuaian brief terpenuhi (skor 92/100). Pembayaran dilepas dari escrow.",
        attempts: 1,
      },
      {
        id: uid("st"),
        title: "Launch marketing",
        kind: "marketing",
        agentId: "herald",
        plannedNEAR: 5,
        quoteNEAR: 5,
        finalNEAR: 5,
        status: "paid",
        progress: 100,
        deliverable: "Herald menyerahkan: Paket launch: 5 post X, 1 thread, dan kalender posting 7 hari.",
        checkScore: 88,
        checkNote: "Lolos cek: kelengkapan, kualitas, dan kesesuaian brief terpenuhi (skor 88/100). Pembayaran dilepas dari escrow.",
        attempts: 1,
      },
    ],
    receipts: [],
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    log: ["Rencana: 2 subtask, total rencana 8.00 NEAR dari budget 12.00 NEAR."],
  };
  const at = job.createdAt;
  job.receipts = [
    newReceipt(job.id, "escrow-funded", "You (client)", "Foreman escrow", 8, "Escrow dikunci saat job dibuat.", "ok"),
    newReceipt(job.id, "payment", "Foreman escrow", "Scribe", 3, "Copy & content — lolos cek (92/100).", "ok", job.subtasks[0].id),
    newReceipt(job.id, "payment", "Foreman escrow", "Herald", 5, "Launch marketing — lolos cek (88/100).", "ok", job.subtasks[1].id),
    newReceipt(job.id, "refund", "Foreman escrow", "You (client)", 4, "Sisa budget yang tidak terpakai dikembalikan.", "info"),
  ];
  job.receipts.forEach((r, i) => (r.at = new Date(new Date(at).getTime() + (i + 1) * 60000).toISOString()));
  return {
    jobs: [job],
    receipts: [...job.receipts],
    config: DEFAULT_CONFIG,
    treasuryNEAR: 0.8,
    spentTodayNEAR: 8,
    dayKey: new Date().toISOString().slice(0, 10),
  };
}

export function loadState(): AppState {
  if (typeof window === "undefined") return seedState();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      const s = seedState();
      window.localStorage.setItem(KEY, JSON.stringify(s));
      return s;
    }
    const parsed = JSON.parse(raw) as AppState;
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.dayKey !== today) {
      parsed.dayKey = today;
      parsed.spentTodayNEAR = 0;
    }
    return parsed;
  } catch {
    return seedState();
  }
}

export function saveState(s: AppState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage full/blocked — the app keeps working in-memory
  }
}

export function resetState(): AppState {
  const s = seedState();
  saveState(s);
  return s;
}
