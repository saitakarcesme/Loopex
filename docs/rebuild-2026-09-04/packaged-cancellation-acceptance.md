# Paketli iptal ve bekleyen native onay deneyi

[packaged-cancellation.cjs](../../v2/tests/e2e/packaged-cancellation.cjs) bağımsız bir E2E girişidir. Ürün kodunu, mevcut journey/performance harness'lerini veya eski kullanıcı verisini değiştirmez. `--run` olmadan uygulama, model veya fixture başlatmaz. Bu dosyanın hazırlanması bir canlı kabul sonucu değildir.

## Çalıştırma

Root, performans deneyleri bittikten ve hedef paket kimliği kesinleştikten sonra çalıştırır:

```sh
node v2/tests/e2e/packaged-cancellation.cjs --run \
  --app "/kesin/paket/yolu/Akorith Next.app" \
  --expected-version 2.0.0-alpha.3 \
  --package-id B03
```

`--expected-version` zorunludur; örnekteki değeri gerçekten sınanan paket sürümüyle değiştir. Harness bundle metadata'sını ve çalışan uygulamanın `app:snapshot.version` değerini karşılaştırır; app.asar ve harness SHA-256'sını kaydeder. LaunchServices `/usr/bin/open -n` kullanılır, yeni `AKORITH_USER_DATA` verilir. Otomatik eski fixture veya başka app'e fallback yoktur.

Her çalıştırmada yeni `os.tmpdir()/akorith-cancellation-*` kökü oluşturulur. Kökün gerçek yolu, `data`, `project`, nonce ve rapor konumu ilk stdout kaydında görünür. `owned-fixture.json`, `cancellation.json`, launch logları ve ekran görüntüleri yalnız bu köke yazılır. Asıl projeye dosya değişikliği veya başka hesap kurulumu yapılmaz. Fixture silinmez.

## A — Gerçek host aracı sırasında Stop ve UI kuyruğu

1. Gerçek katalogda giriş yapılmış Codex `gpt-6-astra` zorunlu; yoksa test durur. Başka modele sessiz geçilmez.
2. Yeni fixture projesi ve görev oluşturulur. UI'daki `Permission mode` seçimi `full` yapılır ve kalıcılığı okunur.
3. Harness yalnız kendi projesine `cancel-owned.sh` yazar. Script canonical cwd'yi doğrular, nonce ile shell PID'sini `started.pid` içine, kendi sleep child'ını `sleep.pid` içine yazar; 90 saniye bekler, sonra `late.marker` yazardı.
4. Gerçek prompt, tam komutu bir kez Akorith `terminal_execute` ile 110000 ms timeout kullanarak çalıştırmasını ister. Native shell aracı veya modelin marker'ı kendi yazması kabul yolu sayılmaz. Kayıtlı `terminal_execute` aktivitesi, marker nonce'ları ve süreçlerin bu testin ana uygulamasından türediği birlikte doğrulanır. Beklenmedik soru/onay otomatik cevaplanmaz.
5. Çalışan komut sırasında `Follow-up behavior → queue`, `Queue message` ile A ve B girilir. `Edit queued message` ile A düzenlenir; `Move queued message 2 up` ile B öne alınır; düzenlenmiş A'nın `Remove queued message` düğmesi kullanılır. Her adımın kalıcı sırası `task:queue` ile okunur. Düzenleme/sıralama/silme doğrudan IPC mutasyonu ile taklit edilmez.
6. `Stop task` tıklanır. Görev `cancelled`, kuyruk boş, `app:diagnostics.engine.active=[]`, `writerLeases=0` olmalı. Shell ve sleep PID'leri yalnız gözlem yapan 5 saniyelik bounded kontrolde gerçek ESRCH ile yok olmalı; geçici EPERM bilinmeyen durum olarak tekrar gözlenir. State geçişleri/süre kaydedilir; bu gözlem yeni signal göndermez. Önceki tool activity ID'si korunmalı; iki queued assistant mesajı cancelled/boş/araçsız kalmalı.
7. Orijinal script başlangıcından 95 saniye geçene kadar `late.marker` yokluğu izlenir. Stop'tan hemen sonra dosyanın olmaması tek başına yeterli kanıt sayılmaz. `cancelled.png` kaydedilir.

Bu deneme gerçek model prompt'unu ve abonelik kullanımını içerir. Queue'ya kabul edilen follow-up sayısı ayrı kaydedilir; hiç yürütülmemesi gereken iki follow-up gerçek model turu yapılmış diye sayılmaz. Süre ölçümü bu tek fixture örneğidir.

## B — Gerçek native onay beklerken macOS Quit

Bu bölüm koşulludur. Varsayılan model yalnız gerçek katalogda bulunan `opencode/mimo-v2.5-free`; `--pending-model` ile açık bir `opencode/*free*` kimliği verilebilir. Katalogdaki isim, yeni bir hesap veya faturalama garantisi değildir. Model yoksa ücretli alternatif başlatılmaz. `--skip-pending` açıkça `not-run` kaydeder.

