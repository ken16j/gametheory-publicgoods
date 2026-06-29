/* ============================================================
   PUBLIC GOODS GAME — Supabase edition
   Frontend: React + Vite. Backend: Supabase (Postgres + Realtime).
   Schema lives in supabase.sql at repo root. Paste it once into
   the Supabase SQL editor, enable realtime on the three tables,
   then drop your project URL and anon key into the two env vars
   below (Vercel) or into the inlined fallback for local dev.
   ============================================================ */

import React, { useEffect, useRef, useState } from "react";
import { createClient, RealtimeChannel } from "@supabase/supabase-js";

/* ------------------------------------------------------------
   1. SUPABASE CLIENT
   Vite exposes import.meta.env.VITE_* to the browser bundle.
   ------------------------------------------------------------ */
const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || "YOUR_ANON_KEY";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  realtime: { params: { eventsPerSecond: 20 } },
});

/* ------------------------------------------------------------
   2. TYPES + DEFAULTS
   ------------------------------------------------------------ */
type GroupMode = "full" | "groups";
type AutoBase = "endowment" | "balance";

interface SessionConfig {
  numRounds: number;        // number of contribution rounds
  groupMode: GroupMode;
  groupSize: number;
  endowment: number;        // seed tokens for round 1 only (1-20)
  multiplier: number;       // dividend factor (0.1-2)
  roundSeconds: number;
  autoSubmitFraction: number;
  autoSubmitBase: AutoBase;
  regroupEachRound: boolean;
  punishmentRound: boolean; // append a final punishment-only round
  punishDamage: number;     // points removed from each chosen target
  punishCost: number;       // points the punisher pays per target chosen
}
const DEFAULT_CONFIG: SessionConfig = {
  numRounds: 6, groupMode: "groups", groupSize: 12,
  endowment: 20, multiplier: 1, roundSeconds: 90,
  autoSubmitFraction: 0.5, autoSubmitBase: "endowment",
  regroupEachRound: true,
  punishmentRound: true, punishDamage: 3, punishCost: 1,
};

/* The punishment round, when enabled, is appended after the
   contribution rounds, so it is round numRounds + 1. */
const lastRoundNum = (c: SessionConfig) => c.numRounds + (c.punishmentRound ? 1 : 0);
const isPunishRound = (c: SessionConfig, r: number) =>
  c.punishmentRound && r === c.numRounds + 1;

interface SessionRow {
  code: string; status: "lobby" | "running" | "done" | "ended";
  current_round: number; config: SessionConfig;
}
interface PlayerRow {
  id: string; session: string; name: string;
  seat: number;                       // stable anonymous label, "Player N"
  gender?: string; field?: string; balance: number;
}
interface RoundRow {
  session: string; round: number;
  status: "open" | "closed";
  groups: Record<string, string[]>;
  started_at_ms: number; ends_at_ms: number;
  group_totals?: Record<string, number>;
}
interface ContribRow {
  session: string; round: number; player_id: string;
  name: string; group_id: string; amount: number;
  auto: boolean; submitted_at_ms: number;
  response_ms: number | null;
  payoff?: number; balance_after?: number;
}
interface PunishmentRow {
  session: string; round: number;
  punisher_id: string; target_id: string;
  damage: number; cost: number; submitted_at_ms: number;
}

/* ------------------------------------------------------------
   3. HELPERS
   ------------------------------------------------------------ */
function makeCode(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => a[Math.floor(Math.random() * a.length)]).join("");
}
function shuffle<T>(arr: T[]): T[] {
  const c = [...arr];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c;
}
function makeGroups(ids: string[], mode: GroupMode, size: number): Record<string, string[]> {
  if (mode === "full" || ids.length <= size) return { G1: ids };
  const s = shuffle(ids);
  const n = Math.max(1, Math.round(s.length / size));
  const g: Record<string, string[]> = {};
  for (let i = 0; i < n; i++) g[`G${i + 1}`] = [];
  s.forEach((id, i) => g[`G${(i % n) + 1}`].push(id));
  return g;
}
function groupOf(groups: Record<string, string[]>, pid: string): string {
  for (const [g, ms] of Object.entries(groups)) if (ms.includes(pid)) return g;
  return "G1";
}
const round2 = (x: number) => Math.round(x * 100) / 100;
function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------
   4. ROUND ORCHESTRATION (runs on the admin client)
   ------------------------------------------------------------ */
async function startRound(code: string, r: number, cfg: SessionConfig, prev: Record<string, string[]> | null) {
  const { data: ps } = await sb.from("players").select("id").eq("session", code);
  const ids = (ps ?? []).map((p) => p.id);
  /* The punishment round reuses the previous round's groups so each
     player punishes the same people whose contributions they just saw. */
  const groups = (isPunishRound(cfg, r) || !cfg.regroupEachRound) && prev
    ? prev : makeGroups(ids, cfg.groupMode, cfg.groupSize);

  /* Round 1 seeds every player with the starting endowment. From
     round 2 on, balances carry forward untouched. */
  if (r === 1)
    await sb.from("players").update({ balance: cfg.endowment }).eq("session", code);

  const now = Date.now();
  await sb.from("rounds").upsert({
    session: code, round: r, status: "open", groups,
    started_at_ms: now, ends_at_ms: now + cfg.roundSeconds * 1000,
    group_totals: null,
  });
  await sb.from("sessions").update({ status: "running", current_round: r }).eq("code", code);
}

async function closeRound(code: string, r: number, cfg: SessionConfig) {
  const [{ data: rd }, { data: ps }, { data: cs }] = await Promise.all([
    sb.from("rounds").select("*").eq("session", code).eq("round", r).single(),
    sb.from("players").select("*").eq("session", code),
    sb.from("contributions").select("*").eq("session", code).eq("round", r),
  ]);
  if (!rd || rd.status === "closed") return;
  const round = rd as RoundRow;
  const players: Record<string, PlayerRow> = {};
  (ps ?? []).forEach((p) => (players[p.id] = p as PlayerRow));
  const contribs: Record<string, ContribRow> = {};
  (cs ?? []).forEach((c) => (contribs[c.player_id] = c as ContribRow));

  /* Materialise auto submissions in memory. A player can never
     contribute more than the tokens they currently hold, so the
     auto amount is capped at the current balance. */
  for (const [gid, members] of Object.entries(round.groups)) {
    for (const pid of members) {
      if (!contribs[pid]) {
        const p = players[pid];
        const bal = p?.balance ?? 0;
        const base = cfg.autoSubmitBase === "balance" ? bal : cfg.endowment;
        const amount = Math.min(bal, Math.max(0, Math.round(cfg.autoSubmitFraction * base)));
        contribs[pid] = {
          session: code, round: r, player_id: pid,
          name: p?.name ?? "?", group_id: gid, amount, auto: true,
          submitted_at_ms: Date.now(), response_ms: null,
        };
      }
    }
  }

  /* Group totals and per-member dividend.
     dividend = round( (group total / group size) x multiplier )
     New balance = (tokens the player kept) + dividend.
     "Kept" = balance entering the round minus the contribution,
     so uncontributed tokens carry forward and the dividend is
     added on top. Everything is whole numbers. */
  const totals: Record<string, number> = {};
  for (const [gid, members] of Object.entries(round.groups))
    totals[gid] = members.reduce((s, pid) => s + (contribs[pid]?.amount ?? 0), 0);

  const rows: ContribRow[] = [];
  const balUpdates: { id: string; balance: number }[] = [];
  for (const [gid, members] of Object.entries(round.groups)) {
    const size = members.length || 1;
    const dividend = Math.round((totals[gid] / size) * cfg.multiplier);
    for (const pid of members) {
      const c = contribs[pid];
      const before = players[pid]?.balance ?? 0;
      const kept = before - c.amount;          // tokens not contributed
      const balanceAfter = kept + dividend;     // carry forward + dividend
      rows.push({ ...c, payoff: dividend, balance_after: balanceAfter });
      balUpdates.push({ id: pid, balance: balanceAfter });
    }
  }

  /* Chunked upserts, polite size for the REST endpoint. */
  for (let i = 0; i < rows.length; i += 200)
    await sb.from("contributions").upsert(rows.slice(i, i + 200));

  /* Balances: one update per player. Fine for 150 players. */
  await Promise.all(
    balUpdates.map((u) =>
      sb.from("players").update({ balance: u.balance }).eq("id", u.id).eq("session", code)
    )
  );

  await sb.from("rounds").update({ status: "closed", group_totals: totals })
    .eq("session", code).eq("round", r);

  if (r >= cfg.numRounds && !cfg.punishmentRound)
    await sb.from("sessions").update({ status: "done" }).eq("code", code);
}

