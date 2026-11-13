"use client";

import { useEffect, useRef, useState } from "react";
import { AGENTS, DEFAULT_CONFIG, DEMO_TASK, KIND_LABELS } from "@/data/seed";
import {
  agentForKind,
  checkWork,
  deliverableText,
  fmtNEAR,
  negotiate,
  newJob,
  newReceipt,
  planTask,
  quoteFor,
  round2,
  splitPayment,
} from "@/lib/engine";
import { fetchIntentsQuote, lookupTestnetAccount } from "@/lib/near";
import type { AppState, BusinessConfig, Job, Subtask } from "@/lib/types";
import { loadState, resetState, saveState } from "@/lib/store";
import type { IntentsQuote, TestnetAccount } from "@/lib/near";

type Tab = "foreman" | "market" | "jobs" | "business" | "ledger" | "near";

const TABS: { id: Tab; label: string }[] = [
  { id: "foreman", label: "Foreman" },
  { id: "market", label: "Marketplace" },
  { id: "jobs", label: "My Jobs" },
  { id: "business", label: "Business Console" },
  { id: "ledger", label: "Ledger" },
  { id: "near", label: "NEAR Live" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export default function Home() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("foreman");
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [budget, setBudget] = useState("25");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoLog, setDemoLog] = useState<string[]>([]);
  const [lookupId, setLookupId] = useState("test.near");
  const [lookupResult, setLookupResult] = useState<TestnetAccount | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [quoteUsdc, setQuoteUsdc] = useState("1");
  const [quote, setQuote] = useState<IntentsQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setState(loadState());
  }, []);

  // Mirror of state for the async demo loop (reads are deterministic anyway).
  const stateRef = useRef<AppState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function update(fn: (s: AppState) => void) {
    setState((prev) => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      saveState(next);
      return next;
    });
  }

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 6000);
  }

  function getJob(s: AppState, jobId: string): Job | undefined {
    return s.jobs.find((j) => j.id === jobId);
  }

  function pushReceipt(
    s: AppState,
    job: Job,
    r: ReturnType<typeof newReceipt>,
  ) {
    job.receipts.push(r);
    s.receipts.push(r);
  }

  function finishJobIfDone(s: AppState, job: Job) {
    const open = job.subtasks.some((t) =>
      ["planned", "quoted", "negotiating", "accepted", "working", "delivered", "checked", "revision"].includes(t.status),
    );
    if (!open && job.status === "active") {
      job.status = "done";
      const remaining = round2(job.escrowLocked);
      if (remaining > 0) {
        job.escrowLocked = 0;
        job.escrowRefunded = round2(job.escrowRefunded + remaining);
        pushReceipt(
          s,
          job,
          newReceipt(job.id, "refund", "Foreman escrow", "You (client)", remaining, "Sisa escrow dikembalikan saat job selesai.", "info"),
        );
      }
      job.log.push("Job selesai — semua subtask tuntas atau ditutup.");
    }
  }

  // ---------- Foreman: create a task ----------
  function createTask(t: string, b: string, budgetStr: string) {
    if (!state) return;
    if (state.config.killSwitch) {
      flash("Kill switch AKTIF — Foreman tidak boleh membuat job baru. Matikan dulu di Business Console.");
      return;
    }
    const budgetNEAR = Number(budgetStr);
    if (!t.trim() || !b.trim() || !(budgetNEAR >= 1)) {
      flash("Isi judul, brief, dan budget minimal 1 NEAR.");
      return;
    }
    const { subtasks, notes } = planTask(t.trim(), b.trim(), budgetNEAR, state.config);
    if (subtasks.length === 0) {
      flash("Budget terlalu kecil untuk subtask apa pun (minimal 1 NEAR).");
      return;
    }
    const job = newJob(t.trim(), b.trim(), budgetNEAR, subtasks, notes);
    pushReceipt(
      { jobs: [], receipts: [], config: state.config, treasuryNEAR: 0, spentTodayNEAR: 0, dayKey: "" } as unknown as AppState,
      job,
      newReceipt(job.id, "escrow-funded", "You (client)", "Foreman escrow", job.escrowLocked, "Escrow dikunci saat job dibuat (simulasi).", "ok"),
    );
    update((s) => {
      s.jobs.unshift(job);
      s.receipts.push(...job.receipts);
    });
    setSelectedJobId(job.id);
    setTab("jobs");
    flash(`Job dibuat: ${subtasks.length} subtask direncanakan, escrow ${fmtNEAR(job.escrowLocked)} dikunci. Minta quote tiap subtask untuk lanjut.`);
  }

  // ---------- Subtask lifecycle ----------
  function act(jobId: string, subtaskId: string, fn: (s: AppState, job: Job, t: Subtask) => void) {
    update((s) => {
      const job = getJob(s, jobId);
      const t = job?.subtasks.find((x) => x.id === subtaskId);
      if (job && t) fn(s, job, t);
    });
  }

  function requestQuote(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      const agent = AGENTS.find((a) => a.id === t.agentId);
      if (!agent || t.status !== "planned") return;
      t.quoteNEAR = quoteFor(agent, t.plannedNEAR, job.id);
      t.status = "quoted";
      job.log.push(`${agent.name} mengajukan quote ${fmtNEAR(t.quoteNEAR)} untuk "${t.title}" (rencana ${fmtNEAR(t.plannedNEAR)}).`);
    });
  }

  function negotiateStep(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      const agent = AGENTS.find((a) => a.id === t.agentId);
      if (!agent || t.status !== "quoted" || t.quoteNEAR === null) return;
      t.status = "negotiating";
      const res = negotiate(agent, t.plannedNEAR, t.quoteNEAR);
      job.log.push(res.note);
      if (res.outcome === "accepted") {
        t.finalNEAR = res.finalNEAR;
        t.status = "accepted";
        pushReceipt(s, job, newReceipt(job.id, "quote-accepted", "Foreman", agent.name, res.finalNEAR ?? 0, `"${t.title}" — harga disepakati ${fmtNEAR(res.finalNEAR ?? 0)}.`, "ok", t.id));
      } else {
        t.status = "walked-away";
        pushReceipt(s, job, newReceipt(job.id, "walked-away", agent.name, "Foreman", 0, `"${t.title}" — ${agent.name} mundur setelah negosiasi.`, "fail", t.id));
      }
    });
  }

  function reassign(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      if (t.status !== "walked-away") return;
      const others = AGENTS.filter((a) => a.specialties.some((sp) => agentForKind(t.kind).specialties.includes(sp)) && a.id !== t.agentId);
      const alt = others.sort((a, b) => a.rateNEAR - b.rateNEAR)[0];
      if (!alt) {
        t.status = "rejected";
        const refund = round2(t.plannedNEAR);
        job.escrowLocked = round2(Math.max(0, job.escrowLocked - refund));
        job.escrowRefunded = round2(job.escrowRefunded + refund);
        job.log.push(`Tidak ada agen pengganti untuk "${t.title}" — subtask dicoret, ${fmtNEAR(refund)} dikembalikan dari escrow.`);
        finishJobIfDone(s, job);
        return;
      }
      const oldAgent = AGENTS.find((a) => a.id === t.agentId)?.name ?? "?";
      t.agentId = alt.id;
      t.plannedNEAR = round2(Math.max(s.config.minPriceNEAR, alt.rateNEAR));
      t.quoteNEAR = null;
      t.finalNEAR = null;
      t.status = "planned";
      job.log.push(`${oldAgent} mundur — Foreman menunjuk ${alt.name} sebagai pengganti untuk "${t.title}" (rencana ${fmtNEAR(t.plannedNEAR)}).`);
    });
  }

  function startWork(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      if (t.status !== "accepted") return;
      t.status = "working";
      t.progress = 5;
      job.log.push(`"${t.title}" mulai dikerjakan.`);
    });
  }

  function advanceWork(jobId: string, subtaskId: string, by = 35) {
    act(jobId, subtaskId, (s, job, t) => {
      if (t.status !== "working") return;
      t.progress = Math.min(100, t.progress + by);
      if (t.progress >= 100) {
        const agent = AGENTS.find((a) => a.id === t.agentId);
        t.deliverable = agent ? deliverableText(agent, t) : "Hasil kerja diserahkan.";
        t.status = "delivered";
        job.log.push(`"${t.title}" selesai dikerjakan — deliverable diserahkan untuk dicek.`);
      }
    });
  }

  function checkStep(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      const agent = AGENTS.find((a) => a.id === t.agentId);
      if (!agent || t.status !== "delivered") return;
      t.attempts += 1;
      const res = checkWork(agent, t);
      t.checkScore = res.score;
      t.checkNote = res.note;
      job.log.push(res.note);
      if (res.pass) {
        t.status = "checked";
      } else if (t.attempts >= 2) {
        t.status = "rejected";
        const refund = round2(t.finalNEAR ?? t.plannedNEAR);
        job.escrowLocked = round2(Math.max(0, job.escrowLocked - refund));
        job.escrowRefunded = round2(job.escrowRefunded + refund);
        pushReceipt(s, job, newReceipt(job.id, "refund", "Foreman escrow", "You (client)", refund, `"${t.title}" gagal cek 2x — dana dikembalikan.`, "fail", t.id));
        finishJobIfDone(s, job);
      } else {
        t.status = "revision";
        job.log.push(`"${t.title}" dikembalikan untuk revisi (percobaan ${t.attempts}/2).`);
      }
    });
  }

  function reviseStep(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      if (t.status !== "revision") return;
      t.status = "working";
      t.progress = 60;
      t.deliverable = null;
      job.log.push(`"${t.title}" direvisi oleh agen.`);
    });
  }

  function payStep(jobId: string, subtaskId: string) {
    if (!state) return;
    if (state.config.killSwitch) {
      flash("Kill switch AKTIF — pembayaran diblokir.");
      return;
    }
    act(jobId, subtaskId, (s, job, t) => {
      const agent = AGENTS.find((a) => a.id === t.agentId);
      if (!agent || t.status !== "checked" || t.finalNEAR === null) return;
      const amount = t.finalNEAR;
      if (s.spentTodayNEAR + amount > s.config.maxSpendPerDayNEAR) {
        job.log.push(`Pembayaran ${fmtNEAR(amount)} DITOLAK: melebihi batas harian ${fmtNEAR(s.config.maxSpendPerDayNEAR)}.`);
        flash("Pembayaran ditolak: melebihi batas belanja harian di Business Console.");
        return;
      }
      const split = splitPayment(amount, s.config);
      job.escrowLocked = round2(Math.max(0, job.escrowLocked - amount));
      job.escrowReleased = round2(job.escrowReleased + amount);
      s.treasuryNEAR = round2(s.treasuryNEAR + split.treasury);
      s.spentTodayNEAR = round2(s.spentTodayNEAR + amount);
      t.status = "paid";
      pushReceipt(s, job, newReceipt(job.id, "payment", "Foreman escrow", agent.name, split.agent, `"${t.title}" — lolos cek (${t.checkScore}/100). Agen terima ${fmtNEAR(split.agent)}, treasury ${fmtNEAR(split.treasury)}.`, "ok", t.id));
      job.log.push(`Dibayar ${fmtNEAR(amount)} untuk "${t.title}" (agen ${fmtNEAR(split.agent)} + treasury ${fmtNEAR(split.treasury)}).`);
      finishJobIfDone(s, job);
    });
  }

  function disputeStep(jobId: string, subtaskId: string) {
    act(jobId, subtaskId, (s, job, t) => {
      if (t.status !== "delivered") return;
      const refund = round2(t.finalNEAR ?? t.plannedNEAR);
      t.status = "rejected";
      job.escrowLocked = round2(Math.max(0, job.escrowLocked - refund));
      job.escrowRefunded = round2(job.escrowRefunded + refund);
      pushReceipt(s, job, newReceipt(job.id, "refund", "Foreman escrow", "You (client)", refund, `"${t.title}" ditolak klien — dana dikembalikan.`, "fail", t.id));
      job.log.push(`"${t.title}" ditolak — ${fmtNEAR(refund)} dikembalikan dari escrow.`);
      finishJobIfDone(s, job);
    });
  }

  function hireAgent(agentId: string) {
    if (!state) return;
    if (state.config.killSwitch) {
      flash("Kill switch AKTIF — tidak bisa hire agen baru.");
      return;
    }
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return;
    const budget = round2(agent.rateNEAR * 1.25);
    const kind = agent.specialties[0];
    const { subtasks, notes } = planTask(agent.tagline, agent.skills.join(", "), budget, state.config);
    const job = newJob(`Hire ${agent.name} — ${agent.tagline}`, agent.skills.join(", "), budget, subtasks, notes);
    pushReceipt({ jobs: [], receipts: [], config: state.config, treasuryNEAR: 0, spentTodayNEAR: 0, dayKey: "" } as unknown as AppState, job, newReceipt(job.id, "escrow-funded", "You (client)", "Foreman escrow", job.escrowLocked, "Escrow dikunci saat job dibuat (simulasi).", "ok"));
    update((s) => {
      s.jobs.unshift(job);
      s.receipts.push(...job.receipts);
    });
    setSelectedJobId(job.id);
    setTab("jobs");
    flash(`${agent.name} ditambahkan ke job baru — minta quote untuk mulai.`);
  }

  // ---------- Demo loop: one full hire -> pay cycle, under 2 minutes ----------
  async function runDemoLoop() {
    if (!state || demoRunning) return;
    if (state.config.killSwitch) {
      flash("Kill switch AKTIF — matikan dulu untuk menjalankan demo loop.");
      return;
    }
    setDemoRunning(true);
    setDemoLog([]);
    const log = (line: string) => setDemoLog((prev) => [...prev, line]);
    log(`Foreman menerima tugas: "${DEMO_TASK.title}" — budget ${fmtNEAR(DEMO_TASK.budgetNEAR)}.`);
    await sleep(900);
    const { subtasks, notes } = planTask(DEMO_TASK.title, DEMO_TASK.brief, DEMO_TASK.budgetNEAR, state.config);
    const job = newJob(DEMO_TASK.title, DEMO_TASK.brief, DEMO_TASK.budgetNEAR, subtasks, notes);
    const jobId = job.id;
    pushReceipt({ jobs: [], receipts: [], config: state.config, treasuryNEAR: 0, spentTodayNEAR: 0, dayKey: "" } as unknown as AppState, job, newReceipt(job.id, "escrow-funded", "You (client)", "Foreman escrow", job.escrowLocked, "Escrow dikunci saat job dibuat (simulasi).", "ok"));
    update((s) => {
      s.jobs.unshift(job);
      s.receipts.push(...job.receipts);
    });
    setSelectedJobId(jobId);
    notes.forEach((n) => log(n));
    await sleep(1200);
    for (const st of subtasks) {
      const agent = AGENTS.find((a) => a.id === st.agentId);
      if (!agent) continue;
      log(`Minta quote ke ${agent.name} untuk "${st.title}" (rencana ${fmtNEAR(st.plannedNEAR)})…`);
      await sleep(900);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t) return;
        t.quoteNEAR = quoteFor(agent, t.plannedNEAR, jobId);
        t.status = "quoted";
        j.log.push(`${agent.name} mengajukan quote ${fmtNEAR(t.quoteNEAR)}.`);
      });
      log(`  Quote masuk: ${fmtNEAR(quoteFor(agent, st.plannedNEAR, jobId))}.`);
      await sleep(900);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t || t.quoteNEAR === null) return;
        const res = negotiate(agent, t.plannedNEAR, t.quoteNEAR);
        j.log.push(res.note);
        if (res.outcome === "accepted") {
          t.finalNEAR = res.finalNEAR;
          t.status = "accepted";
          pushReceipt(s, j, newReceipt(j.id, "quote-accepted", "Foreman", agent.name, res.finalNEAR ?? 0, `"${t.title}" — harga disepakati ${fmtNEAR(res.finalNEAR ?? 0)}.`, "ok", t.id));
        } else {
          t.status = "walked-away";
          pushReceipt(s, j, newReceipt(j.id, "walked-away", agent.name, "Foreman", 0, `"${t.title}" — ${agent.name} mundur.`, "fail", t.id));
        }
      });
      // Negotiation is deterministic: compute the outcome locally so the
      // loop does not depend on reading React state back.
      const q = quoteFor(agent, st.plannedNEAR, jobId);
      const res = negotiate(agent, st.plannedNEAR, q);
      const accepted = res.outcome === "accepted";
      if (!accepted) {
        log(`  ${agent.name} mundur setelah negosiasi — subtask dilewati.`);
        continue;
      }
      log(`  Harga disepakati. ${agent.name} mulai bekerja…`);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (j && t) {
          t.status = "working";
          t.progress = 5;
        }
      });
      for (const p of [35, 70, 100]) {
        await sleep(900);
        update((s) => {
          const j = getJob(s, jobId);
          const t = j?.subtasks.find((x) => x.id === st.id);
          if (!j || !t) return;
          t.progress = p;
          if (p >= 100) {
            t.deliverable = deliverableText(agent, t);
            t.status = "delivered";
            j.log.push(`"${t.title}" selesai — deliverable diserahkan.`);
          }
        });
        log(`  Progres "${st.title}": ${p}%.`);
      }
      await sleep(800);
      log(`  Foreman memeriksa hasil kerja ${agent.name}…`);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t) return;
        t.attempts += 1;
        const res = checkWork(agent, t);
        t.checkScore = res.score;
        t.checkNote = res.note;
        j.log.push(res.note);
        if (res.pass) {
          t.status = "checked";
        } else {
          t.status = "revision";
          t.progress = 60;
          t.deliverable = null;
        }
      });
      await sleep(800);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t) return;
        if (t.status === "revision") {
          t.status = "working";
          t.progress = 80;
          j.log.push(`Revisi diminta — ${agent.name} memperbaiki.`);
        }
      });
      await sleep(800);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t) return;
        if (t.status === "working" && t.progress >= 80) {
          t.progress = 100;
          t.deliverable = deliverableText(agent, t);
          t.status = "delivered";
          t.attempts += 1;
          const res = checkWork(agent, t);
          t.checkScore = res.score;
          t.checkNote = res.note;
          j.log.push(res.note);
          if (res.pass) t.status = "checked";
        }
      });
      // Work checks are deterministic (attempts 1, then 2 after a revision).
      const firstCheck = checkWork(agent, { ...st, attempts: 1 });
      let checked = firstCheck.pass;
      if (!checked) {
        const secondCheck = checkWork(agent, { ...st, attempts: 2 });
        checked = secondCheck.pass;
      }
      if (!checked) {
        log(`  "${st.title}" gagal cek 2x — dana dikembalikan.`);
        continue;
      }
      log(`  Lolos cek. Membayar dari escrow…`);
      update((s) => {
        const j = getJob(s, jobId);
        const t = j?.subtasks.find((x) => x.id === st.id);
        if (!j || !t || t.finalNEAR === null) return;
        const amount = t.finalNEAR;
        const split = splitPayment(amount, s.config);
        j.escrowLocked = round2(Math.max(0, j.escrowLocked - amount));
        j.escrowReleased = round2(j.escrowReleased + amount);
        s.treasuryNEAR = round2(s.treasuryNEAR + split.treasury);
        s.spentTodayNEAR = round2(s.spentTodayNEAR + amount);
        t.status = "paid";
        pushReceipt(s, j, newReceipt(j.id, "payment", "Foreman escrow", agent.name, split.agent, `"${t.title}" — lolos cek (${t.checkScore}/100).`, "ok", t.id));
        j.log.push(`Dibayar ${fmtNEAR(amount)} untuk "${t.title}".`);
      });
      await sleep(700);
    }
    update((s) => {
      const j = getJob(s, jobId);
      if (j) finishJobIfDone(s, j);
    });
    log("Loop selesai — lihat struk lengkap di tab Ledger, atau buka tab My Jobs untuk detail job.");
    setDemoRunning(false);
  }

  async function doLookup() {
    setLookupBusy(true);
    setLookupError(null);
    setLookupResult(null);
    const r = await lookupTestnetAccount(lookupId);
    if (r.ok) setLookupResult(r.account);
    else setLookupError(r.error);
    setLookupBusy(false);
  }

  async function doQuote() {
    setQuoteBusy(true);
    setQuoteError(null);
    setQuote(null);
    const r = await fetchIntentsQuote(Number(quoteUsdc) || 1);
    if (r.ok) setQuote(r.quote);
    else setQuoteError(r.error);
    setQuoteBusy(false);
  }

  function exportLedger() {
    if (!state) return;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), receipts: state.receipts }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "foreman-ledger.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function resetDemo() {
    const s = resetState();
    setState(s);
    setSelectedJobId(null);
    setDemoLog([]);
    flash("Demo direset ke data awal.");
  }

  if (!state) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
        <p>Memuat Foreman…</p>
      </main>
    );
  }

  const selectedJob = state.jobs.find((j) => j.id === selectedJobId) ?? state.jobs[0] ?? null;
  const visibleAgents = AGENTS.filter((a) =>
    !filter.trim() ||
    `${a.name} ${a.tagline} ${a.specialties.join(" ")} ${a.skills.join(" ")}`.toLowerCase().includes(filter.toLowerCase()),
  );
  const openJobs = state.jobs.filter((j) => j.status === "active").length;

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-2xl font-black text-white">F</div>
            <div>
              <h1 className="text-xl font-black leading-tight">Foreman</h1>
              <p className="text-xs text-neutral-500">The general contractor agent for the NEAR agent economy</p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-neutral-900 px-3 py-1 text-[11px] font-bold text-white">NEAR HACKATHON · Build Beyond Boundaries</span>
            <span className="rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-bold text-emerald-800">Demo · {openJobs} job aktif</span>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-bold text-amber-800">Treasury {fmtNEAR(state.treasuryNEAR)}</span>
            <button onClick={resetDemo} className="rounded-full border border-neutral-300 px-3 py-1 text-[11px] font-bold hover:bg-neutral-100">Reset demo</button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold ${tab === t.id ? "bg-emerald-600 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {notice && (
        <div className="mx-auto mt-4 max-w-6xl px-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{notice}</div>
        </div>
      )}

      <div className="mx-auto max-w-6xl px-4 py-6">
        {tab === "foreman" && (
          <div className="space-y-6">
            <section className="rounded-2xl bg-neutral-900 p-6 text-white sm:p-8">
              <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">Agent Economy · Autonomous Business</p>
              <h2 className="mt-2 text-3xl font-black leading-tight sm:text-4xl">Kasih tugas + budget.<br />Foreman yang kerjakan sisanya.</h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-300">
                Foreman memecah tugasmu, merekrut agen spesialis, menawar harga sekali kalau quote
                kemahalan, memeriksa hasil kerja, lalu membayar dari escrow — semua di dalam budget.
                Setiap rupiah tercatat di Ledger sebagai struk.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-bold">
                <span className="rounded-full bg-white/10 px-3 py-1">Escrow terkunci di awal</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Negosiasi 1 ronde</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Cek kerja sebelum bayar</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Refund otomatis kalau gagal</span>
                <span className="rounded-full bg-white/10 px-3 py-1">Revenue split 90/10</span>
              </div>
              <p className="mt-4 text-xs text-neutral-400">
                Demo environment — escrow &amp; pembayaran disimulasikan di browser kamu. Lookup saldo
                NEAR testnet dan quote NEAR Intents 1Click di tab “NEAR Live” adalah live (read-only).
                Tidak ada token asli yang bergerak.
              </p>
            </section>

            <section className="rounded-2xl border border-neutral-200 bg-white p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-black">Jalankan demo loop — satu siklus penuh &lt; 2 menit</h3>
                  <p className="text-sm text-neutral-500">Hire → negosiasi → kerja → cek → bayar, untuk tugas contoh: landing page + riset pasar (budget 50 NEAR).</p>
                </div>
                <button
                  onClick={runDemoLoop}
                  disabled={demoRunning || state.config.killSwitch}
                  className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-black text-white disabled:opacity-50"
                >
                  {demoRunning ? "Demo berjalan…" : "▶ Jalankan demo loop"}
                </button>
              </div>
              {demoLog.length > 0 && (
                <div className="mt-4 max-h-64 overflow-y-auto rounded-xl bg-neutral-950 p-4 font-mono text-xs leading-relaxed text-emerald-300">
                  {demoLog.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-neutral-200 bg-white p-6">
              <h3 className="text-lg font-black">Buat tugas baru</h3>
              <p className="text-sm text-neutral-500">Foreman membaca kata kunci di judul &amp; brief untuk menentukan subtask (riset, bangun, desain, tulis, data, marketing, audit, integrasi) — lalu merencanakan di dalam budget.</p>
              <div className="mt-4 space-y-3">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Judul tugas — contoh: Launch landing page untuk fitur swap" className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-emerald-500" />
                <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={3} placeholder="Brief — contoh: riset harga kompetitor, desain landing page, tulis copy, dan siapkan post launch." className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-sm outline-none focus:border-emerald-500" />
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-bold">
                    Budget (NEAR)
                    <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" className="w-28 rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                  </label>
                  <button onClick={() => createTask(title, brief, budget)} className="rounded-xl bg-neutral-900 px-5 py-3 text-sm font-black text-white">Buat rencana dengan Foreman</button>
                  <button
                    onClick={() => { setTitle(DEMO_TASK.title); setBrief(DEMO_TASK.brief); setBudget(String(DEMO_TASK.budgetNEAR)); }}
                    className="rounded-xl border border-neutral-300 px-4 py-3 text-sm font-bold"
                  >
                    Isi contoh
                  </button>
                </div>
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-5">
              {[
                ["1 · Rencana", "Tugas dipecah jadi subtask. Total rencana tidak pernah melebihi budget."],
                ["2 · Quote", "Tiap agen mengajukan harga. Di atas rencana +10% → Foreman menawar sekali."],
                ["3 · Escrow", "Dana dikunci di awal. Agen dibayar hanya setelah kerja lolos cek."],
                ["4 · Cek kerja", "Foreman menilai hasil (skor ≥ 80 lolos). Gagal 2x → refund otomatis."],
                ["5 · Struk", "Setiap kejadian tercatat: pembayaran, refund, dan split treasury."],
              ].map(([h, p]) => (
                <div key={h} className="rounded-2xl border border-neutral-200 bg-white p-4">
                  <p className="text-sm font-black">{h}</p>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-500">{p}</p>
                </div>
              ))}
            </section>
          </div>
        )}

        {tab === "market" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-black">Marketplace agen</h2>
                <p className="text-sm text-neutral-500">8 agen spesialis. Klik “Hire” untuk membuat job dengan agen itu — atau biarkan Foreman memilihkan lewat tab Foreman.</p>
              </div>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Cari: code, design, audit…" className="w-64 rounded-xl border border-neutral-300 px-4 py-2 text-sm outline-none focus:border-emerald-500" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {visibleAgents.map((a) => (
                <div key={a.id} className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-black text-white" style={{ backgroundColor: a.color }}>{a.name[0]}</div>
                    <div>
                      <p className="font-black leading-tight">{a.name}</p>
                      <p className="text-xs text-neutral-500">{a.tagline}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-600">
                    <span>★ {a.rating.toFixed(1)}</span>
                    <span>{a.jobsDone} job</span>
                    <span>{a.successRate}% sukses</span>
                    <span>balas {a.response}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1">
                    {a.skills.map((s) => (
                      <span key={s} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{s}</span>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
                    <p className="text-sm"><span className="text-lg font-black">{a.rateNEAR}</span> NEAR / subtask</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${a.flexible ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{a.flexible ? "Fleksibel" : "Harga tegas"}</span>
                  </div>
                  <button onClick={() => hireAgent(a.id)} className="mt-3 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white">Hire {a.name}</button>
                </div>
              ))}
              {visibleAgents.length === 0 && <p className="text-sm text-neutral-500">Tidak ada agen yang cocok dengan “{filter}”.</p>}
            </div>
          </div>
        )}

        {tab === "jobs" && (
          <div className="space-y-4">
            <h2 className="text-2xl font-black">My Jobs</h2>
            {state.jobs.length === 0 && <p className="text-sm text-neutral-500">Belum ada job. Buat dari tab Foreman atau hire agen di Marketplace.</p>}
            {state.jobs.map((job) => {
              const isOpen = selectedJob?.id === job.id;
              const spent = round2(job.escrowReleased);
              return (
                <div key={job.id} className="rounded-2xl border border-neutral-200 bg-white">
                  <button onClick={() => setSelectedJobId(isOpen ? null : job.id)} className="flex w-full flex-wrap items-center gap-3 px-5 py-4 text-left">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${job.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-neutral-100 text-neutral-600"}`}>{job.status === "active" ? "AKTIF" : "SELESAI"}</span>
                    <span className="font-black">{job.title}</span>
                    <span className="ml-auto text-sm text-neutral-500">Budget {fmtNEAR(job.budgetNEAR)} · Escrow terkunci {fmtNEAR(job.escrowLocked)} · Dibayar {fmtNEAR(spent)} · Refund {fmtNEAR(job.escrowRefunded)}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-neutral-100 px-5 py-4">
                      <p className="text-sm text-neutral-600">{job.brief}</p>
                      <div className="mt-4 space-y-3">
                        {job.subtasks.map((t) => {
                          const agent = AGENTS.find((a) => a.id === t.agentId);
                          return (
                            <div key={t.id} className="rounded-xl border border-neutral-200 p-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-bold">{KIND_LABELS[t.kind] ?? t.kind}</span>
                                <span className="font-bold">{t.title}</span>
                                <span className="text-sm text-neutral-500">→ {agent?.name ?? "—"} (★ {agent?.rating.toFixed(1)})</span>
                                <span className="ml-auto rounded-full bg-neutral-900 px-2.5 py-1 text-[11px] font-bold text-white">{t.status.replace("-", " ").toUpperCase()}</span>
                              </div>
                              <p className="mt-1 text-xs text-neutral-500">
                                Rencana {fmtNEAR(t.plannedNEAR)}
                                {t.quoteNEAR !== null && <> · Quote {fmtNEAR(t.quoteNEAR)}</>}
                                {t.finalNEAR !== null && <> · Harga akhir {fmtNEAR(t.finalNEAR)}</>}
                                {t.checkScore !== null && <> · Skor cek {t.checkScore}/100</>}
                              </p>
                              {t.status === "working" && (
                                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                                  <div className="h-full bg-emerald-500" style={{ width: `${t.progress}%` }} />
                                </div>
                              )}
                              {t.deliverable && <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{t.deliverable}</p>}
                              {t.checkNote && <p className="mt-2 text-xs text-neutral-500">{t.checkNote}</p>}
                              <div className="mt-3 flex flex-wrap gap-2">
                                {t.status === "planned" && <button onClick={() => requestQuote(job.id, t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white">Minta quote</button>}
                                {t.status === "quoted" && <button onClick={() => negotiateStep(job.id, t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white">Negosiasi</button>}
                                {t.status === "walked-away" && <button onClick={() => reassign(job.id, t.id)} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-black text-white">Cari agen pengganti</button>}
                                {t.status === "accepted" && <button onClick={() => startWork(job.id, t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white">Mulai kerja</button>}
                                {t.status === "working" && <button onClick={() => advanceWork(job.id, t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white">Majukan kerja (+35%)</button>}
                                {t.status === "delivered" && (
                                  <>
                                    <button onClick={() => checkStep(job.id, t.id)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-black text-white">Cek hasil kerja</button>
                                    <button onClick={() => disputeStep(job.id, t.id)} className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-bold text-red-700">Tolak (dispute → refund)</button>
                                  </>
                                )}
                                {t.status === "revision" && <button onClick={() => reviseStep(job.id, t.id)} className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-black text-white">Kirim revisi</button>}
                                {t.status === "checked" && <button onClick={() => payStep(job.id, t.id)} className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-black text-white">Bayar dari escrow</button>}
                                {t.status === "paid" && <span className="text-xs font-bold text-emerald-700">✓ Dibayar — struk ada di Ledger</span>}
                                {t.status === "rejected" && <span className="text-xs font-bold text-red-600">Ditolak — dana dikembalikan</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-bold text-neutral-600">Log job ({job.log.length})</summary>
                        <ul className="mt-2 space-y-1 rounded-xl bg-neutral-50 p-3 text-xs text-neutral-600">
                          {job.log.map((l, i) => (
                            <li key={i}>• {l}</li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === "business" && (
          <div className="space-y-4">
            <h2 className="text-2xl font-black">Business Console</h2>
            <p className="text-sm text-neutral-500">Aturan bisnis Foreman — manusia hanya mengatur batas. Foreman yang menjalankan loop jual-beli di dalamnya. Perubahan tersimpan otomatis di browser.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5"><p className="text-xs font-bold text-neutral-500">Treasury Foreman</p><p className="mt-1 text-2xl font-black">{fmtNEAR(state.treasuryNEAR)}</p><p className="text-xs text-neutral-500">dari split {state.config.treasurySharePct}% tiap pembayaran</p></div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-5"><p className="text-xs font-bold text-neutral-500">Belanja hari ini</p><p className="mt-1 text-2xl font-black">{fmtNEAR(state.spentTodayNEAR)} / {fmtNEAR(state.config.maxSpendPerDayNEAR)}</p><p className="text-xs text-neutral-500">reset tiap hari (UTC)</p></div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-5"><p className="text-xs font-bold text-neutral-500">Job aktif</p><p className="mt-1 text-2xl font-black">{openJobs}</p><p className="text-xs text-neutral-500">{state.jobs.length} job total</p></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5">
                <h3 className="font-black">Batas belanja</h3>
                <label className="mt-3 block text-sm font-bold">Maks. belanja / hari (NEAR)
                  <input type="number" min={1} value={state.config.maxSpendPerDayNEAR} onChange={(e) => update((s) => { s.config.maxSpendPerDayNEAR = Math.max(1, Number(e.target.value) || 1); })} className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                </label>
                <label className="mt-3 block text-sm font-bold">Maks. belanja / job (NEAR)
                  <input type="number" min={1} value={state.config.maxSpendPerJobNEAR} onChange={(e) => update((s) => { s.config.maxSpendPerJobNEAR = Math.max(1, Number(e.target.value) || 1); })} className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                </label>
                <label className="mt-3 block text-sm font-bold">Harga minimum / subtask (NEAR)
                  <input type="number" min={0.5} step={0.5} value={state.config.minPriceNEAR} onChange={(e) => update((s) => { s.config.minPriceNEAR = Math.max(0.5, Number(e.target.value) || 0.5); })} className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                </label>
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-5">
                <h3 className="font-black">Revenue split &amp; kill switch</h3>
                <label className="mt-3 block text-sm font-bold">Agen dapat {state.config.agentSharePct}% · Treasury {state.config.treasurySharePct}%
                  <input type="range" min={50} max={100} value={state.config.agentSharePct} onChange={(e) => update((s) => { const v = Number(e.target.value); s.config.agentSharePct = v; s.config.treasurySharePct = 100 - v; })} className="mt-2 w-full" />
                </label>
                <label className="mt-3 block text-sm font-bold">Auto-approve quote ≤ (NEAR)
                  <input type="number" min={0} value={state.config.autoApproveUnderNEAR} onChange={(e) => update((s) => { s.config.autoApproveUnderNEAR = Math.max(0, Number(e.target.value) || 0); })} className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                </label>
                <div className="mt-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                  <div>
                    <p className="text-sm font-black text-red-800">Kill switch</p>
                    <p className="text-xs text-red-700">{state.config.killSwitch ? "AKTIF — semua job & pembayaran baru diblokir." : "Mati — Foreman beroperasi normal."}</p>
                  </div>
                  <button
                    onClick={() => update((s) => { s.config.killSwitch = !s.config.killSwitch; })}
                    className={`rounded-xl px-4 py-2 text-sm font-black text-white ${state.config.killSwitch ? "bg-emerald-600" : "bg-red-600"}`}
                  >
                    {state.config.killSwitch ? "Matikan" : "AKTIFKAN"}
                  </button>
                </div>
                <button onClick={() => update((s) => { s.config = { ...DEFAULT_CONFIG }; })} className="mt-3 rounded-xl border border-neutral-300 px-4 py-2 text-sm font-bold">Kembalikan ke default</button>
              </div>
            </div>
          </div>
        )}

        {tab === "ledger" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-black">Ledger publik</h2>
                <p className="text-sm text-neutral-500">Setiap penjualan, biaya, dan payout tercatat di sini — seperti yang diminta track Autonomous Business.</p>
              </div>
              <button onClick={exportLedger} className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-black text-white">Export JSON</button>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-100 text-xs text-neutral-500">
                    <th className="px-4 py-3">Waktu</th>
                    <th className="px-4 py-3">Jenis</th>
                    <th className="px-4 py-3">Dari → Ke</th>
                    <th className="px-4 py-3">Jumlah</th>
                    <th className="px-4 py-3">Catatan</th>
                  </tr>
                </thead>
                <tbody>
                  {[...state.receipts].reverse().map((r) => (
                    <tr key={r.id} className="border-b border-neutral-50">
                      <td className="px-4 py-2 text-xs text-neutral-500">{new Date(r.at).toLocaleString("id-ID")}</td>
                      <td className="px-4 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.status === "ok" ? "bg-emerald-100 text-emerald-800" : r.status === "fail" ? "bg-red-100 text-red-800" : "bg-neutral-100 text-neutral-700"}`}>{r.kind}</span></td>
                      <td className="px-4 py-2 text-xs">{r.from} → {r.to}</td>
                      <td className="px-4 py-2 font-bold">{fmtNEAR(r.amountNEAR)}</td>
                      <td className="px-4 py-2 text-xs text-neutral-500">{r.note}</td>
                    </tr>
                  ))}
                  {state.receipts.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-neutral-500">Belum ada struk.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "near" && (
          <div className="space-y-4">
            <h2 className="text-2xl font-black">NEAR Live</h2>
            <p className="text-sm text-neutral-500">Dua integrasi NEAR yang benar-benar live di demo ini — read-only, tanpa kunci privat, tanpa transaksi.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-neutral-200 bg-white p-5">
                <h3 className="font-black">1 · Saldo akun NEAR testnet</h3>
                <p className="mt-1 text-xs text-neutral-500">Lookup langsung ke rpc.testnet.near.org (public RPC, CORS terbuka). Coba: test.near</p>
                <div className="mt-3 flex gap-2">
                  <input value={lookupId} onChange={(e) => setLookupId(e.target.value)} placeholder="nama.testnet" className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                  <button onClick={doLookup} disabled={lookupBusy} className="shrink-0 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50">{lookupBusy ? "…" : "Cek saldo"}</button>
                </div>
                {lookupError && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{lookupError}</p>}
                {lookupResult && (
                  <div className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm">
                    <p className="font-black">{lookupResult.accountId}</p>
                    <p>Saldo: <b>{lookupResult.balanceNEAR} NEAR</b></p>
                    <p>Terkunci: {lookupResult.lockedNEAR} NEAR · Storage: {lookupResult.storageUsage.toLocaleString()} byte</p>
                    <p className="text-xs text-neutral-500">Block height {lookupResult.blockHeight.toLocaleString()} (final)</p>
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-neutral-200 bg-white p-5">
                <h3 className="font-black">2 · Quote NEAR Intents (1Click)</h3>
                <p className="mt-1 text-xs text-neutral-500">Dry quote USDC (Ethereum) → wNEAR lewat NEAR Intents. dry=true: hanya dihitung, tidak ada deposit atau eksekusi.</p>
                <div className="mt-3 flex gap-2">
                  <input value={quoteUsdc} onChange={(e) => setQuoteUsdc(e.target.value)} inputMode="decimal" className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-emerald-500" />
                  <span className="self-center text-sm font-bold">USDC → wNEAR</span>
                  <button onClick={doQuote} disabled={quoteBusy} className="shrink-0 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50">{quoteBusy ? "…" : "Minta quote"}</button>
                </div>
                {quoteError && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{quoteError}</p>}
                {quote && (
                  <div className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm">
                    <p><b>{quote.amountInFormatted} USDC</b> (≈ ${quote.amountInUsd}) → <b>{Number(quote.amountOutFormatted).toFixed(4)} wNEAR</b> (≈ ${quote.amountOutUsd})</p>
                    <p className="text-xs text-neutral-500">Estimasi waktu swap: ±{quote.timeEstimate} detik · dry quote — tidak ada token yang bergerak.</p>
                  </div>
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h3 className="font-black text-amber-900">Yang asli vs yang simulasi — jujur</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                <li><b>Asli:</b> lookup saldo testnet (RPC publik) dan dry quote 1Click Intents di atas.</li>
                <li><b>Simulasi (di browser, jelas dilabeli):</b> escrow, pembayaran agen, split treasury, dan refund. Kontrak escrow on-chain adalah langkah berikut — bukan klaim hari ini.</li>
                <li>Demo ini tidak meminta dompet, tidak menyimpan seed, dan tidak menandatangani transaksi apa pun.</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      <footer className="border-t border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-5 text-xs text-neutral-500">
          <span><b className="text-neutral-900">Foreman</b> — built for NEAR HACKATHON: Build Beyond Boundaries (1–14 Nov 2026). Tracks: Agent Economy + Autonomous Business.</span>
          <span className="ml-auto">MIT License · Data demo tersimpan lokal di browser kamu.</span>
        </div>
      </footer>
    </main>
  );
}
