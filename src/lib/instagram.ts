import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execute, query } from "@/lib/db";
import { notifyPhone } from "@/lib/notify";

// Instagram auto-DM (the "comment a word, get the link in DM" feature of tools like ManyChat): Meta calls our webhook for every
// new comment; a comment containing a rule's keyword gets a private reply (a DM tied to that comment) and,
// optionally, a short public answer under the comment. Uses the Instagram API with Instagram Login.

// IG_GRAPH_BASE points both hosts at a local stand-in for tests; it is never set in production.
const GRAPH = process.env.IG_GRAPH_BASE || "https://graph.instagram.com/v23.0";
const KEY = "instagram";

// ---------- follow checks (follow-gated rules) ----------
// Asking Instagram "does this person follow?" is the slowest call there is, and on a busy reel it is the one that
// fills Meta's hourly allowance and keeps the link waiting. So by default it is never asked:
// PRECHECK_FOLLOW: when a comment comes in. Everyone gets the "follow me" message with the button first (a follow
//   remembered from an earlier check still skips the button, without a call to Meta).
// ASK_ON_TAP: when the "Takip ettim" button is tapped. Off, the tap itself is enough and the link goes at once.
// Set either to true to ask Instagram again at that step.
const PRECHECK_FOLLOW = false;
const ASK_ON_TAP = false;

export type IgSettings = {
  /** long-lived Instagram user token (60 days, refreshed here before it runs out) */
  token?: string;
  tokenSavedAt?: string;
  tokenExpiresAt?: string;
  /** which Graph host accepted the token when it was saved */
  host?: "instagram" | "facebook";
  /** the professional account's id as webhooks name it, and its @username */
  userId?: string;
  username?: string;
  /** "Instagram app secret" from the app's Instagram API setup page: checks that a webhook call comes from Meta */
  appSecret?: string;
  /** what we answer Meta's webhook check with; made once here and pasted into the Meta app */
  verifyToken?: string;
  /** when each kind of alert was last sent, so a problem is reported once, not on every comment */
  alerts?: Record<string, string>;
  /** the Facebook Page's own token, read with the saved token (see withPageToken); calls go out with it */
  pageToken?: string;
  /** what the last look for the Page token found, shown in the panel */
  pageNote?: string;
  pageCheckedAt?: string;
  /** the saved token is Facebook-side and may come from Meta's login dialog: exchanged for a long-lived one first */
  tokenShort?: boolean;
  /** a second Facebook-side token that sees the Page (the saved one does not): only the Page's token is read with it */
  pageSource?: string;
  pageSourceShort?: boolean;
};

export type IgRule = {
  id: number;
  keywords: string;
  /** the one post this rule answers on; empty = every post */
  media_id: string;
  /** that post's link as shown in the panel; empty when the rule is for every post */
  media_url: string;
  dm_text: string;
  reply_text: string;
  active: number;
  sent_count: number;
  /** 1 = the link goes only to followers: the first DM asks to follow and offers a "followed" button */
  follow_gate: number;
  /** the first DM of a follow-gated rule; empty = the default text */
  gate_text: string;
};

export const DEFAULT_GATE_TEXT =
  "Selam! 🙌 Linki göndermem için önce hesabımı takip et. Takip ettikten sonra buraya dönüp aşağıdaki \"Takip ettim ✅\" butonuna dokun, link hemen gelsin 👇";
/** the public answer under the comment when a rule leaves its own empty; one of these is picked at random */
export const DEFAULT_REPLY_TEXT = "DM'den gönderdim 🙌 | Gönderdim, mesajlarına bak 📩 | Linki DM'ine attım 🙌";
const GATE_BUTTON = "Takip ettim ✅";
const NOT_YET_TEXT = "Henüz takip etmiyorsun gibi görünüyor 🙂 Takip ettikten sonra butona tekrar dokun 👇";
/** after this many "not following yet" answers we stop replying to that person's taps */
const MAX_GATE_TRIES = 5;

/** The message with a "followed" quick-reply button; the payload ties the tap back to the comment's row. */
const gateMessage = (text: string, eventId: number) => ({
  text,
  quick_replies: [{ content_type: "text", title: GATE_BUTTON, payload: `IGF:${eventId}` }],
});
/** Plain-text fallback for when Instagram refuses the button in a private reply. */
const gatePlain = (text: string) => ({ text: `${text.replace(/\s*👇\s*$/, "")}\n\nTakip ettikten sonra bu mesaja "tamam" yazman yeterli.` });

export type IgEvent = {
  id: number;
  comment_id: string;
  rule_id: number | null;
  username: string;
  comment_text: string;
  /**
   * sending (being sent now), sent, retry (waiting in the queue), gated (waits for a follow), tapped ("followed" was
   * tapped, the link waits in the queue), skipped, failed
   */
  status: string;
  error: string;
  next_try_at: Date | null;
  replied: number;
  created_at: Date;
};

export async function readIg(): Promise<IgSettings> {
  const [row] = await query<{ data: string }>("SELECT data FROM settings WHERE key = ?", [KEY]);
  let s: IgSettings = {};
  try {
    s = row ? JSON.parse(row.data) : {};
  } catch {}
  if (!s.verifyToken) {
    s.verifyToken = randomBytes(18).toString("base64url");
    await writeIg(s);
  }
  return s;
}

export async function writeIg(s: IgSettings) {
  await execute("INSERT INTO settings (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data", [KEY, JSON.stringify(s)]);
}

type GraphError = { error?: { message?: string; code?: number } };

// Two kinds of token work: an Instagram-login token (60 days) talks to graph.instagram.com; a token from Facebook
// login (a system-user token that never expires, or a page token) talks to graph.facebook.com. Which one a token
// belongs to is found out when it is saved (both are tried) and kept in the settings.
export type IgHost = "instagram" | "facebook";
const HOSTS: Record<IgHost, string> = { instagram: GRAPH, facebook: GRAPH.replace("graph.instagram.com", "graph.facebook.com") };
const guessHost = (token: string): IgHost => (token.startsWith("IG") ? "instagram" : "facebook");
const isInstagramToken = (token: string) => guessHost(token) === "instagram";

