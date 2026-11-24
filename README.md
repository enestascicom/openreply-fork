# OpenReply

**Instagram'da gönderine belirli bir kelimeyle yorum yapan herkese otomatik DM gönderen, ücretsiz ve açık kaynak sistem.**
ManyChat gibi araçlardaki "yoruma LİNK yaz, DM'den göndereyim" özelliğinin, kendi hesabında aylık ücret ödemeden çalışan açık kaynak hali.

[![Vercel'e kur](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ferenkavakcom%2Fopenreply&project-name=openreply&repository-name=openreply&env=ADMIN_PASSWORD,CRON_SECRET&envDescription=ADMIN_PASSWORD%3A%20panel%20%C5%9Fifren%20(en%20az%2010%20karakter).%20CRON_SECRET%3A%20rastgele%20uzun%20bir%20kelime.&envLink=https%3A%2F%2Fgithub.com%2Ferenkavakcom%2Fopenreply%23kurulum)

> [erenkavak.com](https://erenkavak.com) tarafından yapıldı. Destek olmak istersen
> [Instagram](https://www.instagram.com/erenkavakcom/), [YouTube](https://www.youtube.com/@erenkavakcom) ve
> [TikTok](https://www.tiktok.com/@erenkavakcom)'ta **@erenkavakcom**'u takip et.

## Neler yapar?

- **Anahtar kelimeyle yorum → otomatik DM.** "link", "rehber" gibi kelimeler; Türkçe ekleri ("linki", "rehberini") ve uzun kelimelerde bir harf hatasını da yakalar.
- **Sadece takip edenlere** seçeneği: önce "takip et" mesajı ve **Takip ettim ✅** butonu gider, takip ettiyse link gönderilir.
- **Yorumun altına otomatik yanıt** ("DM'den gönderdim 🙌"), birkaç seçenek arasından rastgele.
- **Aynı kişiye tek DM**: üç kez yorum yazan bir kez mesaj alır.
- **Viral gönderiye hazır**: Meta'nın saatlik sınırına takılmadan saatte 600 DM gönderir, fazlasını sıraya alıp sırayla yollar; hata olursa kendisi tekrar dener.
- **Videoya özel kural**: kurala videonun Instagram linkini yapıştırırsın, kural yalnızca o videonun yorumlarında çalışır. Link vermezsen tüm gönderilerde çalışır. Aynı kelimeyi ("link" gibi) her videoda farklı bir mesajla kullanabilirsin: o videoda linkli kural, diğerlerinde linksiz kural gider.
- **Panel**: kurallar, sayfa sayfa gönderim günlüğü (her sayfada 10 kayıt), hata nedenleri, uygulamanın içinde adım adım kurulum rehberi.
- İsteğe bağlı **Telegram uyarısı**: token geçersiz olursa ya da gönderimler takılırsa haber verir.

Kendi hesabın için kullandığın sürece Meta incelemesine (App Review) gerek yoktur.

## Kurulum

İki yol var. İkisi de ücretsiz hesaplarla çalışır ve yaklaşık 15-20 dakika sürer.

- **Yol 1: Kendin kur.** Aşağıdaki adımları sırayla izlersin.
- **Yol 2: Claude Code ile kur.** Claude, tarayıcında tıklamaları senin yerine yapar; sen sadece giriş yaparsın ve onay verirsin.

### Yol 1: Kendin kur

#### 1.1 Hesapları aç (bir kerelik)

1. **GitHub**: [github.com/signup](https://github.com/signup) adresinden ücretsiz hesap aç. Vercel bu hesapla giriş yapacak ve
   projenin bir kopyasını senin hesabında tutacak.
2. **Vercel**: [vercel.com/signup](https://vercel.com/signup) → **Hobby** (ücretsiz) → **Continue with GitHub**. GitHub'ın izin
   ekranında **Authorize Vercel**'e bas.

#### 1.2 Siteyi Vercel'e kur

1. Bu sayfanın başındaki **Vercel'e kur** (Deploy) butonuna bas.
2. **Create Git Repository** ekranında depo adını olduğu gibi bırakabilirsin; **Private** seçili kalsın → **Create**.
3. İki değer sorulacak:
   - `ADMIN_PASSWORD`: panelin şifresi. En az 10 karakter, tahmin edilmesi zor bir şey. Bir yere not et.
   - `CRON_SECRET`: rastgele uzun bir kelime (örn. `k8Fq2mZ7xLw9Pn4R`). Sıradaki DM'leri gönderen zamanlayıcı için.
4. **Deploy**'a bas. 1-2 dakika sonra "Congratulations" ekranı gelir. Site açılır ama veritabanı olmadığı için henüz
   giriş ekranında "DATABASE_URL" eksik der; bu normal.
5. **Veritabanını bağla**: Vercel'de projene gir → üstte **Storage** → **Create Database** → **Neon** → **Continue** →
   bölge olarak **Frankfurt** (Türkiye'ye yakın) → plan **Free** → **Create** → çıkan ekranda **Connect**.
   Bu, `DATABASE_URL`'i projeye kendiliğinden ekler.
6. **Yeniden kur**: **Deployments** sekmesi → en üstteki kurulumun sağındaki **⋯** → **Redeploy** → **Redeploy**.
7. **Sitenin adresini** projenin **Overview** sayfasındaki **Domains** altında görürsün
   (örn. `openreply-xxxx.vercel.app`). Aç ve `ADMIN_PASSWORD` ile giriş yap.

Bu depoda güncelleme çıktığında: GitHub'daki kopyanı açıp **Sync fork**'a bas; Vercel yeni sürümü kendisi yayına alır. Veritabanı ilk açılışta kendini günceller, kuralların ve kayıtların yerinde kalır. Neyin değiştiği aşağıdaki [Sürüm notları](#sürüm-notları) bölümünde.

#### 1.3 Meta'yı bağla

Panelde **Kurulum rehberi** sekmesi seni adım adım götürür. Kopyalaman gereken değerler (webhook adresi, doğrulama kodu,
gizlilik sayfası) orada hazır, yapıştırman gerekenler (token, gizli anahtar) için alanlar da aynı adımlarda. Özetle:

1. Instagram hesabını **profesyonel** yap; *Ayarlar → Mesajlar ve hikaye yanıtları → Mesaj kontrolleri → Bağlı araçlar* bölümünde
   **Mesajlara erişime izin ver**'i aç.
2. [developers.facebook.com/apps](https://developers.facebook.com/apps/) → **Uygulama oluştur** → kullanım durumu:
   **Instagram'da mesajları ve içeriği yönet**.
3. *Instagram API → API setup with Instagram login* → **Generate token** ile token'ı al; **Instagram app secret**'ı kopyala;
   ikisini panele yapıştır.
4. Aynı sayfada **Configure webhooks**: panelden Callback URL ve Verify token'ı yapıştır → **comments** ve **messages**'a abone ol.
5. *Uygulama ayarları → Temel*: gizlilik ve veri silme adreslerini (panelde hazır) yapıştır → uygulamayı **Live** moda al.
6. Panelde kural ekle, **başka bir hesaptan** yorum yazıp dene.

### Yol 2: Claude Code ile kur

[Claude Code](https://claude.com/claude-code), bilgisayarında çalışan bir yapay zeka asistanı. **Claude in Chrome** eklentisiyle
Chrome'unu kullanıp Vercel ve Meta panellerindeki tıklamaları senin yerine yapabilir. Claude aboneliği gerekir.

1. **Claude Code'u kur**: [claude.com/claude-code](https://claude.com/claude-code) adresinden masaüstü uygulamasını indir ve
   Claude hesabınla giriş yap.
2. **Claude in Chrome'u bağla**: Chrome Web Mağazası'ndan **Claude** eklentisini kur, aynı Claude hesabıyla giriş yap.
   Claude Code bu Chrome'u görür ve kullanabilir.
3. Chrome'da **GitHub**, **Vercel** ve **Facebook** hesaplarına kendin giriş yap. Claude şifre girmez; giriş gereken yerde durur ve
   senden ister.
4. Claude Code'a şu mesajı yapıştır:

```text
https://github.com/erenkavakcom/openreply deposunu Instagram hesabım için kur.
README'deki "Yol 1" adımlarını Chrome'da benim yerime yap:
1) Vercel'e Deploy butonuyla kur. ADMIN_PASSWORD'ü ben yazacağım, sorulduğunda dur ve bana sor; CRON_SECRET için rastgele bir değer üret.
2) Storage'dan ücretsiz Neon veritabanını (Frankfurt) bağla ve yeniden kur.
3) Site açılınca panele girmemi bekle, sonra paneldeki "Kurulum rehberi" adımlarını developers.facebook.com'da birlikte yapalım.
Giriş, şifre ya da onay gereken her yerde dur ve bana söyle. Her adımı bitirince ne yaptığını kısaca yaz.
```

5. Claude adım adım ilerler; senden istediği yerlerde (giriş, şifre, Meta'nın izin ekranları) işlemi sen yaparsın.
6. Bitince panelde kural ekleyip başka bir hesaptan yorum yazarak dene.

## Başka bir sunucuda çalıştırmak

Node.js 20.9+ olan her yerde çalışır (Hostinger, bir VPS, kendi bilgisayarın). Bir Postgres veritabanı gerekir
(Neon, Supabase gibi ücretsiz servisler olur).

```bash
git clone https://github.com/erenkavakcom/openreply.git
cd openreply
npm install
cp .env.example .env   # DATABASE_URL ve ADMIN_PASSWORD'ü doldur
npm run build
npm start
```

Normal bir sunucuda sıradaki DM'ler iki dakikada bir kendiliğinden gönderilir. Meta webhook'a HTTPS adres ister.

## Ortam değişkenleri

| Değişken | Gerekli | Ne işe yarar |
|---|---|---|
| `DATABASE_URL` | Evet | Postgres adresi (Vercel'de Neon eklenince kendiliğinden gelir) |
| `ADMIN_PASSWORD` | Evet | Panel şifresi, en az 10 karakter |
| `CRON_SECRET` | Önerilir | `/api/cron` zamanlayıcısının anahtarı |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Hayır | Sorun olunca Telegram'dan haber almak için |

## Sık sorulanlar

**Vercel'de sıradaki DM'ler ne zaman gider?** Saatlik sınırı aşan yorumlar sıraya girer. Vercel'in ücretsiz planı zamanlayıcıyı günde
bir kez çalıştırır; ama her yeni yorum ve paneli her açışın da sırayı gönderir. Çok viral bir gönderi bekliyorsan
[cron-job.org](https://cron-job.org) gibi ücretsiz bir servisle `https://SİTEN/api/cron?key=CRON_SECRET` adresini 5 dakikada bir çağırabilirsin.

**Kişisel hesapta çalışır mı?** Hayır, Instagram yalnızca profesyonel (İşletme ya da İçerik üreticisi) hesaplara bu izni veriyor.

**Token'ın süresi dolarsa?** Token 60 gün geçerli; sistem dolmadan kendisi yeniler. Yenileyemezse panelde ve (kuruluysa) Telegram'da uyarı görürsün.

**Verileri ne kadar saklanıyor?** Yalnızca eşleşen yorumların kısa kaydı, en fazla 90 gün. Ayrıntısı sitendeki `/gizlilik` sayfasında.

## Sürüm notları

**1.5.1 (24 Kasım 2026)**

- Sunucu kayıtlarına (Vercel → Logs) her webhook çağrısı için hangi bildirimin geldiği, her gelen DM için de ne yapıldığı tek satır olarak yazılıyor (mesaj içeriği yazılmaz). "Takip ettim"e basıldı ama link gitmedi gibi durumlarda bildirimin gelip gelmediği ve neden atlandığı oradan görülür.

**1.5.0 (24 Kasım 2026)**

- **Aralıklı gönderim.** DM'ler artık saatte en çok 130 olacak şekilde eşit aralıklarla gider (yaklaşık 28 saniyede bir); ilk mesaj, "takip et" mesajı ve link aynı sıraya girer. Instagram bir hesabı Meta'nın yazdığı saatlik 750'nin çok altında kısıyor ve bunu söylemiyor: bizde saatte 150 ila 200'de reddetmeye başladı, 130 sorunsuz gitti. Rakam `DM_PACE_PER_HOUR` ortam değişkeniyle değişir, `0` aralığı kapatır. Son gönderim veritabanından okunduğu için Vercel gibi sunucusuz ortamlarda da aynı hız korunur.
- **Kimse atlanmaz, sıra geliş sırası.** Kuyruk artık en eski yorumdan başlar ve tek tek gönderir. Kuyrukta bekleyen varken gelen yeni yorum sıranın sonuna girer. "Takip ettim ✅"e basanlar her turda öne alınır ve linkleri için bir sonraki boş aralık ayrılır.
- **Instagram kısınca kendiliğinden durur.** Instagram hesabı kısarken yeni yazışmaları "yazışma sahibi bu konuşmayı arşivledi veya sildi" diye reddediyor. On dakika içinde üç farklı kişide bu cevap gelirse gönderim 30 dakika durur ve haber verilir. Bu cevap artık kalıcı hata sayılmaz, yeniden denenir; son iki günde bu yüzden hataya düşenler yeniden sıraya alınır.
- **Daha uzun bekleme.** Meta "istek sınırı doldu" dediğinde gönderim 3 değil 15 dakika durur, kısa süre sonra yine reddedilirse 30 dakika. Reddedilen her istek de sayaca yazıldığı için kısa aralıklı denemeler sınırı saatlerce dolu tutuyordu. Bekleme artık sayfa token'ıyla giden istekler için de geçerli.
- Panel **telefonda sağa kaymıyor**: boşluksuz uzun bir link içeren kural ya da hata satırı artık kartı genişletmiyor.

**1.4.0 (22 Kasım 2026)**

- **Sayfa token'ı ve Meta sınırı.** Facebook tarafı bir token kaydedilince, Instagram hesabının bağlı olduğu Facebook sayfasının kendi token'ı alınır ve istekler onunla gider; böylece uygulamanın küçük saatlik hakkına değil, Instagram'ın geniş sınırına yazılır. Sayfa token'ı reddedilirse kayıtlı token'a dönülür. Meta "sınır doldu" derse gönderim birkaç dakika durur, yorumlar deneme hakkı harcamadan kuyrukta bekler. Instagram girişiyle alınan token'lar (`IGAA…`) eskisi gibi çalışır.
- **Takip sorusu yok, düğme yeterli.** "Sadece takip edenlere" kurallarında Instagram'a artık ne yorum gelince ne de "Takip ettim ✅"e basılınca takip sorulur: düğmeye basan linki hemen alır. Yoğun bir videoda Meta'nın hakkını dolduran istek buydu. İstenirse `src/lib/instagram.ts` başındaki iki ayarla geri açılır.
- **"Link sırada".** Meta sınırı doluyken düğmeye basanlar kaybolmaz; kayıt "Link sırada" olarak bekler, sınır açılınca link kendiliğinden gider. Kuyruk önce bunlara, sonra en yeni yorumlardan başlayarak sekizer sekizer gönderir.
- **Kuyruğu şimdi gönder (n).** Gönderimler sekmesindeki düğme bekleyenlerin hepsini beklemeden dener ve sonucu söyler. Mesaj izni olmayan bir token yüzünden hataya düşen yorumlar yeni token kaydedilince yeniden sıraya alınır.
- Kurallar **beşer beşer sayfalanıyor**, her kuralın sıra numarası var.
- Kullanım kartının altında bu saatin **istek türleri ve sayaç satırı**: her istek türünün sayısı, süresi, hangi token'la gittiği ve Meta'nın uygulama ve işletme sayaçlarındaki en yüksek değer. Kendi saatlik sınırlarımız kalktı; DM ve açık cevap için Meta'nın 750 rakamı geçerli.

**1.3.0 (18 Kasım 2026)**

- **Saatlik kullanım ve sınırlar kartı** (Gönderimler sekmesi). Meta her API cevabında uygulamanın saatlik hakkından ne kadar kullanıldığını yüzde olarak gönderir; panel bunu Meta'nın kendi sayfasındaki gibi gösterir: çağrı sayısı, işlem süresi ve toplam süre, saatlik DM ve yorum cevabı sınırları, son 24 saatin saatlik en yüksek kullanımı. Sınır dolunca erişimin kaç dakika sonra açılacağı yazar. Kayıtlar 8 gün tutulur.

**1.2.0 (18 Kasım 2026)**

- **Takip kontrolü kişi başına hatırlanıyor.** "Sadece takip edenlere" kurallarında, takip ettiği bir kez görülen kişi 30 gün boyunca yeni yorumlarında Meta'ya tekrar sorulmaz, link doğrudan gider. Çok yorum alan bir videoda Meta'nın saatlik istek sınırına daha geç dayanılır. "Takip etmiyor" sonucu hatırlanmaz; takip ettikten sonraki kontrol her zaman yenidir.
- Yeni logo ve uygulama simgesi; giriş ekranı, arka plan ve butonların renkleri tazelendi.

**1.1.0 (14 Kasım 2026)**

- Kurala gönderi kimliği yerine **videonun linki** yazılıyor. Kaydederken link hesabındaki gönderilerde aranır; bulunamazsa kural kaydedilmez ve nedenini söyler. Eski, kimlikle yazılmış kurallar çalışmaya devam eder.
- Aynı kelimeyle hem videoya özel hem genel kural varsa, o videoda **videoya özel olan** gider. Önceden ilk eklenen kural giderdi.
- Gönderim günlüğü 50 kayıtlık tek liste yerine **10'ar kayıtlık sayfalar** halinde; toplam kayıt sayısı başlıkta yazar.

## Lisans

[MIT](LICENSE). Ücretsiz kullanabilir, değiştirebilir ve dağıtabilirsin.

OpenReply bağımsız bir projedir; Meta, Instagram ya da ManyChat ile bağlantılı değildir ve onlar tarafından onaylanmamıştır. Instagram ve Meta, Meta Platforms, Inc.'in; ManyChat, ManyChat, Inc.'in ticari markalarıdır.

---

**Bu sistemi [Eren Kavak](https://erenkavak.com) yaptı.** Ücretsiz kalmasına destek olmak istersen takip et:
[Instagram](https://www.instagram.com/erenkavakcom/) · [YouTube](https://www.youtube.com/@erenkavakcom) · [TikTok](https://www.tiktok.com/@erenkavakcom) — **@erenkavakcom**
