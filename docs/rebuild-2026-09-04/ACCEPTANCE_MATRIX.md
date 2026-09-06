# Akorith v1 kabul matrisi

Tarih: 4 Eylül 2026. Aşağıdaki 80 senaryo planlanan kabul koşuludur; bu çalışma sırasında çalıştırılmış veya geçmiş sayılmaz.

Kapsam: bu Mac'te paketlenmiş uygulama. Sağlayıcıya bağlı satırlar, ürünün desteklediğini söylediği her sağlayıcı/model kombinasyonunda uygulanır. Bir yetenek yoksa UI'ın bunu doğru göstermesi ayrıca test edilir; `N/A` seçmek destek vaadini karşılamaz.

Yöntemler: **Domain** = saf davranış testi; **Replay** = kayıtlı olay/protokol; **Electron** = gerçek masaüstü uygulaması; **Canlı** = gerçek provider/model; **Cihaz** = gerçek macOS izin/giriş/süreç davranışı.

## A. Gönderim ve tur yaşam döngüsü

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| A01 | Boş görevde prompt gönder | Bir kullanıcı mesajı, bir request ID ve doğru göreve bağlı bir tur | Electron + Canlı |
| A02 | Hızlı çift Enter / aynı isteğin IPC retry'ı | Tek kalıcı gönderim ve tek provider işi | Domain + Electron |
| A03 | Türkçe, emoji, çok satır ve IME girişi | Metin bozulmaz; composition Enter'ı göndermez | Electron |
| A04 | Gerekli ek dosya hazırlanırken Enter | Eksik dosyalı istek gitmez; anlaşılır bekleme | Electron |
| A05 | Tool çalışırken yeni kullanıcı yönlendirmesi | Destekleniyorsa doğru aktif tura steer; değilse açık kuyruk | Replay + Canlı |
| A06 | Kuyruktaki mesajı düzenle/sırala/çıkar | Gönderilen içerik son kullanıcı seçimiyle aynı | Electron + Domain |
| A07 | İlk token öncesi Stop | UI hemen tepki verir; doğru run iptali doğrulanır | Canlı |
| A08 | Uzun host komutu sırasında Stop | Child process grubu ve araç kuyruğu durur; başka görev etkilenmez | Cihaz |
| A09 | Stop ve final aynı anda gelir | Tek, tutarlı terminal durum; çift final yok | Replay + Domain |
| A10 | Model “tamam” der ama araç hata verir | Gerçek hata/kanıt görünür; uygulama sahte doğrulandı üretmez | Replay |

## B. Süreklilik, izolasyon ve kurtarma

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| B01 | Görev değiştirirken stream sürer | Olay yalnızca ait olduğu göreve yazılır | Electron + Canlı |
| B02 | Renderer reload | Kalıcı mesajlar ve olaylar tek kopyayla geri gelir | Electron |
| B03 | Uygulamayı araç çalışırken kapat/aç | Son kesin kanıt korunur; devam veya kesilmiş durum dürüst | Cihaz + Canlı |
| B04 | Provider process beklenmedik exit | Kullanıcı mesajı kaybolmaz; hata ve uygulanabilir devam yolu | Canlı |
| B05 | Aynı event iki kere gelir | Duplicate kart/metin/usage kaydı oluşmaz | Replay |
| B06 | Sıra boşluğu ve geç event | Doğru uzlaştırma; bilinmeyen durum gizlenmez | Replay |
| B07 | Auth süresi dolar veya kota dolar | Çalışma kaydı korunur; doğru hesap ve çözüm gösterilir | Replay + Canlı |
| B08 | İki görev aynı worktree'ye yazmak ister | Tek writer veya ayrı worktree; sessiz çakışma yok | Domain + Electron |
| B09 | Görevde model/sağlayıcı değiştir | Native oturum ve devir paketi açık; sahte ortak context yok | Canlı |
| B10 | DB yazılamaz/disk dolu | Gönderim kalıcıymış gibi davranmaz; taslak geri kazanılabilir | Hata enjeksiyonu |

## C. Sidebar ve gezinme

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| C01 | Yeni proje/görev aç | Doğru path ve selection; ilk kullanılabilir ekran | Electron |
| C02 | Pin ve sıra değiştir, app'i yeniden aç | Pin/sıra/selection korunur | Electron |
| C03 | Arka plan görevi sürekli event üretir | Sidebar satırları sürekli yer değiştirmez | Replay + Electron |
| C04 | Görevi rename; Enter/Escape | Uygula/vazgeç ve focus dönüşü doğru | Electron |
| C05 | Arşivle ve geri al | Veri kaybolmaz; çalışan iş davranışı açık | Electron |
| C06 | Sidebar kapalıyken komut paleti | Palet ve kısayollar tam çalışır | Electron |
| C07 | Sidebar genişlet/daralt, sonra küçük pencere | Manuel tercih responsive değişiklikle ezilmez | Electron |
| C08 | 1.000 görev ve uzun başlıklar | Arama/seçim akıcı, satır taşması ve yanlış hedef yok | Electron + Perf |
| C09 | Proje klasörü taşınmış | Yeniden konumlandırma; geçmiş/kimlik korunur | Cihaz |
| C10 | Sağ tık ve klavyeyle aynı eylem | Aynı komut/izin davranışı, stabil focus | Electron |

