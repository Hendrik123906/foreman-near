// Foreman — core domain types.
// Money is NEAR (testnet units in the demo). All escrow/payment flows in the
// demo are simulated in the browser; see README.md "What is real vs simulated".

export interface Agent {
  id: string;
  name: string;
  tagline: string;
  specialties: string[];
  /** Flat rate per subtask, in NEAR. */
  rateNEAR: number;
  rating: number; // 0 - 5
  jobsDone: number;
  successRate: number; // 0 - 100
  response: string;
  /** Flexible agents accept a counter-offer more easily; firm ones walk away. */
  flexible: boolean;
  color: string;
  skills: string[];
}

export type SubtaskStatus =
  | "planned"
  | "quoted"
  | "negotiating"
  | "accepted"
  | "working"
  | "delivered"
  | "checked"
  | "paid"
  | "revision"
  | "walked-away"
  | "rejected";

export interface Subtask {
  id: string;
  title: string;
  kind: string;
  agentId: string | null;
  plannedNEAR: number;
  quoteNEAR: number | null;
  finalNEAR: number | null;
  status: SubtaskStatus;
  progress: number; // 0 - 100 while working
  deliverable: string | null;
  checkScore: number | null;
  checkNote: string | null;
  attempts: number;
}

export interface Receipt {
  id: string;
  at: string; // ISO timestamp
  kind: string;
  jobId: string;
  subtaskId?: string;
  from: string;
  to: string;
  amountNEAR: number;
  note: string;
  status: "ok" | "info" | "fail";
}

export interface Job {
  id: string;
  title: string;
  brief: string;
  budgetNEAR: number;
  status: "active" | "done" | "cancelled";
  escrowLocked: number;
  escrowReleased: number;
  escrowRefunded: number;
  subtasks: Subtask[];
  receipts: Receipt[];
  createdAt: string;
  log: string[];
}

export interface BusinessConfig {
  maxSpendPerDayNEAR: number;
  maxSpendPerJobNEAR: number;
  minPriceNEAR: number;
  agentSharePct: number; // % of each payout that goes to the agent
  treasurySharePct: number; // % that goes to the Foreman treasury
  killSwitch: boolean;
  autoApproveUnderNEAR: number; // auto-accept quotes at or under this price
}

export interface AppState {
  jobs: Job[];
  receipts: Receipt[];
  config: BusinessConfig;
  treasuryNEAR: number;
  spentTodayNEAR: number;
  dayKey: string; // YYYY-MM-DD, resets spentTodayNEAR on a new day
}