/** Tokens pasted from Meta's dialogs sometimes carry spaces, line breaks, quotes or a "Bearer " prefix. */
export const cleanToken = (t: string) => t.replace(/^\s*bearer\s+/i, "").replace(/[\s"'`]/g, "");

async function graph<T>(path: string, init: RequestInit & { token: string; host?: IgHost }): Promise<T> {
  const { token, host, ...rest } = init;
  const startedAt = Date.now();
  const res = await fetch(`${HOSTS[host ?? guessHost(token)]}${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...rest.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const usage = readUsage(res);
  if (usage) await recordUsage(usage).catch(() => {});
  tally(path, rest.method, Date.now() - startedAt, res, PAGE_TOKENS.has(token));
  const text = await res.text();
  let data: T & GraphError & { _raw?: string };
  try {
    const parsed = JSON.parse(text);
    data = parsed && typeof parsed === "object" ? parsed : ({ _raw: text.slice(0, 200) } as never);
  } catch {
    data = { _raw: text.slice(0, 200) } as never;
  }
  if (!res.ok || data.error) throw new GraphFail(data.error?.message ?? `Instagram ${res.status}: ${text.slice(0, 200)}`, data.error?.code, res.status);
  return data;
}

// What this hour's calls were for, how long Meta took to answer them, which token they carried and the highest
// reading of each of Meta's meters. In memory only (on globalThis, so every copy of this module counts in one
// place): a restart starts the count again.
export type CallTally = Record<string, { n: number; ms: number; page: number; user: number; app: number; buc: number; appSeen: number; bucSeen: number }>;
const T = ((globalThis as unknown as { __igTally?: { hour: number; now: CallTally } }).__igTally ??= { hour: -1, now: {} });
/** the highest value in a usage header (a JSON object, or for the business header lists of objects per account) */
function headerPeak(h: string | null): number | null {
  if (!h) return null;
  let peak = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "number" && /call_count|total_cputime|total_time/.test(k)) peak = Math.max(peak, x);
        else walk(x);
      }
  };
  try {
    walk(JSON.parse(h));
  } catch {
    return null;
  }
  return peak;
}
function tally(path: string, method: string | undefined, ms: number, res?: Response, viaPageToken?: boolean) {
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== T.hour) {
    T.hour = hour;
    T.now = {};
  }
  const kind = path.includes("/messages")
    ? "DM"
    : path.includes("/replies")
      ? "açık cevap"
      : path.includes("is_user_follow_business")
        ? "takip sorgusu"
        : path.includes("/comments")
          ? "yorum okuma"
          : path.includes("/media")
            ? "gönderi listesi"
            : method === "POST"
              ? "diğer (yazma)"
              : "diğer";
  const t = (T.now[kind] ??= { n: 0, ms: 0, page: 0, user: 0, app: 0, buc: 0, appSeen: 0, bucSeen: 0 });
  t.n++;
  t.ms += ms;
  if (viaPageToken) t.page++;
  else t.user++;
  const app = headerPeak(res?.headers.get("x-app-usage") ?? null);
  const buc = headerPeak(res?.headers.get("x-business-use-case-usage") ?? null);
  if (app !== null) {
    t.appSeen++;
    t.app = Math.max(t.app, app);
  }
  if (buc !== null) {
    t.bucSeen++;
    t.buc = Math.max(t.buc, buc);
  }
}
/** This clock hour's calls to Meta by kind, since the last restart. */
export const callTally = (): CallTally => (Math.floor(Date.now() / 3_600_000) === T.hour ? T.now : {});
/** tokens handed out as the Page's, so graph() can tell which kind went with a call */
const PAGE_TOKENS = ((globalThis as unknown as { __igPageTokens?: Set<string> }).__igPageTokens ??= new Set<string>());

// ---------- Meta's usage meter ----------
// Every Graph answer carries how much of the app's hourly allowance is used, in percent: X-App-Usage (app level) and
// X-Business-Use-Case-Usage (per account, with the minutes until access comes back once it hits 100). The highest of
// each per hour is kept for the panel's meter, the same numbers Meta's own rate-limit page draws.
type UsageSample = { calls: number; cpu: number; time: number; regainMin: number };
type UsageEntry = { call_count?: number; total_cputime?: number; total_time?: number; estimated_time_to_regain_access?: number };

function readUsage(res: Response): UsageSample | null {
  const out: UsageSample = { calls: 0, cpu: 0, time: 0, regainMin: 0 };
  let seen = false;
  const take = (u: UsageEntry) => {
    out.calls = Math.max(out.calls, Number(u.call_count) || 0);
    out.cpu = Math.max(out.cpu, Number(u.total_cputime) || 0);
    out.time = Math.max(out.time, Number(u.total_time) || 0);
    out.regainMin = Math.max(out.regainMin, Number(u.estimated_time_to_regain_access) || 0);
    seen = true;
  };
  try {
    const app = res.headers.get("x-app-usage");
    if (app) take(JSON.parse(app) as UsageEntry);
    const buc = res.headers.get("x-business-use-case-usage");
    if (buc) for (const list of Object.values(JSON.parse(buc) as Record<string, UsageEntry[]>)) for (const u of list ?? []) take(u);
  } catch {
    // a header Meta changed the shape of is not worth failing a DM over
  }
  return seen ? out : null;
}

let usageWrittenAt = 0;
let usageWrittenPeak = -1;
let usageHigh: { at: number; u: UsageSample } | null = null;
async function recordUsage(u: UsageSample) {
  // Different calls carry different meters (a refused send shows the full app meter, a comment read right after it
  // an almost empty one). "Now" in the panel is the highest reading of the last ten minutes, so a full meter is not
  // hidden by the next quiet answer.
  const high = Math.max(u.calls, u.cpu, u.time);
  if (usageHigh && Date.now() - usageHigh.at < 600_000 && Math.max(usageHigh.u.calls, usageHigh.u.cpu, usageHigh.u.time) > high) u = usageHigh.u;
  else usageHigh = { at: Date.now(), u };
  // a busy hour makes hundreds of calls: write when the meter rose, otherwise at most every 15 seconds
  const peak = Math.max(u.calls, u.cpu, u.time);
  if (Date.now() - usageWrittenAt < 15_000 && peak <= usageWrittenPeak) return;
  usageWrittenAt = Date.now();
  usageWrittenPeak = peak;
  const v = [u.calls, u.cpu, u.time].map((x) => Math.min(30_000, Math.round(x)));
  await execute(
    `INSERT INTO ig_usage (hour, calls, cpu, time_pct, last_calls, last_cpu, last_time, regain_min, updated_at)
     VALUES (date_trunc('hour', now()), ?, ?, ?, ?, ?, ?, ?, now())
     ON CONFLICT (hour) DO UPDATE SET calls = GREATEST(ig_usage.calls, EXCLUDED.calls), cpu = GREATEST(ig_usage.cpu, EXCLUDED.cpu),
       time_pct = GREATEST(ig_usage.time_pct, EXCLUDED.time_pct), last_calls = EXCLUDED.last_calls, last_cpu = EXCLUDED.last_cpu,
       last_time = EXCLUDED.last_time, regain_min = EXCLUDED.regain_min, updated_at = now()`,
    [...v, ...v, Math.round(u.regainMin)],
  );
  if (Math.random() < 0.02) await execute("DELETE FROM ig_usage WHERE hour < now() - interval '8 days'");
}

export type UsageHour = { hour: string; peak: number; dms: number; replies: number };
/** Meta's latest reading; fresh = taken in the last hour (older readings say nothing about now), agoMin = its age */
export type UsageNow = { calls: number; cpu: number; time: number; regainMin: number; at: string; fresh: boolean; agoMin: number } | null;

/** The meter for the panel: Meta's latest reading, and the last 24 hours hour by hour (Meta's peak, our DMs and answers). */
export async function usageStats(): Promise<{ now: UsageNow; hours: UsageHour[]; tally: CallTally }> {
  const [last] = await query<{ last_calls: number; last_cpu: number; last_time: number; regain_min: number; updated_at: Date }>(
    "SELECT last_calls, last_cpu, last_time, regain_min, updated_at FROM ig_usage ORDER BY hour DESC LIMIT 1",
  );
  const meta = await query<{ h: Date; peak: number }>(
    "SELECT hour AS h, GREATEST(calls, cpu, time_pct) AS peak FROM ig_usage WHERE hour >= date_trunc('hour', now()) - interval '23 hours'",
  );
  const ours = await query<{ h: Date; dms: string; replies: string }>(
    `SELECT date_trunc('hour', sent_at) AS h, COUNT(*) AS dms, SUM(replied) AS replies FROM ig_events
     WHERE sent_at >= date_trunc('hour', now()) - interval '23 hours' GROUP BY 1`,
  );
  const hours: UsageHour[] = [];
  const top = new Date();
  top.setUTCMinutes(0, 0, 0);
  for (let i = 23; i >= 0; i--) {
    const t = top.getTime() - i * 3_600_000;
    const m = meta.find((r) => new Date(r.h).getTime() === t), o = ours.find((r) => new Date(r.h).getTime() === t);
    hours.push({ hour: new Date(t).toISOString(), peak: Number(m?.peak ?? 0), dms: Number(o?.dms ?? 0), replies: Number(o?.replies ?? 0) });
  }
  const at = last ? new Date(last.updated_at) : null;
  return {
    now:
      last && at
        ? {
            calls: Number(last.last_calls),
            cpu: Number(last.last_cpu),
            time: Number(last.last_time),
            regainMin: Number(last.regain_min),
            at: at.toISOString(),
            fresh: Date.now() - at.getTime() < 3_600_000,
            agoMin: Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000)),
          }
        : null,
    hours,
    tally: callTally(),
  };
}

/** A Graph API error with Meta's error code and the HTTP status, so a failed send can be sorted (retry or not). */
export class GraphFail extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

type FailKind = "token" | "retry" | "final";
/** Rate limits, Meta's temporary errors and network problems are retried; a bad token raises an alert. */
function failKind(e: unknown): FailKind {
  if (e instanceof GraphFail) {
    if (e.code === 190 || e.code === 102) return "token";
    // a token that lacks a permission or cannot see the account (codes 10 and 200): the comment waits for a working
    // token instead of being given up on (code 10 also says "outside of the allowed window", which no token fixes)
    if ((e.code === 10 || e.code === 200 || /permission/i.test(e.message)) && !/window|outside/i.test(e.message)) return "token";
    if ([1, 2, 4, 17, 32, 341, 613, 80002, 80006].includes(e.code ?? -1) || (e.status ?? 0) >= 500 || e.status === 429) return "retry";
    if (/rate|limit|temporar|try again|unavailable/i.test(e.message)) return "retry";
    return "final";
  }
  // fetch timeouts and dropped connections
  return "retry";
}

// ---------- Meta's request limit ----------
// When Meta answers "request limit reached", every further call only keeps the meter full: nothing is sent, and the
// calls made while waiting count too. So after such an answer all sending stops for a few minutes (the queue keeps
// the comments, no attempt is spent), and the first send after the pause tests the water. Kept in memory: after a
// restart the first refused call sets it again.
const LIMIT_PAUSE_MIN = 3;
// One shared state for every copy of this module in the build (instrumentation, routes and server actions each get
// their own copy), so a pause or a Page-token change made in one is seen by all.
type SendState = {
  limitedUntil: number;
  /** the Page token was refused (190): calls go with the saved token until a new one is found */
  pageOff: boolean;
  pageAskedAt: number;
  /** the last look for the Page token was refused for the limit: until it gets through, nothing else is sent */
  pageWaits: boolean;
  /** since when; after twelve minutes of refusals sending goes on with the saved token while the look-ups continue */
  pageWaitSince: number;
  /** the queue is being sent right now */
  running: boolean;
};
const G: SendState = ((globalThis as unknown as { __igSend?: SendState }).__igSend ??= {
  limitedUntil: 0,
  pageOff: false,
  pageAskedAt: 0,
  pageWaits: false,
  pageWaitSince: 0,
  running: false,
});
const isRateLimit = (e: unknown) => e instanceof GraphFail && ([4, 17, 32, 613, 80002, 80006].includes(e.code ?? -1) || e.status === 429);
/** Minutes left of the pause after Meta refused a call for the request limit; 0 when sending is open. */
export const metaLimitedMin = () => Math.max(0, Math.ceil((G.limitedUntil - Date.now()) / 60_000));
/** Lifts the pause, for the panel's "send the queue now" button: the next send asks Meta again. */
export function clearMetaPause() {
  G.limitedUntil = 0;
}
function pauseForLimit(min = LIMIT_PAUSE_MIN) {
  G.limitedUntil = Math.max(G.limitedUntil, Date.now() + min * 60_000);
}

// ---------- the Page's token ----------
// Meta counts a call by the kind of token it carries: a Facebook user token goes against the app's own allowance
// (about 200 calls an hour per app user; a busy reel fills it with a few dozen people), a Page token against the far
// larger Instagram limits (about 750 private replies an hour). So when the saved token is Facebook-side and can list
// the Page the Instagram account hangs on, that Page's token is read once and every call goes out with it. If Meta
// refuses the Page token, the saved token takes over again. Instagram-login tokens (IGAA…) are used as they are.
const onPage = (s: IgSettings) => Boolean(s.host !== "instagram" && s.pageToken && !G.pageOff);
/** The token calls go out with: the Page's when there is one, else the saved one. */
const tok = (s: IgSettings) => {
  if (onPage(s)) {
    PAGE_TOKENS.add(s.pageToken!);
    return s.pageToken!;
  }
  return s.token!;
};

/** Looks for the Page token at most every 30 minutes until it is found. */
async function withPageToken(s: IgSettings): Promise<IgSettings> {
  if (s.host === "instagram" || !s.token || !s.userId || s.pageToken) {
    G.pageWaits = false;
    G.pageWaitSince = 0;
    return s;
  }
  if (s.pageCheckedAt && Date.now() - Date.parse(s.pageCheckedAt) < 30 * 60_000) return s;
  // These calls go out even while sending is paused for the limit (they are what gets us off that limit). When Meta
  // refuses one for the limit it is tried again two minutes later, and until it gets through every other call waits:
  // each of them would only keep the app's meter full.
  if (Date.now() - G.pageAskedAt < 2 * 60_000) return s;
  G.pageAskedAt = Date.now();
  const waitForLimit = async (cur: IgSettings) => {
    G.pageWaitSince ||= Date.now();
    G.pageWaits = Date.now() - G.pageWaitSince < 12 * 60_000;
    if (G.pageWaits) pauseForLimit(4);
    const noted: IgSettings = {
      ...cur,
      pageNote: `Sayfa token'ı bekleniyor: Meta sınırı dolu, iki dakikada bir deneniyor (son deneme ${new Date().toLocaleTimeString("tr-TR")}). Alınınca kuyruk hemen gönderilecek.`,
    };
    await writeIg(noted);
    return noted;
  };

  // 1. A token pasted from Meta's login dialog lives an hour or two, and so would a Page token read with it.
  //    Exchanged for a long-lived one first, the Page token read with it does not expire.
  let shortNote = "";
  if ((s.pageSource ? s.pageSourceShort : s.tokenShort) && s.appSecret) {
    try {
      const long = await exchangeToken(s.pageSource ?? s.token, s.appSecret);
      s = s.pageSource ? { ...s, pageSource: long, pageSourceShort: false } : { ...s, token: long, tokenShort: false, tokenSavedAt: new Date().toISOString() };
      await writeIg(s);
    } catch (e) {
      if (isRateLimit(e)) return waitForLimit(s);
      shortNote = ` Uyarı: token uzun ömürlüye çevrilemedi (${(e as Error).message.slice(0, 120)}); sayfa token'ı bir iki saat sonra geçersiz olabilir.`;
      s = s.pageSource ? { ...s, pageSourceShort: false } : { ...s, tokenShort: false };
    }
  }

  // 2. the Page the Instagram account hangs on, and its token
  const next: IgSettings = { ...s, pageCheckedAt: new Date().toISOString() };
  try {
    const pages = await graph<{ data?: { id: string; name?: string; access_token?: string; instagram_business_account?: { id: string } }[] }>(
      "/me/accounts?fields=id,name,access_token,instagram_business_account{id}&limit=100",
      { token: s.pageSource ?? s.token!, host: "facebook" },
    );
    const list = pages.data ?? [];
    const page = list.find((p) => p.access_token && p.instagram_business_account?.id === s.userId);
    G.pageWaits = false;
    G.pageWaitSince = 0;
    if (page) {
      next.pageToken = page.access_token;
      next.pageNote = `İstekler "${page.name ?? page.id}" sayfasının token'ı ile gidiyor (Meta'nın geniş Instagram sınırı).${shortNote}`;
      G.pageOff = false;
      G.limitedUntil = 0;
      // everything that waited goes out now
      await execute("UPDATE ig_events SET next_try_at = now() WHERE status IN ('retry','tapped')");
    } else {
      const seen = list.map((p) => `${p.name ?? p.id}${p.instagram_business_account ? "" : " (Instagram bağlı değil)"}`).join(", ");
      next.pageNote = `Sayfa token'ı alınamadı: ${s.pageSource ? "yapıştırılan token" : "token"} ${list.length} sayfa görüyor${seen ? ` (${seen.slice(0, 150)})` : ""}, hiçbiri bu Instagram hesabına bağlı değil. ${s.pageSource ? "Kayıtlı token değişmedi, gönderim onunla sürüyor." : "İstekler uygulama sınırına yazılıyor."}${shortNote}`;
      // a source that sees no Page is of no use: dropped, the saved token carries on
      next.pageSource = undefined;
      next.pageSourceShort = undefined;
    }
  } catch (e) {
    if (isRateLimit(e)) return waitForLimit(s);
    G.pageWaits = false;
    G.pageWaitSince = 0;
    next.pageNote = `Sayfa token'ı alınamadı: ${(e as Error).message}${s.pageSource ? " Kayıtlı token değişmedi." : ""}${shortNote}`.slice(0, 300);
    next.pageSource = undefined;
    next.pageSourceShort = undefined;
  }
  await writeIg(next);
  return next;
}

/**
 * Exchanges a login-dialog user token for a long-lived one; throws when Meta refuses. The app's id comes from
 * META_APP_ID or, when that is not set, from the token itself.
 */
async function exchangeToken(token: string, secret: string): Promise<string> {
  const appId = process.env.META_APP_ID || (await graph<{ id?: string }>("/app?fields=id", { token, host: "facebook" })).id;
  if (!appId) throw new Error("uygulama kimliği bulunamadı (META_APP_ID)");
  const res = await graph<{ access_token?: string }>(
    `/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(secret)}&fb_exchange_token=${encodeURIComponent(token)}`,
    { token, host: "facebook" },
  );
  if (!res.access_token) throw new Error("Meta uzun ömürlü token vermedi");
  return res.access_token;
}

/** Whether a Facebook-side token lists the Page the Instagram account hangs on ("limited": Meta's request limit refused the question). */
export async function seesPage(token: string, igUserId: string): Promise<"yes" | "no" | "limited"> {
  try {
    const pages = await graph<{ data?: { instagram_business_account?: { id: string } }[] }>("/me/accounts?fields=instagram_business_account{id}&limit=100", {
      token,
      host: "facebook",
    });
    return pages.data?.some((p) => p.instagram_business_account?.id === igUserId) ? "yes" : "no";
  } catch (e) {
    return isRateLimit(e) ? "limited" : "no";
  }
}

/** Looks for the Page token now (after a new token was saved) and returns what was found, for the panel's message. */
export async function findPageTokenNow(): Promise<string> {
  G.pageAskedAt = 0;
  G.pageOff = false;
  G.pageWaitSince = 0;
  const s = await withPageToken(await readIg());
  return s.pageNote ?? "";
}

/** A send with the Page token failed: only a clear refusal of the token (190) sends calls back to the saved token. */
async function pageTokenFailed(s: IgSettings, e: unknown) {
  if (!onPage(s) || isRateLimit(e)) return;
  // a message Meta will not deliver to one person says nothing about the token
  if (!(e instanceof GraphFail && e.code === 190)) return;
  G.pageOff = true;
  const now = await readIg();
  await writeIg({
    ...now,
    pageToken: undefined,
    pageCheckedAt: new Date().toISOString(),
    pageNote: `Sayfa token'ı reddedildi, kayıtlı token'a dönüldü: ${(e as Error).message}`.slice(0, 300),
  });
}

/** Checks a pasted token on both Graph hosts and returns the account it belongs to and the host that accepted it. */
export async function whoAmI(
  token: string,
  knownId?: string,
): Promise<{ userId: string; username: string; host: IgHost; unverified?: boolean; /** the token reads the Instagram account itself */ seesAccount: boolean }> {
  const errors: string[] = [];
  try {
    const me = await graph<{ user_id?: string; id?: string; username?: string }>("/me?fields=user_id,username", { token, host: "instagram" });
    const userId = me.user_id ?? me.id;
    if (userId) return { userId: String(userId), username: me.username ?? "", host: "instagram", seesAccount: true };
    errors.push(`instagram: ${Object.keys(me).join(",") || "boş yanıt"}`);
  } catch (e) {
    errors.push(`instagram: ${(e as Error).message}`);
  }
  try {
    await graph("/me?fields=id,name", { token, host: "facebook" });
  } catch (e) {
    // Meta's request limit says nothing about the token itself: a Facebook-side token for the account we already
    // know is taken as it is, and proves itself on the first call that gets through.
    if (isRateLimit(e) && knownId && !isInstagramToken(token)) return { userId: knownId, username: "", host: "facebook", unverified: true, seesAccount: false };
    errors.push(`facebook: ${(e as Error).message}`);
    throw new Error(errors.join(" | "));
  }
  if (knownId) {
    try {
      const ig = await graph<{ id?: string; username?: string }>(`/${encodeURIComponent(knownId)}?fields=id,username`, { token, host: "facebook" });
      if (ig.id) return { userId: String(ig.id), username: ig.username ?? "", host: "facebook", seesAccount: true };
    } catch {}
  }
  try {
    const pages = await graph<{ data?: { instagram_business_account?: { id: string; username?: string } }[] }>(
      "/me/accounts?fields=instagram_business_account{id,username}",
      { token, host: "facebook" },
    );
    const ig = pages.data?.find((p) => p.instagram_business_account)?.instagram_business_account;
    if (ig) return { userId: ig.id, username: ig.username ?? "", host: "facebook", seesAccount: true };
  } catch {}
  return { userId: knownId ?? "", username: "", host: "facebook", seesAccount: false };
}

/** Fills in the account's id and @username the first time a webhook names it (Facebook-side tokens). */
async function learnAccount(s: IgSettings, accountId: string) {
  if (!accountId || !s.token || s.userId === accountId) return;
  let username = s.username ?? "";
  try {
    username = (await graph<{ username?: string }>(`/${encodeURIComponent(accountId)}?fields=username`, { token: s.token, host: s.host })).username ?? username;
  } catch {}
  await writeIg({ ...s, userId: accountId, username });
}

const DAY = 86_400_000;

/** Days until the token runs out; null for tokens that never expire. */
export const tokenDaysLeft = (s: IgSettings) =>
  s.tokenExpiresAt ? Math.max(0, Math.round((new Date(s.tokenExpiresAt).getTime() - Date.now()) / DAY)) : null;

/** Long-lived tokens last 60 days and can be renewed once they are a day old; renew when under 15 days are left. */
export async function refreshTokenIfDue(s: IgSettings): Promise<IgSettings> {
  if (!s.token || !s.tokenExpiresAt || (s.host ?? guessHost(s.token)) !== "instagram") return s;
  const left = new Date(s.tokenExpiresAt).getTime() - Date.now();
  const age = Date.now() - new Date(s.tokenSavedAt ?? 0).getTime();
  if (left > 15 * DAY || age < DAY) return s;
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(s.token)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number } & GraphError;
  if (!res.ok || !data.access_token) {
    console.error("[instagram] token yenilenemedi:", data.error?.message ?? res.status);
    return s;
  }
  const next = {
    ...s,
    token: data.access_token,
    tokenSavedAt: new Date().toISOString(),
    tokenExpiresAt: new Date(Date.now() + (data.expires_in ?? 60 * 86_400) * 1000).toISOString(),
  };
  await writeIg(next);
  return next;
}