/* Resolve the punishment round. Each target loses punishDamage per
   punisher who chose them; each punisher loses punishCost per target.
   Balances floor at 0. Non-submitters auto-abstain (punish no one) but
   can still be punished by others. A per-player marker row is written
   into contributions (amount = points spent, payoff = points lost) so
   the admin feed, submitted count and CSV export all keep working. */
async function closePunishmentRound(code: string, r: number, cfg: SessionConfig) {
  const [{ data: rd }, { data: ps }, { data: pun }, { data: cs }] = await Promise.all([
    sb.from("rounds").select("*").eq("session", code).eq("round", r).single(),
    sb.from("players").select("*").eq("session", code),
    sb.from("punishments").select("*").eq("session", code).eq("round", r),
    sb.from("contributions").select("*").eq("session", code).eq("round", r),
  ]);
  if (!rd || rd.status === "closed") return;
  const round = rd as RoundRow;
  const players: Record<string, PlayerRow> = {};
  (ps ?? []).forEach((p) => (players[p.id] = p as PlayerRow));
  const markers: Record<string, ContribRow> = {};
  (cs ?? []).forEach((c) => (markers[c.player_id] = c as ContribRow));

  const spent: Record<string, number> = {};   // punishCost x targets chosen
  const damage: Record<string, number> = {};   // punishDamage x punishers
  (pun ?? []).forEach((p: any) => {
    spent[p.punisher_id] = (spent[p.punisher_id] ?? 0) + Number(p.cost);
    damage[p.target_id] = (damage[p.target_id] ?? 0) + Number(p.damage);
  });

  const balUpdates: { id: string; balance: number }[] = [];
  const rows: ContribRow[] = [];
  const groupDamage: Record<string, number> = {};
  for (const [gid, members] of Object.entries(round.groups)) {
    let gd = 0;
    for (const pid of members) {
      const before = players[pid]?.balance ?? 0;
      const cost = spent[pid] ?? 0;
      const dmg = damage[pid] ?? 0;
      gd += dmg;
      const after = Math.max(0, before - cost - dmg);
      balUpdates.push({ id: pid, balance: after });
      const m = markers[pid];
      rows.push({
        session: code, round: r, player_id: pid,
        name: players[pid]?.name ?? "?", group_id: gid,
        amount: cost, auto: m ? m.auto : true,
        submitted_at_ms: m?.submitted_at_ms ?? Date.now(),
        response_ms: m?.response_ms ?? null,
        payoff: -dmg, balance_after: after,
      });
    }
    groupDamage[gid] = gd;
  }

  for (let i = 0; i < rows.length; i += 200)
    await sb.from("contributions").upsert(rows.slice(i, i + 200));
  await Promise.all(
    balUpdates.map((u) =>
      sb.from("players").update({ balance: u.balance }).eq("id", u.id).eq("session", code)
    )
  );
  await sb.from("rounds").update({ status: "closed", group_totals: groupDamage })
    .eq("session", code).eq("round", r);
  await sb.from("sessions").update({ status: "done" }).eq("code", code);
}

/* ------------------------------------------------------------
   5. CSV EXPORT
   ------------------------------------------------------------ */
async function exportCsv(code: string) {
  const [{ data: ps }, { data: cs }, { data: pun }, { data: ss }] = await Promise.all([
    sb.from("players").select("*").eq("session", code),
    sb.from("contributions").select("*").eq("session", code).order("round").order("player_id"),
    sb.from("punishments").select("*").eq("session", code),
    sb.from("sessions").select("config").eq("code", code).maybeSingle(),
  ]);
  const cfg = (ss?.config ?? DEFAULT_CONFIG) as SessionConfig;
  const players: Record<string, PlayerRow> = {};
  (ps ?? []).forEach((p) => (players[p.id] = p as PlayerRow));

  /* Aggregate punishment activity per (round, player), both as the
     punisher (targets chosen, points spent) and as a target (times
     punished, points lost). */
  const targets: Record<string, number> = {}, spent: Record<string, number> = {};
  const hits: Record<string, number> = {}, lost: Record<string, number> = {};
  (pun ?? []).forEach((p: any) => {
    const pk = `${p.round}:${p.punisher_id}`, tk = `${p.round}:${p.target_id}`;
    targets[pk] = (targets[pk] ?? 0) + 1; spent[pk] = (spent[pk] ?? 0) + Number(p.cost);
    hits[tk] = (hits[tk] ?? 0) + 1; lost[tk] = (lost[tk] ?? 0) + Number(p.damage);
  });

  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["session","round","round_type","player_id","player_number","name","gender","field_of_study","group_id",
    "contribution","auto_submitted","submitted_at_iso","response_ms","dividend","balance_after",
    "targets_punished","points_spent_punishing","times_punished","points_lost_to_punishment"].join(",");
  const body = (cs ?? []).map((c: any) => {
    const k = `${c.round}:${c.player_id}`;
    const isPun = isPunishRound(cfg, c.round);
    return [
      code, c.round, isPun ? "punishment" : "contribution", c.player_id, players[c.player_id]?.seat ?? "",
      players[c.player_id]?.name ?? c.name,
      players[c.player_id]?.gender ?? "", players[c.player_id]?.field ?? "",
      c.group_id, isPun ? "" : c.amount, c.auto, new Date(Number(c.submitted_at_ms)).toISOString(),
      c.response_ms ?? "", isPun ? "" : (c.payoff ?? ""), c.balance_after ?? "",
      isPun ? (targets[k] ?? 0) : "", isPun ? (spent[k] ?? 0) : "",
      isPun ? (hits[k] ?? 0) : "", isPun ? (lost[k] ?? 0) : "",
    ].map(esc).join(",");
  }).join("\n");
  downloadText(`pgg_${code}.csv`, head + "\n" + body);
}

/* ------------------------------------------------------------
   6. HOOKS
   ------------------------------------------------------------ */
function useNow(tickMs = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), tickMs); return () => clearInterval(t); }, [tickMs]);
  return now;
}

function useSession(code: string | null) {
  const [s, setS] = useState<SessionRow | null>(null);
  useEffect(() => {
    if (!code) return;
    let active = true;
    sb.from("sessions").select("*").eq("code", code).maybeSingle()
      .then(({ data }) => active && data && setS(data as SessionRow));
    const ch = sb.channel(`s:${code}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "sessions", filter: `code=eq.${code}` },
        (p: any) => { if (p.new) setS(p.new as SessionRow); })
      .subscribe();
    return () => { active = false; sb.removeChannel(ch); };
  }, [code]);
  return s;
}

function useRound(code: string | null, r: number | null) {
  const [row, setRow] = useState<RoundRow | null>(null);
  useEffect(() => {
    if (!code || !r) { setRow(null); return; }
    let active = true;
    sb.from("rounds").select("*").eq("session", code).eq("round", r).maybeSingle()
      .then(({ data }) => active && setRow((data as RoundRow) ?? null));
    const ch = sb.channel(`r:${code}:${r}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "rounds", filter: `session=eq.${code}` },
        (p: any) => { const n = p.new as RoundRow | null; if (n && n.round === r) setRow(n); })
      .subscribe();
    return () => { active = false; sb.removeChannel(ch); };
  }, [code, r]);
  return row;
}