## D. Transcript, çıktı ve erişilebilirlik

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| D01 | Metin, commentary ve araçlar karışık gelir | Ayrı tiplerde doğru sıra; aynı tool kartı güncellenir | Replay |
| D02 | Provider finali tek parça verir | Tam metin gereksiz yazma gecikmesi olmadan erişilir | Electron |
| D03 | Geçmişi okurken yeni token gelir | Scroll korunur; yeni içerik göstergesi var | Electron |
| D04 | Görsel yüklenir/araç ayrıntısı açılır | Viewport anchor ve seçili metin korunur | Electron |
| D05 | 10.000 mesaj, uzun kod, geniş tablo | Ana sayfa yatay taşmaz; bütçeli render | Electron + Perf |
| D06 | Kodu/metni kopyala | Kopyalanan içerik doğru; odak ve konum korunur | Electron |
| D07 | Dosya/satır/artifact bağlantısı aç | Doğru hedef ve panel; eksik dosyada açık hata | Electron |
| D08 | Sadece klavyeyle görev tamamla | Menü, composer, panel ve onay erişilebilir | Electron |
| D09 | VoiceOver ve %200 UI zoom | İsim/sıra/odak anlaşılır; temel eylemler kaybolmaz | Cihaz |
| D10 | Light/dark ve Reduced Motion | Eşdeğer bilgi, kontrast ve işlev; azaltılmış hareket | Electron |

## E. Sağ panel, dosya, diff ve terminal

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| E01 | Aynı dosyayı iki kez aç | Aynı sekme yeniden kullanılır; pin davranışı doğru | Electron |
| E02 | Paneli kullanıcı kapatır; tool event gelir | Tekrar tekrar kendiliğinden açılmaz | Replay + Electron |
| E03 | Otomatik panel açılırken prompt yaz | Composer odağı çalınmaz | Electron |
| E04 | Paneli sürükleyerek yeniden boyutlandır | Titreme, taşma, negatif ölçü ve ağır render yok | Electron + Perf |
| E05 | Native browser üstünde modal/menu aç | Katman, görünürlük, focus ve tıklama doğru | Electron |
| E06 | Browser panelini gizle/yeniden aç | Gereksiz reload yok; sayfa ve seçim durumu korunur | Electron |
| E07 | Terminal resize + Unicode + yoğun stdout | Girdi/çıktı bozulmaz; scrollback bounded | Cihaz |
| E08 | Terminal gizle/kapat/işi durdur | Üç eylemin süreç üzerindeki farkı doğru | Cihaz |
| E09 | Önceden dirty repo'da agent dosya değiştirir | Önceki kullanıcı değişikliği agent'a mal edilmez | Canlı + Git |
| E10 | Kullanıcı değişikliği sonrası checkpoint undo | Dosya ezilmez; conflict/diff gösterilir | Domain + Cihaz |

## F. Provider, yerel model ve entegrasyon

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| F01 | CLI kurulu ama auth yok | Kurulu/girişli/kullanılabilir durumları ayrılır | Canlı |
| F02 | Model/effort kataloğu değişir | Eski seçim açıkça çözümlenir; sessiz model değişmez | Replay + Canlı |
| F03 | İkinci abonelikle aynı workspace işi | Aynı ürün akışı, doğru faturalama/oturum kimliği | Canlı |
| F04 | Yerel modelle dosya oku/düzenle/test sonucu kullan | Gerçek tool döngüsü; sadece sohbet cevabı değil | Canlı |
| F05 | Yerel model bozuk tool JSON'u üretir | Kontrollü hata/onarım sınırı; rastgele eylem yok | Replay |
| F06 | Yerel model context veya bellek sınırına gelir | App kullanılabilir; hata ve çözüm net | Cihaz + Canlı |
| F07 | Yerel üretim devam ederken ikinci iş | Kaynak politikası/queue doğru; UI bloke olmaz | Canlı + Perf |
| F08 | Local bağlantı kesilir | Ücretli buluta izinsiz geçmez; veri korunur | Hata enjeksiyonu |
| F09 | Kullanıcıya ait Ollama açıkken Akorith kapanır | Harici servis öldürülmez | Cihaz |
| F10 | MCP aracı/skill ekle, çağır, devre dışı bırak | Gerçek yetenek listesi, izin ve lifecycle doğru | Contract + Canlı |