Yeni Inspect görevinden yalnız fixture `approval-proof.txt` dosyasını Akorith MCP `files_read` aracıyla okuması istenir. Güncel OpenCode adapter'ında MCP araçları `*:'ask'` native permission yolundadır, ancak modelin o aracı çağıracağı garanti edilemez. 90 saniyede beklenen gerçek `files_read` approval oluşmazsa veya başka istek gelirse bölüm **not-run** olur. Model/native olay uydurulmaz; pending state DB'ye veya renderer'a enjekte edilmez; hiçbir onay verilmez. Gerekirse bu fixture görevi Stop ile kapatılır.

Gerçek istek oluşursa `Approval requested` region'ı, request/task/turn kimlikleri ve history kaydedilir. `native-pending-before-quit.png` alınır. Harness şu kaydı basar:

```text
Awaiting native Quit action
```

Kaydın içindeki **tam app yolu ve PID'ye ait** uygulamada root CUA ile gerçek macOS Quit menüsünü veya native Command-Q'yu kullanır. Süre 90 saniye; harness bu aşamada CDP Meta-Q, SIGTERM veya başka Quit komutu göndermez. Onay kartına dokunulmaz. Beklenen request uygulama kapanışı başlamadan kaybolursa pending-Quit kabulü başarısızdır.

Ana PID'nin yokluğu ve önceden sahipliği doğrulanmış native child PID'lerinin yokluğu gözlenir. Ana süreç için operator penceresi, child'lar için ek 5 saniyelik bounded gözlem vardır; EPERM hemen başarı veya kalıcı başarısızlık sayılmaz, yalnız ESRCH yokluğu doğrular. Bekleme süresi operator gecikmesini içerir; uygulamanın saf kapanma gecikmesi diye raporlanmaz. CUA işleminin gerçekten Quit olduğu root'un kendi işlem kaydıyla eşleştirilmelidir; harness yalnız istenen işlem sonrasındaki süreç/state kanıtını verir.

Aynı yeni fixture veri dizini yeniden açılır. Görev cancelled/interrupted, pending listesi boş, native session korunmuş, mesaj kimlikleri aynı ve önceki içerik/aktivite geçmişi korunmuş olmalı. Ek üç saniyelik gözlemde yeni aktif tur veya writer lease olmamalı. Eski request cevaplanmaz veya otomatik tekrar gönderilmez.

## Sonuç ve recovery temizliği

`cancellation.json` her önemli aşamada güncellenir. A ve B sonuçları ayrı `passed/failed/not-run`; `completed` harness akışının bitmesi, `successful` ise iki kabulün ve temizliğin başarılı olmasıdır. Koşullu bölüm çalıştırılmadıysa “iki test geçti” denmez.

- Exit **0**: iki kabul ve süreç temizliği geçti.
- Exit **1**: davranış/kimlik/doğrulama/cleanup hatası.
- Exit **2**: iptal bölümü geçti, pending-Quit koşulu sağlanmadı veya açıkça atlandı; kapsam tamamlanmadı.

Hata/son temizlikte yalnız bu harness'in oluşturduğu task'lara `task:stop` istenir; kabul edilen UI Stop testinden ayrı etiketlenir. Ardından PID/start-time/command kimliği yeniden doğrulanan sahipli süreçler için TERM, bounded bekleme ve gerekirse KILL kullanılır. KILL gerekmesi, EPERM, kimlik değişimi veya yokluğun doğrulanamaması başarı değildir. Bir PID marker'ı tek başına rastgele sürece signal yetkisi sağlamaz. Kimlik belirsizse süreç kayıtla bırakılır; isimle toplu kill yapılmaz. Recovery sinyalleri hiçbir zaman native Quit kanıtı sayılmaz.

Son yeniden açılan app'in temizliği SIGTERM ile yapılıyorsa bu yalnız harness recovery/teardown işlemidir; ikinci native Quit kabulü değildir. Log/receipt içinde yöntem ve PID ayrı görünür. Modelin final metni, süreç yokluğu veya kuyruğun çalışmadığı kanıtının yerine geçmez.

## Ürün başlatmadan hazırlık kontrolleri

Root'un test dondurması kalktıktan sonra:

```sh
node --check v2/tests/e2e/packaged-cancellation.cjs
node v2/tests/e2e/packaged-cancellation.cjs --self-test
```

Self-test yalnız argüman, shell quoting, nonce/PID marker, ESRCH/EPERM ayrımı, PID kimliği ve beklenen native request sınıflandırmasını sınar. Fixture/uygulama/model/native süreç oluşturmaz. Canlı GUI tıklama, Stop veya native Quit sonucu değildir.