function usePlayer(code: string | null, pid: string | null) {
  const [me, setMe] = useState<PlayerRow | null>(null);
  useEffect(() => {
    if (!code || !pid) return;
    let active = true;
    sb.from("players").select("*").eq("session", code).eq("id", pid).maybeSingle()
      .then(({ data }) => active && setMe((data as PlayerRow) ?? null));
    const ch = sb.channel(`me:${code}:${pid}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `id=eq.${pid}` },
        (p: any) => { if (p.new) setMe(p.new as PlayerRow); })
      .subscribe();
    return () => { active = false; sb.removeChannel(ch); };
  }, [code, pid]);
  return me;
}

function useMyContrib(code: string | null, pid: string | null, r: number | null) {
  const [c, setC] = useState<ContribRow | null>(null);
  useEffect(() => {
    setC(null);
    if (!code || !pid || !r) return;
    let active = true;
    sb.from("contributions").select("*")
      .eq("session", code).eq("round", r).eq("player_id", pid).maybeSingle()
      .then(({ data }) => active && setC((data as ContribRow) ?? null));
    const ch = sb.channel(`c:${code}:${r}:${pid}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "contributions",
          filter: `player_id=eq.${pid}` },
        (p: any) => {
          const n = p.new as ContribRow | null;
          if (n && n.session === code && n.round === r) setC(n);
        })
      .subscribe();
    return () => { active = false; sb.removeChannel(ch); };
  }, [code, pid, r]);
  return c;
}

/* Anonymous breakdown of the player's own group for a closed round.
   Returns [{ seat, amount, isMe }] sorted by seat. Names are never
   fetched here, only seat numbers, so the client cannot deanonymise. */
function useGroupBreakdown(
  code: string | null, pid: string | null, round: RoundRow | null
) {
  const [rows, setRows] = useState<{ seat: number; amount: number; isMe: boolean }[]>([]);
  useEffect(() => {
    setRows([]);
    if (!code || !pid || !round || round.status !== "closed") return;
    let active = true;
    const gid = groupOf(round.groups, pid);
    const memberIds = round.groups[gid] ?? [];
    if (memberIds.length === 0) return;
    Promise.all([
      sb.from("players").select("id,seat").in("id", memberIds),
      sb.from("contributions").select("player_id,amount")
        .eq("session", code).eq("round", round.round).in("player_id", memberIds),
    ]).then(([{ data: ps }, { data: cs }]) => {
      if (!active) return;
      const seatOf: Record<string, number> = {};
      (ps ?? []).forEach((p: any) => (seatOf[p.id] = p.seat));
      const amtOf: Record<string, number> = {};
      (cs ?? []).forEach((c: any) => (amtOf[c.player_id] = c.amount));
      const out = memberIds.map((mid) => ({
        seat: seatOf[mid] ?? 0,
        amount: amtOf[mid] ?? 0,
        isMe: mid === pid,
      })).sort((a, b) => a.seat - b.seat);
      setRows(out);
    });
  }, [code, pid, round?.round, round?.status]);
  return rows;
}

/* Targets for the punishment round: the player's own group (minus
   themselves) shown with each member's contribution from prevRound,
   the last contribution round the player just observed. */
function usePunishTargets(
  code: string | null, pid: string | null, round: RoundRow | null, prevRound: number
) {
  const [rows, setRows] = useState<{ id: string; seat: number; amount: number }[]>([]);
  useEffect(() => {
    setRows([]);
    if (!code || !pid || !round) return;
    let active = true;
    const gid = groupOf(round.groups, pid);
    const memberIds = (round.groups[gid] ?? []).filter((x) => x !== pid);
    if (memberIds.length === 0) return;
    Promise.all([
      sb.from("players").select("id,seat").in("id", memberIds),
      sb.from("contributions").select("player_id,amount")
        .eq("session", code).eq("round", prevRound).in("player_id", memberIds),
    ]).then(([{ data: ps }, { data: cs }]) => {
      if (!active) return;
      const seatOf: Record<string, number> = {};
      (ps ?? []).forEach((p: any) => (seatOf[p.id] = p.seat));
      const amtOf: Record<string, number> = {};
      (cs ?? []).forEach((c: any) => (amtOf[c.player_id] = Number(c.amount)));
      setRows(memberIds
        .map((mid) => ({ seat: seatOf[mid] ?? 0, amount: amtOf[mid] ?? 0, id: mid }))
        .sort((a, b) => a.seat - b.seat));
    });
    return () => { active = false; };
  }, [code, pid, round?.round, prevRound]);
  return rows;
}

function useAdminFeed(code: string | null) {
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [contribs, setContribs] = useState<ContribRow[]>([]);
  const chs = useRef<RealtimeChannel[]>([]);
  useEffect(() => {
    if (!code) return;
    let active = true;
    sb.from("players").select("*").eq("session", code)
      .then(({ data }) => active && setPlayers((data ?? []) as PlayerRow[]));
    sb.from("contributions").select("*").eq("session", code)
      .then(({ data }) => active && setContribs((data ?? []) as ContribRow[]));

    const a = sb.channel(`adminp:${code}`).on("postgres_changes",
      { event: "*", schema: "public", table: "players", filter: `session=eq.${code}` },
      (p: any) => {
        setPlayers((cur) => {
          if (p.eventType === "DELETE") return cur.filter((x) => x.id !== p.old?.id);
          if (!p.new) return cur;
          const i = cur.findIndex((x) => x.id === p.new.id);
          if (i === -1) return [...cur, p.new as PlayerRow];
          const n = [...cur]; n[i] = p.new as PlayerRow; return n;
        });
      }).subscribe();
    const b = sb.channel(`adminc:${code}`).on("postgres_changes",
      { event: "*", schema: "public", table: "contributions", filter: `session=eq.${code}` },
      (p: any) => {
        setContribs((cur) => {
          const key = (x: any) => `${x.round}_${x.player_id}`;
          if (p.eventType === "DELETE") return cur.filter((x) => key(x) !== key(p.old));
          if (!p.new) return cur;
          const i = cur.findIndex((x) => key(x) === key(p.new));
          if (i === -1) return [...cur, p.new as ContribRow];
          const n = [...cur]; n[i] = p.new as ContribRow; return n;
        });
      }).subscribe();
    chs.current = [a, b];
    return () => { active = false; chs.current.forEach((c) => sb.removeChannel(c)); chs.current = []; };
  }, [code]);
  return { players, contribs };
}

/* ------------------------------------------------------------
   7. UI ATOMS
   ------------------------------------------------------------ */
const Eyebrow = ({ children }: any) => <div className="eyebrow">{children}</div>;
const Stat = ({ label, value, tone }: any) => (
  <div className={`stat ${tone || ""}`}><span className="stat-v">{value}</span><span className="stat-l">{label}</span></div>
);

function TimerRing({ endsAtMs, totalMs }: { endsAtMs: number; totalMs: number }) {
  const now = useNow(200);
  const left = Math.max(0, endsAtMs - now);
  const frac = Math.min(1, Math.max(0, left / totalMs));
  const urgent = left < 15000;
  const R = 34, C = 2 * Math.PI * R;
  return (
    <div className={`ring ${urgent ? "urgent" : ""}`}>
      <svg viewBox="0 0 80 80" width="80" height="80">
        <circle cx="40" cy="40" r={R} className="ring-bg" />
        <circle cx="40" cy="40" r={R} className="ring-fg"
          strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <div className="ring-num">{Math.ceil(left / 1000)}</div>
    </div>
  );
}

function TokenSplitter({ endowment, value, onChange, disabled }:
  { endowment: number; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="splitter">
      <div className="token-grid" aria-hidden>
        {Array.from({ length: endowment }, (_, i) => (
          <span key={i} className={`token ${i < value ? "fund" : "keep"}`} style={{ transitionDelay: `${i * 8}ms` }} />
        ))}
      </div>
      <input type="range" min={0} max={endowment} step={1} value={value} disabled={disabled}
        style={{ ["--p" as any]: (value / endowment) * 100 }}
        onChange={(e) => onChange(Number(e.target.value))} aria-label="Tokens to the group fund" />
      <div className="split-labels">
        <div><span className="mono big">{endowment - value}</span><span className="lab">you keep</span></div>
        <div className="right"><span className="mono big fundc">{value}</span><span className="lab">to group fund</span></div>
      </div>
    </div>
  );
}