## G. Browser ve macOS computer use

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| G01 | Yerel test uygulamasını aç/gözlemle/düzelt | Sayfa sonucu geri okunur; sadece URL açmakla bitmez | Canlı |
| G02 | Genel web testinde gez ve form doldur | Doğru tab/profil, eylem sonrası doğrulama | Canlı |
| G03 | Browser sekmesi kapanır/değişir | Eski tab ID ile başka hedefe eylem yapılmaz | Electron |
| G04 | Popup/login/indirme/hata sayfası | Açık yaşam döngüsü ve kullanıcının devralabilmesi | Electron |
| G05 | Web sayfası host yetkisi isteyen metin gösterir | İçerik talimat/yetki haline gelmez | Replay + Browser |
| G06 | Accessibility/Screen Recording izni eksik | Doğru eksik izin ve kurulum yolu; sahte başarı yok | Cihaz |
| G07 | TextEdit'te test belgesi düzenle | Doğru uygulama, doğru metin, okunan sonuç | Cihaz + Canlı |
| G08 | Finder test klasörünü aç/seç | Hedef pencere ve dosya doğrulanır | Cihaz + Canlı |
| G09 | Retina ölçeği/pencere konumu değişir | Eski koordinatla yanlış yere tıklanmaz | Cihaz |
| G10 | Kullanıcı devralır/acil Stop yapar | Giriş kuyruğu durur; kontrol net biçimde kullanıcıda | Cihaz |

## H. Migration, paket ve performans

| ID | Senaryo | Beklenen sonuç | Yöntem |
|---|---|---|---|
| H01 | Eski WAL DB'den yedek ve V2 import | Tutarlı yedek, row/reference doğrulaması | DB fixture + Cihaz |
| H02 | Aynı veriyi tekrar import et | Kopya mesaj/görev yok; iptal sonrası devam mümkün | Domain + DB |
| H03 | Import sonrası eski app'e geri dön | Eski veri açılır; yeni şema eski app'i bozmaz | Cihaz |
| H04 | Finder'dan paketlenmiş app aç | PATH, native modül, helper ve icon/name doğru | Cihaz |
| H05 | Warm/cold launch ve boşta bekleme | Ana plandaki süre/CPU/bellek hedefleri ölçülür | Perf |
| H06 | Uzun chat + diff + browser + local model | Etkileşim/scroll bütçesi ve sistem bellek baskısı kaydı | Perf + Cihaz |
| H07 | Ağ kesilmesi, sleep/wake | Geçmiş erişilir; aktif işler dürüstçe uzlaştırılır | Cihaz |
| H08 | 2 saat tekrar aç/kapat/stream/sekme deneyi | Süreç sızıntısı yok; bellek büyümesi incelenmiş | Perf + Cihaz |
| H09 | Provider, terminal ve app kapat | Yetim child process/port yok; kullanıcı servisi korunur | Cihaz |
| H10 | En az 5 gerçek çalışma oturumu | Kritik açık yok; sorunlar kanıtla kayıtlı; günlük kullanım mümkün | Günlük kullanım |

## İlk uçtan uca demo

1. Ayrı bir test projesi aç; başlangıç Git durumunu kaydet.
2. Codex ile küçük bir özellik değişikliği iste.
3. Gerçek commentary, araç ve dosya değişikliklerini izle; bir ara yönlendirme yap.
4. Diff'i sağ panelde aç; dosya ve satır bağlantılarını kullan.
5. Projeyi browser'da aç; sonucu oku, gerekirse aynı görevden düzelt.
6. Uzun bir kontrollü işi durdur; süreç temizliğini doğrula.
7. Uygulamayı kapat/aç; taslak, görev, çıktı ve panel durumu geri gelsin.
8. Aynı tür işi doğrulanmış ikinci abonelik ve yerel modelle tekrarla.
9. Native macOS kontrolünü test verileriyle çalıştır; devralma ve acil durdurmayı dene.

## Sonuç kaydı şablonu

Her satır için: `scenarioId`, build SHA, paket/OS sürümü, provider+CLI+model sürümü, fixture/başlangıç hali, işlem adımları, beklenen sonuç, gözlenen sonuç, ölçüm yöntemi, kanıt yolu, pass/fail/blocked/not-run, issue ve tekrar test sonucu.

Test bütçesi temsilî kullanımın üzerinde yük içerir; her kombinasyonun körlemesine çarpımı değildir. Veri kaybı, yanlış hedefte işlem, yanlış durum, durmayan iş ve kritik izin hatası release engelidir. Estetik/polish sorunları da kullanıcı akışına etkisine göre önceliklendirilir; sadece screenshot farkı olarak kapatılmaz.
