import type { UsageHour, UsageNow } from "@/lib/instagram";

// Meta's hourly allowance as the panel shows it: the latest reading (calls, CPU, total time, in percent of the rolling
// hour), our own caps (DMs and public answers this hour), and the last 24 hours as bars of Meta's peak.

const tone = (pct: number) => (pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-400");
const ago = (min: number) => min < 1 ? "az önce" : min < 60 ? `${min} dk önce` : `${Math.round(min / 60)} saat önce`;
const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" });

function Bar({ name, value, max = 100, note }: { name: string; value: number; max?: number; note?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{name}</span>
        <span className="tabular-nums text-mist">{max === 100 ? `%${Math.round(value)}` : `${value} / ${max}`}</span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${tone(pct)}`} style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
      </div>
      {note && <p className="mt-1 text-xs text-mist">{note}</p>}
    </div>
  );
}

export function UsageMeter({
  now,
  hours,
  dms,
  dmCap,
  replies,
  replyCap,
  queued,
}: {
  now: UsageNow;
  hours: UsageHour[];
  dms: number;
  dmCap: number;
  replies: number;
  replyCap: number;
  queued: number;
}) {
  const fresh = Boolean(now?.fresh);
  const metaPeak = now && fresh ? Math.max(now.calls, now.cpu, now.time) : 0;
  const topDms = Math.max(1, ...hours.map((h) => h.dms));
  return (
    <div className="grid gap-6">
      {now && now.regainMin > 0 && fresh && (
        <p className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200 ring-1 ring-red-400/30">
          Meta sınırı doldu: erişim yaklaşık {now.regainMin} dakika sonra açılacak. Yeni yorumlar kuyrukta bekliyor, kaybolmuyor.
        </p>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Meta sınırı (son 1 saat)</h3>
          {now ? (
            <>
              <Bar name="Çağrı sayısı" value={fresh ? now.calls : 0} />
              <Bar name="İşlem süresi (CPU)" value={fresh ? now.cpu : 0} />
              <Bar name="Toplam süre" value={fresh ? now.time : 0} note={`Son okuma: ${ago(now.agoMin)}. %100 olunca Meta bir süre isteği keser.`} />
            </>
          ) : (
            <p className="text-sm text-mist">Meta henüz kullanım bilgisi göndermedi; ilk DM ya da tarama sonrası burada görünür.</p>
          )}
        </div>
        <div className="grid content-start gap-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Gönderilenler (bu saat, Meta sınırı)</h3>
          <Bar name="DM" value={dms} max={dmCap} note={queued ? `${queued} yorum kuyrukta, sırayla gidecek.` : "Sınırı aşanlar kuyrukta bekler."} />
          <Bar name="Yoruma açık cevap" value={replies} max={replyCap} note="Sınırı geçince açık cevap atlanır, DM yine gider." />
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-mist">Son 24 saat (saatlik en yüksek Meta kullanımı)</h3>
          {fresh && <span className="text-xs tabular-nums text-mist">şu an %{Math.round(metaPeak)}</span>}
        </div>
        <div className="mt-3 flex h-28 items-end gap-[3px]" role="img" aria-label="Son 24 saatin saatlik Meta kullanımı">
          {hours.map((h) => (
            <div key={h.hour} className="group relative flex h-full flex-1 flex-col justify-end" title={`${hourLabel(h.hour)} · Meta %${h.peak} · ${h.dms} DM · ${h.replies} açık cevap`}>
              <div className={`w-full rounded-t ${h.peak ? tone(h.peak) : "bg-white/10"}`} style={{ height: `${Math.max(h.peak ? 4 : 2, Math.min(100, h.peak))}%` }} />
              <div className="mt-1 h-1.5 w-full rounded-full bg-sky-500" style={{ opacity: h.dms ? 0.25 + 0.75 * (h.dms / topDms) : 0.08 }} />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-mist">
          <span>{hours[0] && hourLabel(hours[0].hour)}</span>
          <span>{hours[12] && hourLabel(hours[12].hour)}</span>
          <span>şimdi</span>
        </div>
        <p className="mt-2 text-xs text-mist">Çubuklar Meta&apos;nın o saatteki en yüksek kullanım yüzdesi; alttaki mavi çizgi o saatte gönderilen DM yoğunluğu. Üstüne gelince sayıları gösterir.</p>
      </div>
    </div>
  );
}
