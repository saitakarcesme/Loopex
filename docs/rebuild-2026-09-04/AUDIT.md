# Akorith yeniden yapım incelemesi

Tarih: 4 Eylül 2026. Bu belge statik kaynak incelemesidir; canlı uçtan uca test veya güvenlik denetimi tamamlandığı anlamına gelmez.

## İncelenen sürümler ve kanıt sınırı

- Göreve bağlı klasör: `/Users/ibrahimsaitakarcesme/Desktop/Projects/Akorith`. Bu klasör Git deposu değil; doğrulama projeleri, eski kopyalar ve bozuk bir sembolik bağlantı içeriyor.
- İçindeki `Akorith` bağlantısının hedefi `/Users/ibrahimsaitakarcesme/Projects/Akorith`; hedef inceleme sırasında mevcut değildi.
- Kurulu uygulama: `/Applications/Akorith.app`, sürüm `0.9.4`.
- Uygulamanın `build-info.json` kaydı: `e04538c6b4ba19243200551667bc1285b7ba8cfa`, dal `main`, üretim tarihi `2026-08-08T16:45:48.720Z`.
- GitHub deposu: [saitakarcesme/Akorith](https://github.com/saitakarcesme/Akorith).
- Salt inceleme için alınan kaynak snapshot'ı: `1d5af3abe3036b15e4558697b017970f8f4766b5`, `main`. Kurulu uygulama ile kaynak snapshot'ı farklı commit'lerdir; birebir eşit kabul edilmedi.
- Yerel inceleme kopyası: `/tmp/akorith-plan-audit.Sv8lQF/repo`. Bu geçici kopya yeni geliştirme deposu olarak seçilmedi.
- Ana uygulama kodu değiştirilmedi; geliştirme dalı açılmadı; kullanıcı veritabanı okunmadı/değiştirilmedi; abonelik kullanan model çağrısı yapılmadı.
- Temmuz ekran görüntüleri yalnızca tarihsel tasarım bağlamı olarak incelendi. Eylül sürümünün canlı görünümü olarak sunulmuyor.

Makine ölçümü: macOS `26.6`, `arm64`, donanım tanımlayıcısı `MacBookAir10,1`, fiziksel bellek `8,589,934,592` bayt / 8 GiB. `node`, `git`, `ollama`, `codex` ve `claude` yürütülebilirleri PATH üzerinde bulundu. Bu, oturumlarının açık olduğunu veya modellerin çalıştığını doğrulamaz.

## Somut bulgular

| Kimlik | Kaynakta gözlenen davranış | Ürün hedefine etkisi | Karar |
|---|---|---|---|
| A01 | Codex Workspace adaptörü `--ephemeral` ile `codex exec` başlatıyor. Ortak sözleşmede native oturum başlat/devam et/yönlendir işlemleri yok. | Uygulama geçmişi mevcut olsa da native ajan oturumu sürekliliği ayrı bir sorun. Aynı ajanla uzun görev, canlı yönlendirme ve yeniden bağlanma için mevcut sözleşme yetersiz. | Oturumlu adaptör sözleşmesini yeniden kur. |
| A02 | Workspace Codex çağrıları browser, computer use, apps, plugins ve ilgili özellikleri açıkça devre dışı bırakıyor. | Kullanıcının talep ettiği geniş araç seti şu anki çağrı yolundan beklenemez. | Onay ve araç yönetimiyle birlikte yeni entegrasyon; mevcut bayrakları körlemesine açma. |
| A03 | Workspace düşünme seviyesi `medium` olarak sabitleniyor. | Kullanıcının seçtiği kapasite/çaba deneyime tam yansımayabilir. | Modelin desteklediği değerleri keşfet, kullanıcı seçimini çalışma kaydına bağla. |
| A04 | Headless Codex yolunda `--ask-for-approval never` kullanılıyor; kod bunun nedenini onay isteğine cevap verilememesi olarak açıklıyor. | Bu durum sandbox'ı kaldırmıyor; fakat etkileşimli onay gereken görevlerin devamı eksik. | Çift yönlü onay isteği/cevabı ve bekleme durumları ekle. |
| A05 | Claude Workspace adaptörü Bash'i kapatıyor, boş MCP yapılandırması ve kısıtlı araç listesi kullanıyor. | Dosya düzenleme mümkün olsa bile genel terminal, araç ve uygulama akışı sınırlı. | Yetki kapsamını görünür ve görev bazında yönet; adaptör yeteneklerini açık bildir. |
| A06 | Claude Workspace'te `streamVisibleText = !opts.workingDirectory`; final metin araç işi sonunda veriliyor. Renderer'da ayrıca 55 ms aralıklı, 9 adımlı final gösterimi var. | Gerçek akış ile sunum animasyonu birbirine karışıyor; tamamlanmış cevabın görünmesi ek süre alıyor. | Gerçek delta varsa akıt; tamamlanmış yanıtı yapay yazma efekti olmadan göster. |
| A07 | `project-preview.ts`, `WebContentsView` kullanıyor ve gezinmeyi loopback URL'lerle sınırlandırıyor. | Kullanışlı yerel uygulama önizlemesi var. Genel web araştırması veya macOS uygulama kontrolü bununla eşdeğer değil. | Yerel önizlemeyi taşı; genel browser ve macOS computer use modüllerini ayrı kur. |
| A08 | `workspace-actions.ts` Türkçe/İngilizce regex'lerle aç/başlat isteği çıkarıyor, önizlemeyi model işi bittikten sonra açıyor. | Ara adım olarak aç → gözlemle → düzelt → yeniden doğrula döngüsünün genel protokolü değil. | Tipli araç çağrıları ve sonuç olayları kullan; regex'i genel eylem motoru yapma. |
| A09 | `App.tsx` içinde Research ve Benchmark görünür ama boş section olarak render ediliyor. | Menü bir beklenti yaratıp boş yere götürüyor. | Yeni v1 navigasyonundan çıkar; tarihsel kullanıcı kayıtlarını koru. |
| A10 | Üç küresel CSS katmanı sırayla yükleniyor: `styles.css`, `product-polish.css`, `replica-ui.css`. | Yeni görsel kararlar eski katmanlarla etkileşiyor. Tekrar tekrar yüzeysel düzeltme yerine bileşen sahipliği gerekli. | Yeni token sistemi ve kapsamlı bileşen stilleriyle renderer'ı yeniden kur. |
| A11 | `verify-performance.ts` ve `verify-replica-ui.ts` içinde pek çok kontrol kaynak metindeki belirli string/regex'leri doğruluyor; saf fonksiyon kontrolleri de mevcut. | Bu kontroller yararlı niyet kontrolleri olabilir; gerçek kare sürelerini, tıklama gecikmesini veya Electron odak davranışını kanıtlamaz. | Davranış testleri, gerçek Electron ölçümleri ve kayıtlı olay tekrarları ekle. |
| A12 | DB WAL ve foreign key kullanıyor; kesilmiş chat turlarını uzlaştırma ve canonical workspace writer lease mevcut. | Kalıcılık ve eşzamanlı yazmayı kontrol etme konusunda değerli temel var. | İlkeleri ve uygun kodu testle taşı; bütününü atma. |
| A13 | LocalProvider varsayılanlarında autoStart, exposeLan ve lanDiscovery açık. | Bu Mac'te basit, öngörülebilir yerel kullanım için servis sahipliği ve hedef cihaz netleşmeli. | Loopback yerel bağlantıyı varsayılan yap; uzak uçları kullanıcının eklediği profil olarak yönet. |
| A14 | Kaynak `AGENTS.md` 1.973 satırlık faz geçmişi içeriyor; sonunda her fazın `origin main`e itilmesi yazıyor. | Yeniden yapım dalı ve güncel ürün sözleşmesiyle çelişen tarihsel kurallar birikmiş. | Uygulama başlangıcında kısa güncel kurallar oluştur; faz geçmişini tarihçe belgesine taşı. Bu plan çalışmasında push yapılmadı. |

## Kaynak bağlantıları

Bağlantılar inceleme commit'ine sabitlenmiştir. Satır numaraları bu snapshot içindir.

- A01–A04: [Codex adaptörü, özellik ve çağrı ayarları](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/providers/chatgpt.ts#L23).
- A01 sözleşme: [Provider / SendOptions](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/providers/types.ts).
- A05–A06: [Claude adaptörü](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/providers/claude.ts#L48).
- A06: [Renderer final gösterimi](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/renderer/src/components/ChatPanel.tsx#L564).
- A07: [Proje önizlemesi](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/project-preview.ts#L722).
- A08: [Prompt'tan browser eylemi çıkarımı](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/workspace-actions.ts).
- A09: [Boş ürün rotaları](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/renderer/src/App.tsx#L840).
- A10: [Stil yükleme sırası](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/renderer/src/main.tsx).
- A11: [Performans kontrol script'i](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/scripts/verify-performance.ts), [UI kontrol script'i](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/scripts/verify-replica-ui.ts).
- A12: [DB kurtarma](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/db.ts#L52), [workspace writer lease](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/workspace-writer-lease.ts).
- A13: [Yerel sağlayıcı varsayılanları](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/src/main/providers/local.ts#L273).
- A14: [Depo talimatları](https://github.com/saitakarcesme/Akorith/blob/1d5af3abe3036b15e4558697b017970f8f4766b5/AGENTS.md).

## Boyutlar: teşhis bağlamı, başarı hedefi değil

Snapshot'ta `src` altında 208 dosya sayıldı. Aşağıdaki satır sayıları bağımlılıkları veya üretilmiş bundle'ları içermez.

| Dosya | Satır |
|---|---:|
| `styles.css` | 12.533 |
| `product-polish.css` | 1.240 |
| `replica-ui.css` | 5.223 |
| Üç CSS toplamı | 18.996 |
| `App.tsx` | 857 |
| `ChatPanel.tsx` | 1.374 |
| `Sidebar.tsx` | 1.297 |
| `SettingsCenter.tsx` | 1.767 |
| `providers/registry.ts` | 1.136 |
| `db.ts` | 3.132 |

Dosya büyüklüğü tek başına hata değildir. Burada yeniden yapım gerekçesi; ürün durumunun, sağlayıcı işinin ve sunumun fazla iç içe olması ile üst üste gelen stil otoriteleridir. Profil çıkarmadan “bu satır sayısı yavaşlığın nedenidir” denemez.

## Koruma, değiştirme ve emeklilik

**Taşınmaya aday:** canonical path kontrolleri, writer lease ilkesi, Git durum/diff yardımcıları, yönetilen dosya ekleri, redaction, CLI keşfindeki macOS PATH dersleri, SQLite WAL ve kullanım muhasebesindeki kimliklendirme, native preview, PTY süreç temizliği, macOS gerçek paket açılış kontrolü. Aday olmak mevcut kodun yeniden test edilmeden alınacağı anlamına gelmez.

**Yeni sözleşmeyle değiştirilecek:** provider send arayüzü, native oturum eşlemesi, turn lifecycle, context/handoff, tool broker, onay/clarification akışı, renderer store'ları, navigasyon/sağ panel, mesaj parçaları, global CSS düzeni, model capability kataloğu.

**Yeni runtime'dan çıkarılacak:** boş Research/Benchmark sayfaları, sahte özellik katalogları, workspace'in çalışması için zorunlu terminale metin yapıştırma köprüsü, yapay final yazdırma, regex'ten genel ajan eylemi üretme, gereksiz arka plan taraması, eski fazları yeni ürün davranışı gibi dayatan dokümantasyon.

**Kullanıcı verileri:** hiçbir sınıfta toplu silinmez. Eski sohbet, proje, dosya, ayar ve arşivler ayrı veri taşıma planının konusudur.

## Henüz doğrulanmayanlar

Güncel kişisel kaynak checkout'u ve yayımlanmamış değişiklikler; gerçek abonelik listesi ve oturum durumu; kurulu CLI sürümlerinin yeni protokol desteği; yerel model listesi ve RAM tüketimi; mevcut uygulamanın gerçek FPS/gecikme değerleri; macOS Accessibility/Screen Recording izinleri; sağ panelde odak ve kapanış hatalarının canlı tekrarları; eski verinin gerçek migration örnekleri.

Bu başlıklar [ana planın](AKORITH_REBUILD_PLAN.md) ilk kapısına girer. Eksik olmaları ayrıntılı ürün/mimari planı engellemez; fakat uygulama için “bu bilgisayarda tamamen çalışıyor” demeyi engeller.