/* Dependency-free SVG charts. Colours come from the CSS variables. */
function LineChart({ points, height = 190 }: { points: { x: number; y: number }[]; height?: number }) {
  const w = 560, pad = 30;
  if (points.length === 0) return null;
  const maxY = Math.max(1, ...points.map((p) => p.y));
  const n = points.length;
  const X = (i: number) => pad + (n <= 1 ? (w - 2 * pad) / 2 : (i / (n - 1)) * (w - 2 * pad));
  const Y = (y: number) => height - pad - (y / maxY) * (height - 2 * pad);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} width="100%" role="img" aria-label="Average contribution per round">
      <line x1={pad} y1={height - pad} x2={w - pad} y2={height - pad} className="axis" />
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} className="axis" />
      {n > 1 && <path d={d} className="line" />}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={X(i)} cy={Y(p.y)} r={4} className="dot" />
          <text x={X(i)} y={height - pad + 16} textAnchor="middle" className="chart-lbl">R{p.x}</text>
          <text x={X(i)} y={Y(p.y) - 9} textAnchor="middle" className="chart-val">{p.y}</text>
        </g>
      ))}
    </svg>
  );
}

function BarChart({ bars, height = 210, suffix = "" }:
  { bars: { label: string; value: number; tone?: string }[]; height?: number; suffix?: string }) {
  const w = Math.max(340, bars.length * 30), pad = 26;
  if (bars.length === 0) return null;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const bw = (w - 2 * pad) / bars.length;
  const showLabels = bars.length <= 28;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} width="100%" role="img" aria-label="Contributions this round">
      <line x1={pad} y1={height - pad} x2={w - pad} y2={height - pad} className="axis" />
      {bars.map((b, i) => {
        const h = (b.value / max) * (height - 2 * pad);
        const x = pad + i * bw;
        return (
          <g key={i}>
            <rect x={x + bw * 0.15} y={height - pad - h} width={bw * 0.7} height={Math.max(0, h)} rx={2}
              fill={b.tone === "me" ? "var(--gold)" : "var(--peri)"} />
            {showLabels && b.value > 0 &&
              <text x={x + bw / 2} y={height - pad - h - 5} textAnchor="middle" className="chart-val">{b.value}{suffix}</text>}
            {showLabels &&
              <text x={x + bw / 2} y={height - pad + 14} textAnchor="middle" className="chart-lbl">{b.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------
   8. PLAYER APP
   ------------------------------------------------------------ */
function PlayerApp() {
  const [code, setCode] = useState<string | null>(localStorage.getItem("pgg_code"));
  const [pid, setPid] = useState<string | null>(localStorage.getItem("pgg_pid"));
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [gender, setGender] = useState("");
  const [field, setField] = useState("");
  const [err, setErr] = useState("");

  const session = useSession(code);
  const round = useRound(code, session?.current_round ?? null);
  const me = usePlayer(code, pid);
  const myContrib = useMyContrib(code, pid, session?.current_round ?? null);
  const breakdown = useGroupBreakdown(code, pid, round);
  const [pick, setPick] = useState(0);
  const [punSel, setPunSel] = useState<string[]>([]);   // chosen target ids
  const [bdSort, setBdSort] = useState<"seat" | "desc" | "asc">("seat");
  const seenRound = useRef(0);

  const cfg0 = session?.config;
  const punishing = !!cfg0 && !!round && isPunishRound(cfg0, round.round);
  const punTargets = usePunishTargets(code, pid, punishing ? round : null, cfg0?.numRounds ?? 0);

  useEffect(() => {
    if (round?.status === "open" && round.round !== seenRound.current) {
      seenRound.current = round.round; setPick(0); setPunSel([]);
    }
  }, [round?.round, round?.status]);

  /* The experimenter ended the session: drop this player's identity and
     return them to the home (role) screen. */
  useEffect(() => {
    if (session?.status === "ended") {
      localStorage.removeItem("pgg_code"); localStorage.removeItem("pgg_pid");
      window.location.reload();
    }
  }, [session?.status]);

  async function join() {
    setErr("");
    const c = codeInput.trim().toUpperCase();
    if (!c || !name.trim()) { setErr("Enter the session code and your name."); return; }
    const { data: s } = await sb.from("sessions").select("status").eq("code", c).maybeSingle();
    if (!s) { setErr("No session found with that code."); return; }
    if (s.status !== "lobby") { setErr("This session has already started."); return; }
    const id = crypto.randomUUID().slice(0, 12);
    const { count } = await sb.from("players")
      .select("id", { count: "exact", head: true }).eq("session", c);
    const seat = (count ?? 0) + 1;
    const { error } = await sb.from("players").insert({
      id, session: c, name: name.trim(), seat,
      gender: gender || null, field: field || null,
    });
    if (error) { setErr(error.message); return; }
    localStorage.setItem("pgg_code", c); localStorage.setItem("pgg_pid", id);
    setCode(c); setPid(id);
  }

  async function submit() {
    if (!code || !pid || !round || round.status !== "open" || myContrib) return;
    const gid = groupOf(round.groups, pid);
    const nowMs = Date.now();
    if (nowMs > round.ends_at_ms) return;
    const stack = Math.max(0, Math.round(me?.balance ?? 0));
    const amount = Math.max(0, Math.min(pick, stack));   // can't spend more than you hold
    const { error } = await sb.from("contributions").insert({
      session: code, round: round.round, player_id: pid,
      name: me?.name ?? "", group_id: gid,
      amount, auto: false, submitted_at_ms: nowMs,
      response_ms: nowMs - round.started_at_ms,
    });
    if (error && !/duplicate/i.test(error.message)) setErr(error.message);
  }

  async function leave() {
    if (code && pid) await sb.from("players").delete().eq("id", pid).eq("session", code);
    localStorage.removeItem("pgg_code"); localStorage.removeItem("pgg_pid");
    setCode(null); setPid(null);
    setCodeInput(""); setName(""); setGender(""); setField(""); setErr("");
  }

  /* Leave mid-game. Unlike the lobby exit this keeps the player's row, so
     the running game's group sizes and the dataset stay intact — any rounds
     they now miss are auto-submitted like a non-responder. They can rejoin. */
  function quitGame() {
    if (!window.confirm("Leave the game? You won't be able to act in the remaining rounds — any you miss are auto-submitted. Your earnings so far are kept.")) return;
    localStorage.removeItem("pgg_code"); localStorage.removeItem("pgg_pid");
    setCode(null); setPid(null);
    setCodeInput(""); setName(""); setGender(""); setField(""); setErr("");
  }
  const leaveBtn = <button className="ghost leave-game" onClick={quitGame}>Leave game</button>;

  async function submitPunishment() {
    if (!code || !pid || !round || round.status !== "open" || myContrib) return;
    if (Date.now() > round.ends_at_ms) return;
    const cfg = session!.config;
    const gid = groupOf(round.groups, pid);
    const nowMs = Date.now();
    const cost = punSel.length * cfg.punishCost;
    // Marker row records the submission and the points spent punishing.
    const { error } = await sb.from("contributions").insert({
      session: code, round: round.round, player_id: pid,
      name: me?.name ?? "", group_id: gid,
      amount: cost, auto: false, submitted_at_ms: nowMs,
      response_ms: nowMs - round.started_at_ms,
    });
    if (error && !/duplicate/i.test(error.message)) { setErr(error.message); return; }
    if (punSel.length) {
      await sb.from("punishments").insert(punSel.map((tid) => ({
        session: code, round: round.round, punisher_id: pid, target_id: tid,
        damage: cfg.punishDamage, cost: cfg.punishCost, submitted_at_ms: nowMs,
      })));
    }
  }

  if (!code || !pid) return (
    <div className="card narrow">
      <Eyebrow>Join session</Eyebrow>
      <h1>Public Goods Game</h1>
      <p className="muted">Enter the code shown by the experimenter.</p>
      <label>Session code<input value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="e.g. K7M2Q" maxLength={5} className="mono" /></label>
      <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></label>
      <div className="row2">
        <label>Gender (optional)
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">Prefer not to say</option><option>Female</option><option>Male</option><option>Other</option>
          </select></label>
        <label>Field of study (optional)<input value={field} onChange={(e) => setField(e.target.value)} placeholder="e.g. Economics" /></label>
      </div>
      {err && <p className="error">{err}</p>}
      <button className="primary" onClick={join}>Join the game</button>
    </div>
  );

  if (!session) return <div className="card narrow"><p>Connecting…</p></div>;

  if (session.status === "ended") return <div className="card narrow center"><p>The session has ended.</p></div>;

  if (session.status === "lobby") return (
    <div className="card narrow center">
      <Eyebrow>Lobby</Eyebrow>
      <h1>You're in, {me?.name?.split(" ")[0]}.</h1>
      <p className="muted">Waiting for the experimenter to start. Keep this screen open.</p>
      <div className="pulse" />
      <button className="ghost" onClick={leave}>Exit lobby</button>
    </div>
  );

  if (session.status === "done") {
    const punMarker = session.config.punishmentRound ? myContrib : null;
    const spent = Math.round(punMarker?.amount ?? 0);
    const lost = punMarker ? Math.max(0, Math.round(-(punMarker.payoff ?? 0))) : 0;
    return (
      <div className="card narrow center">
        <Eyebrow>Session complete</Eyebrow>
        <h1><span className="mono fundc">{Math.round(me?.balance ?? 0)}</span> tokens</h1>
        <p className="muted">Your total earnings over {session.config.numRounds} contribution round{session.config.numRounds === 1 ? "" : "s"}
          {session.config.punishmentRound ? " plus the punishment round" : ""}. Thank you for playing.</p>
        {punMarker && (
          <div className="stats">
            <Stat label="spent punishing" value={spent} />
            <Stat label="lost to punishment" value={lost} tone={lost > 0 ? "gold" : ""} />
          </div>
        )}
      </div>
    );
  }

  const cfg = session.config;
  if (!round) return <div className="card narrow"><p>Preparing round…</p></div>;

  const stack = Math.max(0, Math.round(me?.balance ?? 0)); // tokens I can spend

  /* ---- Punishment round (the appended final round) ---- */
  if (punishing && round.status === "open" && !myContrib) {
    const affordable = Math.floor(stack / cfg.punishCost);
    const cost = punSel.length * cfg.punishCost;
    const toggle = (id: string) => setPunSel((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id)
        : cur.length >= affordable ? cur : [...cur, id]);
    return (
      <div className="card narrow">
        <div className="head-row">
          <div><Eyebrow>Final round · punishment</Eyebrow>
            <h1>Punish free riders?</h1></div>
          <TimerRing endsAtMs={round.ends_at_ms} totalMs={cfg.roundSeconds * 1000} />
        </div>
        <p className="muted">Here is everyone who was in your group last round and what each put in. Tap anyone to dock them {cfg.punishDamage} point{cfg.punishDamage === 1 ? "" : "s"} — it costs you {cfg.punishCost} point{cfg.punishCost === 1 ? "" : "s"} each. You hold {stack}, so you can punish up to {affordable}. No score drops below zero.</p>
        <div className="punish-list">
          {punTargets.map((t) => {
            const on = punSel.includes(t.id);
            const blocked = !on && punSel.length >= affordable;
            return (
              <button key={t.id} type="button" disabled={blocked}
                className={`punish-row ${on ? "on" : ""}`} onClick={() => toggle(t.id)}>
                <span className="bd-name mono">Player {t.seat}</span>
                <span className="punish-meta mono">put in {t.amount}</span>
                <span className="punish-tag">{on ? `−${cfg.punishDamage}` : "punish"}</span>
              </button>
            );
          })}
        </div>
        {punTargets.length === 0 && <p className="muted">No one else is in your group to punish.</p>}
        <button className="primary" onClick={submitPunishment}>
          {punSel.length === 0 ? "Punish no one" : `Punish ${punSel.length} · cost ${cost}`}
        </button>
        {err && <p className="error">{err}</p>}
        <div className="foot mono">you hold {stack} · spending {cost}</div>
        {leaveBtn}
      </div>
    );
  }

  if (punishing && round.status === "open" && myContrib) return (
    <div className="card narrow center">
      <Eyebrow>Final round · punishment</Eyebrow>
      <h1>Locked in.</h1>
      <p className="muted">{myContrib.auto
        ? "The clock beat you, so you punished no one."
        : `You spent ${Math.round(myContrib.amount)} point${Math.round(myContrib.amount) === 1 ? "" : "s"} punishing.`} Waiting for results.</p>
      <TimerRing endsAtMs={round.ends_at_ms} totalMs={cfg.roundSeconds * 1000} />
      {leaveBtn}
    </div>
  );

  if (punishing && round.status === "closed") return (
    <div className="card narrow center">
      <Eyebrow>Punishment results</Eyebrow>
      <h1>Tallying the final scores…</h1>
      <div className="pulse" />
    </div>
  );

  if (round.status === "open" && !myContrib) return (
    <div className="card narrow">
      <div className="head-row">
        <div><Eyebrow>Round {round.round} of {cfg.numRounds}</Eyebrow>
          <h1>You hold {stack} token{stack === 1 ? "" : "s"}</h1></div>
        <TimerRing endsAtMs={round.ends_at_ms} totalMs={cfg.roundSeconds * 1000} />
      </div>
      <p className="muted">Choose how many to put in the group fund. Each member then receives the group's total divided by the group size, times {cfg.multiplier}, rounded to a whole number. Whatever you keep stays in your stack for next round. Miss the clock and {Math.round(cfg.autoSubmitFraction * 100)}% of your share is contributed for you.</p>
      <TokenSplitter endowment={stack} value={Math.min(pick, stack)} onChange={setPick} />
      <button className="primary" onClick={submit}>Lock in {Math.min(pick, stack)} token{Math.min(pick, stack) === 1 ? "" : "s"}</button>
      {err && <p className="error">{err}</p>}
      <div className="foot mono">stack {stack}</div>
      {leaveBtn}
    </div>
  );

  if (round.status === "open" && myContrib) return (
    <div className="card narrow center">
      <Eyebrow>Round {round.round}</Eyebrow>
      <h1>Locked in.</h1>
      <p className="muted">You contributed <span className="mono fundc">{myContrib.amount}</span> tokens{myContrib.auto ? " (auto-submitted)" : ""}. Waiting for the round to close.</p>
      <TimerRing endsAtMs={round.ends_at_ms} totalMs={cfg.roundSeconds * 1000} />
      {leaveBtn}
    </div>
  );

  const gid = pid ? groupOf(round.groups, pid) : "G1";
  const total = round.group_totals?.[gid] ?? 0;
  const members = round.groups[gid]?.length ?? 1;
  const dividend = Math.round((total / members) * cfg.multiplier);
  const fullPool = cfg.groupMode === "full";
  return (
    <div className="card narrow">
      <Eyebrow>Round {round.round} results</Eyebrow>
      <h1>{fullPool ? "The room" : `Group ${gid.replace("G", "")}`} put in <span className="mono fundc">{total}</span></h1>
      <div className="stats">
        <Stat label="you contributed" value={myContrib?.amount ?? "—"} />
        <Stat label="group average" value={Math.round(total / members)} />
        <Stat label="round dividend" value={dividend} tone="gold" />
        <Stat label="your stack" value={Math.round(me?.balance ?? 0)} tone="gold" />
      </div>

      <div className="breakdown">
        <div className="bd-head">
          <span>{fullPool ? "Everyone this round" : "Your group this round"}</span>
          <span className="bd-sort">
            <button className={`sort-btn ${bdSort === "seat" ? "on" : ""}`} onClick={() => setBdSort("seat")}>player</button>
            <button className={`sort-btn ${bdSort === "desc" ? "on" : ""}`} onClick={() => setBdSort("desc")} aria-label="Sort highest first">high → low</button>
            <button className={`sort-btn ${bdSort === "asc" ? "on" : ""}`} onClick={() => setBdSort("asc")} aria-label="Sort lowest first">low → high</button>
          </span>
        </div>
        <div className="bd-list">
          {(bdSort === "seat" ? breakdown
            : [...breakdown].sort((a, b) => bdSort === "desc" ? b.amount - a.amount : a.amount - b.amount)
          ).map((b) => {
            const max = Math.max(1, ...breakdown.map((x) => x.amount));
            return (
              <div key={b.seat} className={`bd-row ${b.isMe ? "me" : ""}`}>
                <span className="bd-name mono">Player {b.seat}{b.isMe ? " (you)" : ""}</span>
                <span className="bd-bar"><span className="bd-fill" style={{ width: `${(b.amount / max) * 100}%` }} /></span>
                <span className="bd-amt mono">{b.amount}</span>
              </div>
            );
          })}
        </div>
        <p className="muted small">Identities are hidden. Player numbers are stable across rounds so you can follow how each one behaves.</p>
      </div>

      {myContrib?.auto && <p className="error">The clock beat you this round, so {Math.round(cfg.autoSubmitFraction * 100)}% of your share was contributed automatically.</p>}
      <p className="muted">{round.round < cfg.numRounds
        ? "The next round will start shortly. Stay on this screen."
        : cfg.punishmentRound
          ? "Next is the punishment round. Stay on this screen."
          : "That was the final round."}</p>
      {leaveBtn}
    </div>
  );
}

/* ------------------------------------------------------------
   9. ADMIN APP
   ------------------------------------------------------------ */
function AdminApp() {
  const [code, setCode] = useState<string | null>(localStorage.getItem("pgg_admin"));
  const [cfg, setCfg] = useState<SessionConfig>(DEFAULT_CONFIG);
  const session = useSession(code);
  const round = useRound(code, session?.current_round ?? null);
  const { players, contribs } = useAdminFeed(code);
  const closing = useRef(false);
  const now = useNow(500);
  const [live, setLive] = useState(false);   // projector / presentation mode

  useEffect(() => {
    if (!code || !session || !round) return;
    if (round.status === "open" && now > round.ends_at_ms + 600 && !closing.current) {
      closing.current = true;
      const cfg = session.config;
      const close = isPunishRound(cfg, round.round)
        ? closePunishmentRound(code, round.round, cfg)
        : closeRound(code, round.round, cfg);
      close.finally(() => (closing.current = false));
    }
  }, [now, code, session, round]);

  async function create() {
    const c = makeCode();
    const { error } = await sb.from("sessions").insert({
      code: c, status: "lobby", current_round: 0, config: cfg,
    });
    if (error) { alert(error.message); return; }
    localStorage.setItem("pgg_admin", c); setCode(c);
  }
  const set = (k: keyof SessionConfig, v: any) => setCfg({ ...cfg, [k]: v });

  /* Return the experimenter to the home (role) screen, leaving the
     session untouched so connected participants stay where they are. */
  function goHome() {
    localStorage.removeItem("pgg_admin");
    window.location.reload();
  }
  /* End the session for everyone: mark it ended (participants see this via
     realtime and return to the home screen), then go home ourselves. */
  async function endSession() {
    if (!code) return;
    if (!window.confirm("End the session for everyone? All participants will be sent back to the home page.")) return;
    await sb.from("sessions").update({ status: "ended" }).eq("code", code);
    goHome();
  }

  if (!code) return (
    <div className="card">
      <Eyebrow>Experimenter console</Eyebrow>
      <h1>Create a session</h1>
      <div className="grid3">
        <label>Rounds (4–10)<input type="number" min={4} max={10} value={cfg.numRounds}
          onChange={(e) => set("numRounds", Math.max(4, Math.min(10, +e.target.value)))} /></label>
        <label>Grouping
          <select value={cfg.groupMode} onChange={(e) => set("groupMode", e.target.value as GroupMode)}>
            <option value="groups">Random groups of 4–15</option>
            <option value="full">One full pool (everyone)</option>
          </select></label>
        <label>Group size (4–15)<input type="number" min={4} max={15} value={cfg.groupSize}
          disabled={cfg.groupMode === "full"}
          onChange={(e) => set("groupSize", Math.max(4, Math.min(15, +e.target.value)))} /></label>
        <label>Tokens per player (1–20)<input type="number" min={1} max={20} value={cfg.endowment}
          onChange={(e) => set("endowment", Math.max(1, Math.min(20, +e.target.value)))} /></label>
        <label>Dividend multiplier (0.1–2)<input type="number" step={0.1} min={0.1} max={2} value={cfg.multiplier}
          onChange={(e) => set("multiplier", Math.max(0.1, Math.min(2, +e.target.value)))} /></label>
        <label>Round timer (seconds)<input type="number" min={15} value={cfg.roundSeconds}
          onChange={(e) => set("roundSeconds", +e.target.value)} /></label>
        <label>Auto-submit fraction<input type="number" step={0.05} min={0} max={1} value={cfg.autoSubmitFraction}
          onChange={(e) => set("autoSubmitFraction", +e.target.value)} /></label>
        <label>Auto-submit base
          <select value={cfg.autoSubmitBase} onChange={(e) => set("autoSubmitBase", e.target.value as AutoBase)}>
            <option value="endowment">Half of round endowment</option>
            <option value="balance">Half of total balance (capped)</option>
          </select></label>
        <label>Regroup each round
          <select value={String(cfg.regroupEachRound)} onChange={(e) => set("regroupEachRound", e.target.value === "true")}>
            <option value="true">Yes (stranger matching)</option>
            <option value="false">No (fixed groups)</option>
          </select></label>
        <label>Punishment round
          <select value={String(cfg.punishmentRound)} onChange={(e) => set("punishmentRound", e.target.value === "true")}>
            <option value="true">Yes (appended final round)</option>
            <option value="false">No</option>
          </select></label>
        <label>Punish: cost to target<input type="number" min={0} value={cfg.punishDamage}
          disabled={!cfg.punishmentRound}
          onChange={(e) => set("punishDamage", Math.max(0, +e.target.value))} /></label>
        <label>Punish: cost to you<input type="number" min={0} value={cfg.punishCost}
          disabled={!cfg.punishmentRound}
          onChange={(e) => set("punishCost", Math.max(1, +e.target.value))} /></label>
      </div>
      <p className="muted">Tokens carry forward. Round 1 seeds every player with the starting tokens; from then on a player can contribute up to whatever they currently hold. Each round a player's group earns its total contribution divided by group size, times the multiplier, rounded to a whole number. A multiplier above 1 makes the group fund grow the pie; below 1 it shrinks it.{cfg.punishmentRound ? ` A final punishment round is appended: players see their last group's anonymous contributions and may dock ${cfg.punishDamage} point(s) from anyone, paying ${cfg.punishCost} each. Scores floor at zero.` : ""}</p>
      <button className="primary" onClick={create}>Create session</button>
    </div>
  );

  if (!session) return <div className="card"><p>Loading…</p></div>;
  const conf = session.config;
  const r = session.current_round;
  const roundContribs = contribs.filter((c) => c.round === r);
  const submitted = roundContribs.length;

  const totalRounds = lastRoundNum(conf);
  const punRound = isPunishRound(conf, r);
  const seatOf: Record<string, number> = {};
  players.forEach((p) => (seatOf[p.id] = p.seat));

  /* Average contribution per contribution round, for the trend line. */
  const avgPoints: { x: number; y: number }[] = [];
  for (let rr = 1; rr <= conf.numRounds; rr++) {
    const cs = contribs.filter((c) => c.round === rr);
    if (cs.length) avgPoints.push({ x: rr, y: Math.round(cs.reduce((s, c) => s + Number(c.amount), 0) / cs.length) });
  }
  /* Per-player bars for the current round, anonymised and sorted high→low.
     Revealed only once the round closes, so on-screen data never biases
     players who are still deciding. On the punishment round the bar shows
     points each player lost to punishment. */
  const revealRound = !!round && round.status === "closed";
  const roundBars = revealRound
    ? roundContribs.map((c) => ({
        label: `P${seatOf[c.player_id] ?? "?"}`,
        value: punRound ? Math.max(0, -(Number(c.payoff) || 0)) : Number(c.amount),
      })).sort((a, b) => b.value - a.value)
    : [];
  const barTitle = punRound ? "Points lost to punishment, by player" : "Contributions this round, by player";
  const headline = session.status === "lobby" ? "Lobby open" :
    session.status === "done" ? "Session complete" :
      punRound ? "Punishment round" : `Round ${r} of ${conf.numRounds}`;

  /* Live / projector mode: large, anonymised, chart-forward. */
  if (live) return (
    <div className="present">
      <div className="present-top">
        <div>
          <div className="present-code mono">{code}</div>
          <div className="present-title">{headline}</div>
        </div>
        <div className="present-stats">
          <div className="present-stat"><b>{players.length}</b><span>players</span></div>
          {session.status === "running" && round?.status === "open" && (
            <><div className="present-stat"><b>{submitted}/{players.length}</b><span>submitted</span></div>
              <TimerRing endsAtMs={round.ends_at_ms} totalMs={conf.roundSeconds * 1000} /></>
          )}
          <button className="ghost present-exit" onClick={() => setLive(false)}>Exit live view</button>
        </div>
      </div>
      {session.status === "running" && round?.status === "open" && (
        <div className="present-wait">
          <div className="present-big mono">{submitted}<span> / {players.length}</span></div>
          <p className="muted">Locked in so far. The breakdown appears here the moment the round closes.</p>
        </div>
      )}
      {avgPoints.length > 0 && (
        <div className="chart-card big">
          <div className="bd-head"><span>Average contribution per round</span></div>
          <LineChart points={avgPoints} height={260} />
        </div>
      )}
      {roundBars.length > 0 && (
        <div className="chart-card big">
          <div className="bd-head"><span>{barTitle}</span><span className="mono dim">anonymous · {roundBars.length}</span></div>
          <BarChart bars={roundBars} height={300} />
        </div>
      )}
      {session.status === "done" && avgPoints.length === 0 && roundBars.length === 0 && (
        <p className="muted">No round data yet.</p>
      )}
    </div>
  );

  return (
    <div className="card wide">
      <div className="admin-head">
        <div>
          <Eyebrow>Session {code}</Eyebrow>
          <h1>{headline}</h1>
        </div>
        <div className="head-stats">
          <Stat label="players" value={players.length} />
          {session.status === "running" && round?.status === "open" && (
            <><Stat label="submitted" value={`${submitted}/${players.length}`} />
              <TimerRing endsAtMs={round.ends_at_ms} totalMs={conf.roundSeconds * 1000} /></>
          )}
        </div>
      </div>

      {session.status === "lobby" && (
        <>
          <p className="joincode mono">{code}</p>
          <p className="muted">Players join with this code. {players.length} joined so far.</p>
          <button className="primary" disabled={players.length < 2}
            onClick={() => startRound(code, 1, conf, null)}>Start round 1</button>
        </>
      )}

      {session.status === "running" && round?.status === "closed" && r < totalRounds && (
        <button className="primary" onClick={() => startRound(code, r + 1, conf, round.groups)}>
          {isPunishRound(conf, r + 1) ? "Start punishment round" : `Start round ${r + 1}`}
        </button>
      )}

      {session.status !== "lobby" && (
        <button className="ghost" onClick={() => setLive(true)}>Live view (projector)</button>
      )}
      {(session.status === "done" || contribs.length > 0) && (
        <button className="ghost" onClick={() => exportCsv(code)}>Download data (CSV)</button>
      )}
      {session.status === "done" && (
        <button className="ghost" onClick={goHome}>Return to home page</button>
      )}
      {session.status !== "done" && (
        <button className="ghost danger" onClick={endSession}>End session</button>
      )}

      {(avgPoints.length > 0 || roundBars.length > 0) && (
        <div className="charts">
          {avgPoints.length > 0 && (
            <div className="chart-card">
              <div className="bd-head"><span>Average contribution per round</span></div>
              <LineChart points={avgPoints} />
            </div>
          )}
          {roundBars.length > 0 && (
            <div className="chart-card">
              <div className="bd-head"><span>{barTitle}</span><span className="mono dim">anonymous</span></div>
              <BarChart bars={roundBars} />
            </div>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Player</th><th>Group</th><th>This round</th><th>Auto</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {[...players].sort((a, b) => b.balance - a.balance).map((p) => {
              const c = roundContribs.find((x) => x.player_id === p.id);
              const gid = round ? groupOf(round.groups, p.id) : "—";
              return (
                <tr key={p.id}>
                  <td>{p.name}</td><td className="mono">{gid}</td>
                  <td className="mono">{c ? c.amount : session.status === "running" ? "…" : "—"}</td>
                  <td>{c?.auto ? "yes" : ""}</td>
                  <td className="mono num">{Math.round(p.balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------
   10. ROOT + STYLES
   ------------------------------------------------------------ */
export default function App() {
  const [role, setRole] = useState<"none" | "player" | "admin">(
    localStorage.getItem("pgg_admin") ? "admin" :
      localStorage.getItem("pgg_pid") ? "player" : "none");
  return (
    <div className="shell">
      <style>{CSS}</style>
      <header className="topbar">
        <span className="wordmark">PUBLIC GOODS GAME</span>
        <span className="mono dim">contributions · rounds · ledger</span>
      </header>
      {role === "none" && (
        <div className="card narrow center">
          <Eyebrow>Welcome</Eyebrow>
          <h1>Who are you?</h1>
          <button className="primary" onClick={() => setRole("player")}>I'm a player</button>
          <button className="ghost" onClick={() => setRole("admin")}>I'm the experimenter</button>
        </div>
      )}
      {role === "player" && <PlayerApp />}
      {role === "admin" && <AdminApp />}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@400;500;700&family=Spline+Sans+Mono:wght@400;500;700&display=swap');
:root{
  --paper:#EDF0EE; --surface:#FFFFFF; --ink:#14213D; --ink2:#46506B;
  --peri:#6C7FDC; --peri-deep:#4D5FC0; --gold:#A8842B; --alarm:#C2452D;
  --line:#D7DCE0; --radius:14px;
}
*{box-sizing:border-box;margin:0}
body{background:var(--paper)}
.shell{min-height:100vh;background:
  radial-gradient(1100px 500px at 80% -10%, #E2E7F8 0%, transparent 60%), var(--paper);
  font-family:'Familjen Grotesk',sans-serif;color:var(--ink);
  display:flex;flex-direction:column;align-items:center;padding:0 16px 48px}
.topbar{width:100%;max-width:1040px;display:flex;justify-content:space-between;
  align-items:baseline;padding:20px 4px;border-bottom:2px solid var(--ink)}
.wordmark{font-weight:700;letter-spacing:.14em;font-size:13px}
.dim{color:var(--ink2);font-size:11px}
.mono{font-family:'Spline Sans Mono',monospace}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:28px;margin-top:28px;width:100%;max-width:560px;
  box-shadow:0 18px 40px -28px rgba(20,33,61,.35)}
.card.wide{max-width:1040px}.card.narrow{max-width:440px}
.center{text-align:center}
h1{font-size:clamp(22px,4vw,30px);font-weight:700;line-height:1.15;margin:6px 0 10px}
.eyebrow{font-family:'Spline Sans Mono',monospace;font-size:11px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--peri-deep)}
.muted{color:var(--ink2);font-size:14px;line-height:1.5;margin-bottom:14px}
.error{color:var(--alarm);font-size:13px;margin:8px 0}
label{display:block;font-size:12px;font-weight:500;color:var(--ink2);margin:10px 0}
input,select{width:100%;margin-top:5px;padding:10px 12px;font-size:15px;color:var(--ink);
  border:1px solid var(--line);border-radius:8px;background:#FBFCFB;font-family:inherit}
input:focus,select:focus{outline:2px solid var(--peri);border-color:var(--peri)}
button{font-family:inherit;font-size:15px;font-weight:700;border-radius:10px;cursor:pointer;
  padding:13px 18px;width:100%;margin-top:10px;transition:transform .08s}
button:active{transform:scale(.985)}
button:disabled{opacity:.45;cursor:not-allowed}
.primary{background:var(--ink);color:#fff;border:none}
.primary:hover:not(:disabled){background:var(--peri-deep)}
.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:0 14px}
@media(max-width:640px){.grid3{grid-template-columns:1fr}}
.head-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.admin-head{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px}
.head-stats{display:flex;gap:18px;align-items:center}
.joincode{font-size:clamp(40px,9vw,64px);font-weight:700;letter-spacing:.18em;
  color:var(--peri-deep);margin:6px 0}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:14px 0}
.stat{border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column}
.stat-v{font-family:'Spline Sans Mono',monospace;font-size:24px;font-weight:700}
.stat-l{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);margin-top:2px}
.stat.gold .stat-v{color:var(--gold)}
.splitter{margin:18px 0 6px}
.token-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;margin-bottom:14px}
.token{aspect-ratio:1;border-radius:5px;background:var(--ink);transition:background .25s,transform .25s}
.token.fund{background:var(--peri);transform:translateY(-3px)}
input[type=range]{appearance:none;height:6px;border-radius:3px;padding:0;border:none;
  background:linear-gradient(to right,var(--peri) 0%,var(--peri) calc(var(--p,0)*1%),var(--line) 0)}
input[type=range]::-webkit-slider-thumb{appearance:none;width:26px;height:26px;border-radius:50%;
  background:var(--ink);border:3px solid #fff;box-shadow:0 2px 8px rgba(20,33,61,.4);cursor:grab}
.split-labels{display:flex;justify-content:space-between;margin-top:10px}
.split-labels .right{text-align:right}
.big{font-size:30px;font-weight:700;display:block}
.fundc{color:var(--peri-deep)}
.lab{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2)}
.ring{position:relative;width:80px;height:80px;flex:none}
.ring svg{transform:rotate(-90deg)}
.ring-bg{fill:none;stroke:var(--line);stroke-width:6}
.ring-fg{fill:none;stroke:var(--peri-deep);stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset .2s linear}
.ring.urgent .ring-fg{stroke:var(--alarm)}
.ring-num{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:'Spline Sans Mono',monospace;font-weight:700;font-size:20px}
.ring.urgent .ring-num{color:var(--alarm);animation:tick 1s steps(1) infinite}
@keyframes tick{50%{opacity:.55}}
.pulse{width:14px;height:14px;border-radius:50%;background:var(--peri);margin:18px auto 0;
  animation:pulse 1.6s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(108,127,220,.5)}100%{box-shadow:0 0 0 22px rgba(108,127,220,0)}}
.table-wrap{margin-top:20px;max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{position:sticky;top:0;background:var(--ink);color:#fff;text-align:left;padding:9px 12px;
  font-size:11px;letter-spacing:.08em;text-transform:uppercase}
td{padding:8px 12px;border-top:1px solid var(--line)}
td.num,th.num{text-align:right}
.foot{margin-top:12px;font-size:12px;color:var(--ink2);text-align:center}
.small{font-size:12px;margin-top:8px}
.breakdown{margin:18px 0 6px;border:1px solid var(--line);border-radius:10px;padding:14px}
.bd-head{display:flex;justify-content:space-between;align-items:baseline;
  font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2);margin-bottom:10px}
.bd-list{display:flex;flex-direction:column;gap:6px}
.bd-row{display:grid;grid-template-columns:120px 1fr 34px;align-items:center;gap:10px}
.bd-row.me .bd-name{color:var(--peri-deep);font-weight:700}
.bd-row.me .bd-fill{background:var(--gold)}
.bd-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bd-bar{height:10px;background:var(--line);border-radius:5px;overflow:hidden}
.bd-fill{display:block;height:100%;background:var(--peri);border-radius:5px;transition:width .4s}
.bd-amt{font-size:13px;font-weight:700;text-align:right}
@media(max-width:420px){.bd-row{grid-template-columns:96px 1fr 28px}}
/* breakdown sort control */
.bd-sort{display:flex;gap:4px}
.sort-btn{width:auto;margin:0;padding:4px 9px;font-size:11px;font-weight:600;border-radius:7px;
  background:transparent;border:1px solid var(--line);color:var(--ink2)}
.sort-btn.on{background:var(--ink);color:#fff;border-color:var(--ink)}
/* charts */
.charts{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:20px}
@media(max-width:760px){.charts{grid-template-columns:1fr}}
.chart-card{border:1px solid var(--line);border-radius:10px;padding:14px}
.chart{display:block;margin-top:8px;overflow:visible}
.chart .axis{stroke:var(--line);stroke-width:1}
.chart .line{fill:none;stroke:var(--peri-deep);stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.chart .dot{fill:var(--peri-deep)}
.chart-lbl{fill:var(--ink2);font-size:10px;font-family:'Spline Sans Mono',monospace}
.chart-val{fill:var(--ink);font-size:10px;font-weight:700;font-family:'Spline Sans Mono',monospace}
/* punishment picker */
.punish-list{display:flex;flex-direction:column;gap:8px;margin:8px 0 14px}
.punish-row{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:10px;width:100%;
  margin:0;padding:11px 13px;text-align:left;background:#FBFCFB;border:1px solid var(--line);border-radius:10px;font-weight:500}
.punish-row .bd-name{font-size:14px}
.punish-meta{font-size:12px;color:var(--ink2)}
.punish-tag{font-family:'Spline Sans Mono',monospace;font-size:12px;font-weight:700;color:var(--ink2);
  border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.punish-row.on{border-color:var(--alarm);background:#FBEFEC}
.punish-row.on .punish-tag{color:#fff;background:var(--alarm);border-color:var(--alarm)}
.punish-row:disabled{opacity:.5}
.leave-game{margin-top:18px;font-size:13px;font-weight:600;color:var(--ink2);padding:9px 14px}
.ghost.danger{color:var(--alarm);border-color:var(--alarm)}
.ghost.danger:hover{background:var(--alarm);color:#fff}
/* live / projector view */
.present{width:100%;max-width:1100px;margin-top:24px;display:flex;flex-direction:column;gap:18px}
.present-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  border-bottom:2px solid var(--ink);padding-bottom:14px;flex-wrap:wrap}
.present-code{font-size:clamp(28px,6vw,52px);font-weight:700;letter-spacing:.16em;color:var(--peri-deep)}
.present-title{font-size:clamp(20px,3vw,30px);font-weight:700;margin-top:2px}
.present-stats{display:flex;align-items:center;gap:22px}
.present-stat{display:flex;flex-direction:column;align-items:flex-start}
.present-stat b{font-family:'Spline Sans Mono',monospace;font-size:clamp(22px,3vw,32px)}
.present-stat span{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2)}
.present-exit{width:auto;margin:0;padding:9px 14px;font-size:13px}
.present-wait{text-align:center;padding:30px 0}
.present-big{font-size:clamp(56px,14vw,140px);font-weight:700;line-height:1;color:var(--peri-deep)}
.present-big span{color:var(--ink2);font-size:.4em}
.present .chart-card{padding:20px}
.present .chart-lbl{font-size:13px}.present .chart-val{font-size:13px}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