/** Meta signs each webhook body with the app secret (header "x-hub-signature-256: sha256=<hex>"). */
export function validSignature(body: string, header: string | null, secret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  const given = Buffer.from(header.slice(7), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Lower-case the Turkish way and keep only letters, digits and spaces, so "LİNK!", "link" and "Link." all match.
export const normalize = (t: string) =>
  t
    .toLocaleLowerCase("tr")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Edits needed to turn one string into the other: insert, delete, replace, or swap two neighbours. Capped at 2.
function typoDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/**
 * Does the keyword start a word of the (normalized) text? Exactly, so Turkish endings count ("link" → "linki",
 * "linkten"); or, for keywords of five letters or more, with one typo ("animasyon" → "animasiyon"). Short keywords
 * stay exact, so "link" never fires on "like".
 */
export function keywordHit(text: string, keyword: string) {
  if (!keyword) return false;
  if (` ${text}`.includes(` ${keyword}`)) return true;
  if (keyword.length < 5) return false;
  let start = 0;
  for (;;) {
    for (const len of [keyword.length - 1, keyword.length, keyword.length + 1]) {
      const cand = text.slice(start, start + len).trimEnd();
      if (cand.length >= keyword.length - 1 && typoDistance(keyword, cand) <= 1) return true;
    }
    const next = text.indexOf(" ", start);
    if (next < 0) return false;
    start = next + 1;
  }
}

/**
 * The rule a comment triggers; see keywordHit for how a keyword matches. A rule written for that post wins over a
 * rule for every post, so the same word ("link") can send a different link under each video and a general one
 * under the rest.
 */
export function matchRule(rules: IgRule[], text: string, mediaId: string) {
  const words = normalize(text);
  const hits = rules.filter(
    (r) =>
      r.active &&
      (!r.media_id || r.media_id === mediaId) &&
      r.keywords
        .split(",")
        .map(normalize)
        .some((k) => keywordHit(words, k)),
  );
  return hits.find((r) => r.media_id) ?? hits[0];
}

/** The code in a post link: instagram.com/reel/<code>/, /reels/<code>/, /p/<code>/ or /tv/<code>/, with or without the account name before it. */
export const shortcodeOf = (link: string) => /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/i.exec(link)?.[1] ?? "";

/** How many of the account's posts findMedia walks through (newest first), in pages of 100. */
const FIND_MEDIA_PAGES = 20;

/**
 * The id of the account's post behind a link pasted into a rule. The API has no lookup by link, so the account's
 * posts are read newest first until one has that link's code.
 */
export async function findMedia(link: string): Promise<{ id: string; url: string }> {
  const code = shortcodeOf(link);
  if (!code) throw new Error("Bu bir Instagram gönderi linki değil. Reels ya da gönderi linkini yapıştır (instagram.com/reel/…).");
  const s = await refreshTokenIfDue(await readIg());
  if (!s.token) throw new Error("Instagram bağlı değil; önce bağlantıyı kur.");
  const host = s.host ?? guessHost(s.token);
  const owners = [...new Set([host === "instagram" ? "me" : "", s.userId ? encodeURIComponent(s.userId) : ""].filter(Boolean))];
  let lastError = "";
  for (const who of owners) {
    let after = "";
    try {
      for (let page = 0; page < FIND_MEDIA_PAGES; page++) {
        const res = await graph<{ data?: { id: string; permalink?: string }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
          `/${who}/media?fields=id,permalink&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
          { token: s.token, host },
        );
        const hit = res.data?.find((m) => shortcodeOf(m.permalink ?? "") === code);
        if (hit) return { id: String(hit.id), url: hit.permalink ?? link };
        after = res.paging?.next ? (res.paging.cursors?.after ?? "") : "";
        if (!after) break;
      }
      throw new Error("Bu link hesabındaki gönderiler arasında bulunamadı. Kendi videonun linki olduğundan emin ol.");
    } catch (e) {
      lastError = (e as Error).message;
      if (!(e instanceof GraphFail)) break;
    }
  }
  throw new Error(lastError || "Gönderi bulunamadı.");
}

export type CommentChange = {
  id: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
  parent_id?: string;
};

// No caps of our own: Meta allows about 750 private replies an hour per account, and that number is used for both the
// DMs and the public answers. Past it the rest waits in the queue; a refusal from Meta itself pauses sending (see
// pauseForLimit).
export const DM_PER_HOUR = 750;
export const REPLIES_PER_HOUR = 750;
/** One DM per person per rule in this many days, however many times they comment. */
const SAME_PERSON_DAYS = 30;
/** Meta accepts a private reply only within 7 days of the comment. */
const REPLY_WINDOW_DAYS = 7;
/** Wait before each retry (minutes); after the last one the comment is given up. */
const BACKOFF_MIN = [2, 5, 15, 30, 60, 120, 240, 480, 720];
/**
 * A follow Instagram confirmed is remembered this long, so a busy post asks Meta about each person once instead of on
 * every comment. "Not following" is never remembered: after the "follow me" message the next check must be fresh.
 */
const FOLLOW_MEMORY_DAYS = 30;

async function knownFollower(igUserId: string) {
  const [row] = await query("SELECT 1 FROM ig_followers WHERE ig_user_id = ? AND seen_at > now() - make_interval(days => ?)", [
    igUserId.slice(0, 40),
    FOLLOW_MEMORY_DAYS,
  ]);
  return Boolean(row);
}
async function rememberFollower(igUserId: string) {
  await execute("INSERT INTO ig_followers (ig_user_id, seen_at) VALUES (?, now()) ON CONFLICT (ig_user_id) DO UPDATE SET seen_at = now()", [
    igUserId.slice(0, 40),
  ]);
}

type EventRow = IgEvent & { ig_user_id: string; account_id: string; attempts: number; age_days: number };

const EVENT_COLUMNS = `*, EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS age_days`;

/** Handles one new comment from the webhook. Each comment is answered at most once. */
export async function handleComment(accountId: string, c: CommentChange) {
  if (!c.id || !c.text || !c.from?.id) return;
  // our own comments (including the public answers we post) never trigger anything
  if (c.from.id === accountId) return;
  const s = await readIg();
  // only our own account's comments: a signed call about any other account is ignored
  if (s.userId && accountId && accountId !== s.userId) return;
  if (c.from.id === s.userId) return;

  const rules = await query<IgRule>("SELECT * FROM ig_rules WHERE active = 1 ORDER BY id");
  const rule = matchRule(rules, c.text, c.media?.id ?? "");
  if (!rule) return;

  const claimed = await execute<{ id: number }>(
    `INSERT INTO ig_events (comment_id, rule_id, username, ig_user_id, account_id, media_id, comment_text, status, claimed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', now()) ON CONFLICT (comment_id) DO NOTHING RETURNING id`,
    [
      c.id.slice(0, 40),
      rule.id,
      (c.from.username ?? "").slice(0, 100),
      c.from.id.slice(0, 40),
      accountId.slice(0, 40),
      (c.media?.id ?? "").slice(0, 40),
      c.text.slice(0, 500),
    ],
  );
  const eventId = claimed.rows[0]?.id;
  if (!eventId) return;
  // records are kept for at most 90 days (the privacy page says so)
  await execute("DELETE FROM ig_events WHERE created_at < now() - interval '90 days'");
  await execute("DELETE FROM ig_followers WHERE seen_at < now() - make_interval(days => ?)", [FOLLOW_MEMORY_DAYS]);

  // Someone who comments "link" three times gets one DM. Only earlier rows count, so two comments arriving at the
  // same moment cannot both skip each other.
  const sameRecent = (statuses: string) =>
    query<{ id: number; status: string }>(
      `SELECT id, status FROM ig_events WHERE rule_id = ? AND ig_user_id = ? AND id < ? AND status IN (${statuses})
       AND created_at > now() - make_interval(days => ?) LIMIT 1`,
      [rule.id, c.from!.id!.slice(0, 40), eventId, SAME_PERSON_DAYS],
    );
  const [earlier] = await sameRecent("'sent','sending','retry','gated','tapped'");
  if (earlier) {
    // Still waiting for a follow: a new comment (often right after following) gets a fresh private reply, which sends
    // the link straight away if Instagram now reports the follow. The old waiting row steps aside.
    const [other] = earlier.status === "gated" ? await sameRecent("'sent','sending','retry'") : [earlier];
    if (other) return setEvent(eventId, "skipped", "Bu kişiye bu kural için zaten DM gönderildi.");
    await execute("UPDATE ig_events SET status = 'skipped', error = 'Tekrar yorum yaptı, yeni yorumdan devam edildi.' WHERE rule_id = ? AND ig_user_id = ? AND status = 'gated' AND id < ?", [
      rule.id,
      c.from.id.slice(0, 40),
      eventId,
    ]);
  }

  const [row] = await query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM ig_events WHERE id = ?`, [eventId]);
  if (row) await deliver(row, rule);
}

/** Sends the DM (and the public answer) for one claimed event; on a passing problem it goes back to the queue. */
async function deliver(ev: EventRow, rule: IgRule) {
  if (Number(ev.age_days) > REPLY_WINDOW_DAYS - 0.05) return setEvent(ev.id, "failed", "7 gün geçti: Meta bu yoruma artık DM izni vermiyor.");

  // Meta refused a call for the request limit a moment ago: wait it out without spending more calls or an attempt
  const held = () => retry(ev, "Meta'nın istek sınırı dolu, sınır açılınca gönderilecek.", metaLimitedMin() + 1, false);
  let s = await readIg();
  if (metaLimitedMin() && !onPage(s)) return held();

  if (!s.token) return retry(ev, "Instagram bağlı değil (token yok).", 60);
  s = await refreshTokenIfDue(s);
  if (ev.account_id) await learnAccount(s, ev.account_id);
  s = await withPageToken(await readIg());
  const viaPage = onPage(s);
  if (metaLimitedMin() && !viaPage) return held();

  // stay under Meta's hourly cap; the rest waits in the queue (not counted as a failed attempt)
  const [{ n: sentLastHour }] = await query<{ n: string }>("SELECT COUNT(*) AS n FROM ig_events WHERE sent_at > now() - interval '1 hour'");
  if (Number(sentLastHour) >= DM_PER_HOUR) {
    await alert("busy", `Instagram DM: son 1 saatte ${DM_PER_HOUR} DM sınırına ulaşıldı. Yeni yorumlar kuyrukta, sırayla gönderilecek.`, 60);
    return retry(ev, "Saatlik DM sınırı doldu, sırada.", 10, false);
  }

  // A private reply counts as delivered only when Meta returns a message id. Some token kinds answer on another path,
  // so the account's own path is tried first and "me" second. A follow-gated rule first sends the "follow me" message
  // with a button, and falls back to plain text if Instagram refuses the button.
  let gated = Boolean(rule.follow_gate);
  // Instagram may already tell us the commenter follows: then the link goes straight away, no button step.
  // A follow seen in the last 30 days is taken as it is, without asking Meta again. Instagram itself is asked here
  // only when PRECHECK_FOLLOW is on (see the top of this file).
  if (gated && ev.ig_user_id) {
    if (await knownFollower(ev.ig_user_id)) gated = false;
    else if (PRECHECK_FOLLOW) {
      const p = await graph<{ is_user_follow_business?: boolean }>(`/${encodeURIComponent(ev.ig_user_id)}?fields=is_user_follow_business`, {
        token: tok(s),
        host: s.host,
      }).catch((e) => {
        if (isRateLimit(e)) pauseForLimit();
        return {} as { is_user_follow_business?: boolean };
      });
      if (metaLimitedMin() && !viaPage) return held();
      if (p.is_user_follow_business === true) {
        gated = false;
        await rememberFollower(ev.ig_user_id);
      }
    }
  }
  const gateText = rule.gate_text || DEFAULT_GATE_TEXT;
  const messages = gated ? [gateMessage(gateText, ev.id), gatePlain(gateText)] : [{ text: rule.dm_text }];
  const notes: string[] = [];
  let delivered = false;
  let kind: FailKind = "final";
  send: for (const message of messages) {
    const body = JSON.stringify({ recipient: { comment_id: ev.comment_id }, message });
    // with the Page's token the Page itself ("me") sends; with the saved token the account's own path comes first
    for (const who of [...new Set((viaPage ? ["me", ev.account_id || s.userId] : [ev.account_id || s.userId, "me"]).filter(Boolean))]) {
      try {
        const res = await graph<Record<string, unknown>>(`/${encodeURIComponent(who!)}/messages`, { token: tok(s), host: s.host, method: "POST", body });
        if (res.message_id) {
          delivered = true;
          break send;
        }
        notes.push(`${who}: ${JSON.stringify(res).slice(0, 160)}`);
      } catch (e) {
        // the request limit is not about the path or the message's shape: stop here, no second try on another path
        if (isRateLimit(e)) {
          pauseForLimit();
          return held();
        }
        notes.push(`${who}: ${(e as Error).message}`);
        if (who === "me" || !viaPage) await pageTokenFailed(s, e);
        const k = failKind(e);
        if (k === "token" || (k === "retry" && kind !== "token")) kind = k;
      }
    }
    // a rate limit or bad token is not about the message's shape: no point trying the plain variant
    if (kind !== "final") break;
  }
  if (!delivered) {
    const why = notes.join(" | ");
    // the Page token was refused outright (190): the same comment goes again with the saved token, nothing is lost
    if (viaPage && G.pageOff) return retry(ev, `Sayfa token'ı reddedildi, kayıtlı token ile yeniden denenecek: ${why}`, 1, false);
    if (kind === "token") {
      await alert("token", "Instagram DM: Meta token'ı reddetti. Panelden yeni token gir. Yorumlar kuyrukta bekliyor.", 360);
      return retry(ev, `Token geçersiz: ${why}`, 30);
    }
    if (kind === "retry") return retry(ev, why);
    await setEvent(ev.id, "failed", `DM teslim edilmedi: ${why}`);
    return watchFailures();
  }
  if (gated) {
    // the link waits for the "followed" tap (handleMessage); the private reply still counts toward the hourly cap
    await execute("UPDATE ig_events SET status = 'gated', sent_at = now(), error = '', next_try_at = NULL WHERE id = ?", [ev.id]);
  } else {
    await execute("UPDATE ig_events SET status = 'sent', sent_at = now(), error = '', next_try_at = NULL WHERE id = ?", [ev.id]);
    await execute("UPDATE ig_rules SET sent_count = sent_count + 1 WHERE id = ?", [rule.id]);
  }

  const replyText = rule.reply_text || DEFAULT_REPLY_TEXT;
  const [{ n: repliesLastHour }] = await query<{ n: string }>("SELECT COUNT(*) AS n FROM ig_events WHERE replied = 1 AND sent_at > now() - interval '1 hour'");
  if (Number(repliesLastHour) >= REPLIES_PER_HOUR) return setNote(ev.id, "Yorum yanıtı saatlik sınır nedeniyle atlandı (DM gitti).");
  try {
    await graph(`/${encodeURIComponent(ev.comment_id)}/replies`, {
      token: tok(s),
      host: s.host,
      method: "POST",
      body: JSON.stringify({ message: pick(replyText) }),
    });
    await execute("UPDATE ig_events SET replied = 1 WHERE id = ?", [ev.id]);
  } catch (e) {
    await setNote(ev.id, `DM gitti, yorum yanıtı gitmedi: ${(e as Error).message}`);
  }
}

/** Puts an event back in the queue with a growing wait; after the last try it is given up. */
async function retry(ev: EventRow, why: string, waitMin?: number, countsAsTry = true) {
  const attempts = Number(ev.attempts ?? 0) + (countsAsTry ? 1 : 0);
  if (attempts > BACKOFF_MIN.length) {
    await setEvent(ev.id, "failed", `Tekrar denemeler bitti: ${why}`);
    return watchFailures();
  }
  const wait = waitMin ?? BACKOFF_MIN[Math.max(0, attempts - 1)];
  await execute("UPDATE ig_events SET status = 'retry', attempts = ?, next_try_at = now() + make_interval(mins => ?), error = ? WHERE id = ?", [
    attempts,
    wait,
    `${countsAsTry ? `Kuyrukta (${attempts}. deneme)` : "Kuyrukta"}: ${why}`.slice(0, 500),
    ev.id,
  ]);
}

/** Comments that were marked failed only because the token of the moment lacked a permission wait in the queue again. */
export async function requeuePermissionFailures() {
  await execute(
    `UPDATE ig_events SET status = 'retry', attempts = 0, next_try_at = now(), error = 'Token izinsizdi, yeniden sıraya alındı.'
     WHERE status = 'failed' AND created_at > now() - interval '2 days'
       AND error ILIKE 'DM teslim edilmedi:%permission%'`,
  );
}

/** How many queued comments are sent side by side: each waits on Meta two or three times, one by one would take minutes. */
const QUEUE_BATCH = 8;

/**
 * Sends what is waiting in the queue: taps whose link is due first, then the comments that wait for their first
 * message (newest first), and sends a restart left half done. Runs after each webhook call, when the panel opens,
 * from the scheduled job (/api/cron) and, on a regular server, every two minutes. A row is claimed before it is
 * sent, so two runs at once never send the same DM twice.
 */
export async function processQueue(limit = 40) {
  if (G.running) return;
  G.running = true;
  try {
    const cur = await withPageToken(await readIg());
    if (G.pageWaits && !cur.pageToken) return;
    await requeuePermissionFailures();
    await execute("UPDATE ig_events SET status = 'retry', next_try_at = now() WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'");
    // First the people who did what was asked: they tapped "followed" and only the link is missing. That is a tap
    // that could not be answered while Meta's limit was full, or one whose answer failed (tried a few times).
    const taps = await query<TapEvent & { ig_user_id: string; rule_id: number; status: string }>(
      `SELECT * FROM ig_events WHERE (status = 'tapped' AND next_try_at <= now())
         OR (status = 'gated' AND error LIKE 'Takip sonrası mesaj gitmedi:%' AND gate_tries < ? AND created_at > now() - interval '1 day')
       ORDER BY id LIMIT ?`,
      [MAX_GATE_TRIES, limit],
    );
    for (const ev of taps) {
      if (metaLimitedMin() && !onPage(await readIg())) break;
      if (!ev.ig_user_id || ev.ig_user_id.startsWith("u:")) continue;
      const claim = await execute("UPDATE ig_events SET status = 'sending', claimed_at = now() WHERE id = ? AND status = ?", [ev.id, ev.status]);
      if (!claim.count) continue;
      const [rule] = await query<IgRule>("SELECT * FROM ig_rules WHERE id = ?", [ev.rule_id]);
      if (!rule || !rule.active) {
        await setEvent(ev.id, "failed", "Kural silindi ya da kapatıldı.");
        continue;
      }
      await answerTap(ev, rule, await readIg(), ev.ig_user_id);
    }
    // then the comments that wait for their first message, newest first, a few side by side
    const due = await query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM ig_events WHERE status = 'retry' AND next_try_at <= now() ORDER BY id DESC LIMIT ?`, [limit]);
    const one = async (ev: EventRow) => {
      const claim = await execute("UPDATE ig_events SET status = 'sending', claimed_at = now() WHERE id = ? AND status = 'retry'", [ev.id]);
      if (!claim.count) return;
      const [rule] = await query<IgRule>("SELECT * FROM ig_rules WHERE id = ?", [ev.rule_id]);
      if (!rule || !rule.active) return void (await setEvent(ev.id, "failed", "Kural silindi ya da kapatıldı."));
      await deliver(ev, rule);
    };
    for (let i = 0; i < due.length; i += QUEUE_BATCH)
      await Promise.all(due.slice(i, i + QUEUE_BATCH).map((ev) => one(ev).catch((e) => console.error("[instagram kuyruk]", e))));
  } catch (e) {
    console.error("[instagram kuyruk]", e);
  } finally {
    G.running = false;
  }
}

/** Five or more failures in an hour means something is wrong (Meta rules, settings): tell the owner, at most hourly. */
async function watchFailures() {
  const [{ n }] = await query<{ n: string }>("SELECT COUNT(*) AS n FROM ig_events WHERE status = 'failed' AND created_at > now() - interval '1 hour'");
  if (Number(n) >= 5) await alert("failures", `Instagram DM: son 1 saatte ${n} gönderim başarısız. Paneldeki hatalara bak.`, 60);
}

/** A Telegram message to the owner (if set up), at most once per `everyMin` minutes for the same kind of problem. */
async function alert(kind: string, text: string, everyMin: number) {
  const s = await readIg();
  const last = s.alerts?.[kind] ? new Date(s.alerts[kind]).getTime() : 0;
  if (Date.now() - last < everyMin * 60_000) return;
  await writeIg({ ...s, alerts: { ...s.alerts, [kind]: new Date().toISOString() } });
  await notifyPhone(text);
}

// Several public answers can be given separated by "|"; one is picked at random so they don't all look the same.
function pick(options: string) {
  const list = options
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean);
  return list[Math.floor(Math.random() * list.length)] ?? options;
}

async function setEvent(id: number, status: "sent" | "failed" | "skipped", note: string) {
  if (status === "failed") console.error("[instagram]", id, note);
  await execute("UPDATE ig_events SET status = ?, error = ?, next_try_at = NULL WHERE id = ?", [status, note.slice(0, 500), id]);
}

const setNote = (id: number, note: string) => execute("UPDATE ig_events SET error = ? WHERE id = ?", [note.slice(0, 500), id]);

export type IncomingMessage = {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; quick_reply?: { payload?: string } };
  postback?: { payload?: string };
};

type GatedRow = IgEvent & { ig_user_id: string; account_id: string; gate_tries: number };

/**
 * A DM to our account (Meta's "messages" webhook). Only used for follow-gated rules: when someone who was asked to
 * follow taps "followed" (or writes back), we ask Instagram whether they follow us now and send the link if so.
 * Every other DM is left alone and nothing is stored.
 */
export async function handleMessage(accountId: string, m: IncomingMessage) {
  const sender = m.sender?.id;
  if (!sender || m.message?.is_echo || sender === accountId) return;
  const s = await readIg();
  if (!s.token || (s.userId && accountId && accountId !== s.userId)) return;

  // which comment this is about: the button carries its row id; a typed answer is matched to the person
  const payload = m.message?.quick_reply?.payload ?? m.postback?.payload ?? "";
  const tapped = /^IGF:(\d+)$/.exec(payload);
  let ev: GatedRow | undefined;
  if (tapped) {
    [ev] = await query<GatedRow>("SELECT * FROM ig_events WHERE id = ? AND status = 'gated'", [Number(tapped[1])]);
    // a tap on a row already answered (a second tap after the link went): nothing to do, no call to Meta
    if (!ev) return;
  } else {
    // read receipts, reactions and the like carry no text: never a "followed" answer
    if (!m.message?.text) return;
    // nothing waits for a follow at all: an ordinary DM, ignore it without any call to Meta
    const [{ n }] = await query<{ n: string }>("SELECT COUNT(*) AS n FROM ig_events WHERE status = 'gated' AND created_at > now() - interval '7 days'");
    if (!Number(n)) return;
    [ev] = await query<GatedRow>("SELECT * FROM ig_events WHERE status = 'gated' AND ig_user_id = ? ORDER BY id DESC LIMIT 1", [sender.slice(0, 40)]);
  }
  // A typed answer counts only when its sender is the commenter by id (a tap carries the row id and only reaches the
  // commenter's own DM). Asking Meta who sent every other DM (most are ordinary messages) spent the app's allowance;
  // the button is the way to get the link.
  if (!ev) return;
  if (!tapped && ev.ig_user_id !== sender) return;
  if (Number(ev.gate_tries) >= MAX_GATE_TRIES) return;

  // claim it, so two quick taps never send the link twice
  const claim = await execute("UPDATE ig_events SET status = 'sending', claimed_at = now() WHERE id = ? AND status = 'gated'", [ev.id]);
  if (!claim.count) return;
  const [rule] = await query<IgRule>("SELECT * FROM ig_rules WHERE id = ?", [ev.rule_id]);
  if (!rule || !rule.active) return setEvent(ev.id, "failed", "Kural silindi ya da kapatıldı.");

  await answerTap(ev, rule, s, sender);
}

type TapEvent = { id: number; account_id: string; gate_tries: number };
const TAP_WAITS = "Takip ettim dedi; Meta'nın istek sınırı dolu, sınır açılınca link gönderilecek.";

/**
 * After a "followed" tap (the row is already claimed): sends the link (with ASK_ON_TAP, only after Instagram says the
 * person follows now; otherwise the "not yet" note). When Meta's request limit is in the way the tap is not lost: the
 * row waits as 'tapped' and the queue answers it once the limit opens.
 */
async function answerTap(ev: TapEvent, rule: IgRule, s: IgSettings, sender: string) {
  const later = () =>
    execute("UPDATE ig_events SET status = 'tapped', ig_user_id = ?, next_try_at = now() + make_interval(mins => ?), error = ? WHERE id = ?", [
      sender.slice(0, 40),
      Math.max(1, metaLimitedMin()),
      TAP_WAITS,
      ev.id,
    ]);
  s = await withPageToken(s);
  if (metaLimitedMin() && !onPage(s)) return later();
  const who = onPage(s) ? "me" : ev.account_id || s.userId || "me";
  const sendDm = (message: object) =>
    graph<Record<string, unknown>>(`/${encodeURIComponent(who)}/messages`, {
      token: tok(s),
      host: s.host,
      method: "POST",
      body: JSON.stringify({ recipient: { id: sender }, message }),
    });

  let follows: boolean | undefined = true;
  if (ASK_ON_TAP) {
    let limited = false;
    const p = await graph<{ is_user_follow_business?: boolean }>(`/${encodeURIComponent(sender)}?fields=is_user_follow_business`, {
      token: tok(s),
      host: s.host,
    }).catch((e) => {
      if (isRateLimit(e)) {
        limited = true;
        pauseForLimit();
      }
      return {} as { is_user_follow_business?: boolean };
    });
    if (limited) return later();
    follows = p.is_user_follow_business;
  }
  // If Instagram does not tell us, the person is given the benefit of the doubt rather than left without the link.
  const unknown = typeof follows !== "boolean";
  try {
    if (follows || unknown) {
      // only a follow Instagram itself reported is remembered, never a tap alone
      if (ASK_ON_TAP && follows) await rememberFollower(sender);
      await sendDm({ text: rule.dm_text });
      await execute("UPDATE ig_events SET status = 'sent', ig_user_id = ?, error = ?, next_try_at = NULL WHERE id = ?", [
        sender.slice(0, 40),
        !ASK_ON_TAP ? "Takip ettim'e bastı, link gönderildi." : unknown ? "Takip durumu öğrenilemedi, link yine de gönderildi." : "Takip etti, link gönderildi.",
        ev.id,
      ]);
      await execute("UPDATE ig_rules SET sent_count = sent_count + 1 WHERE id = ?", [rule.id]);
    } else {
      await sendDm(gateMessage(NOT_YET_TEXT, ev.id)).catch((e) => {
        if (isRateLimit(e)) throw e;
        return sendDm(gatePlain(NOT_YET_TEXT));
      });
      await execute("UPDATE ig_events SET status = 'gated', gate_tries = gate_tries + 1, next_try_at = NULL, error = ? WHERE id = ?", [
        `Henüz takip etmiyor (${Number(ev.gate_tries) + 1}. kontrol).`,
        ev.id,
      ]);
    }
  } catch (e) {
    if (isRateLimit(e)) {
      pauseForLimit();
      return later();
    }
    const wasPage = onPage(s);
    await pageTokenFailed(s, e);
    // the Page token was just given up on: the queue answers this tap again with the saved token
    if (wasPage && G.pageOff) return later();
    // The queue tries again in a few minutes (counted, so a tap that can never be answered stops after a few);
    // after that it is left for the person's next tap.
    const tries = Number(ev.gate_tries) + 1;
    if (tries < MAX_GATE_TRIES) {
      await execute(
        "UPDATE ig_events SET status = 'tapped', ig_user_id = ?, gate_tries = ?, next_try_at = now() + interval '5 minutes', error = ? WHERE id = ?",
        [sender.slice(0, 40), tries, `Takip sonrası mesaj gitmedi, yeniden denenecek: ${(e as Error).message}`.slice(0, 500), ev.id],
      );
    } else {
      await execute("UPDATE ig_events SET status = 'gated', gate_tries = ?, next_try_at = NULL, error = ? WHERE id = ?", [
        tries,
        `Takip sonrası mesaj gitmedi: ${(e as Error).message}`.slice(0, 500),
        ev.id,
      ]);
    }
  }
}

export const listRules = () => query<IgRule>("SELECT * FROM ig_rules ORDER BY id DESC");
export const EVENTS_PER_PAGE = 10;
/** One page of the log, newest first; a page number past the end gives the last page. */
export async function listEvents(page = 1) {
  const [count] = await query<{ n: string }>("SELECT COUNT(*) AS n FROM ig_events");
  const total = Number(count?.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / EVENTS_PER_PAGE));
  const at = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const rows = await query<IgEvent>("SELECT * FROM ig_events ORDER BY id DESC LIMIT ? OFFSET ?", [EVENTS_PER_PAGE, (at - 1) * EVENTS_PER_PAGE]);
  return { rows, page: at, pages, total };
}

/** Last hour's numbers for the panel: DMs and public answers against their caps, and what waits in the queue. */
export async function hourStats() {
  const [row] = await query<{ dms: string; replies: string; queued: string }>(
    `SELECT (SELECT COUNT(*) FROM ig_events WHERE sent_at > now() - interval '1 hour') AS dms,
            (SELECT COUNT(*) FROM ig_events WHERE replied = 1 AND sent_at > now() - interval '1 hour') AS replies,
            (SELECT COUNT(*) FROM ig_events WHERE status IN ('retry','sending','tapped')) AS queued`,
  );
  return { dms: Number(row?.dms ?? 0), replies: Number(row?.replies ?? 0), queued: Number(row?.queued ?? 0) };
}
