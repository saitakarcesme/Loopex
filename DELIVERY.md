# Akorith Next — B09 geliştirme teslimi

Kaynak branch: `rebuild/codex-interaction-parity`. Paket kaynak commit: `02eb7b5`. Sürüm: `2.0.0-alpha.9`.

`Open Akorith Next.command` bu bilgisayardaki B09 paketini ayrı geliştirme verisiyle açar. Eski kurulu Akorith ve geçmişi değiştirilmedi. Uygulama şu anda bu profil ile açık.

## Doğrulananlar

- 275/275 kaynak testi ve TypeScript kontrolü geçti; Mac ARM64 paket imzası deep/strict doğrulandı (ad-hoc, notarize değil).
- Birleşik model seçimi, sidebar gezinmesi, panel geçişleri ve gerçek tur/araç/onay altyapısı.
- Gerçek managed skill/MCP: V1 → V2 → disable; her turda kullanılan bağlam ve sağlayıcı teslim kayıtları.
- Native yeni proje oluşturma, metadata rename ve yeniden açılışta kalıcılık.
- @README klavye seçimi, snapshot eki, istemeden gönderim olmaması ve gerçek OpenCode okuması.
- Panel kapalıyken gerçek browser screenshot: 2200×1600; hata/iptal/görev değişimi için ayrıca Electron piksel ve kaynak temizliği testleri.
- Uygulama içinden üretilen service-desk ve inventory-worker projeleri: gerçek sağlayıcı kod üretimi ve öncesinde başarısız, düzeltmeden sonra başarılı regresyon testleri.

## Henüz tamamlanmayanlar

Codex'in tüm görsel/geçiş ayrıntılarıyla birebir parite ve karşılaştırılabilir performans kabulü tamamlanmadı. Tüm abonelikler için evrensel bağlantı garantisi yok: Claude doğrulanmadı, OpenCode Go bakiye hatası verdi; küçük yerel model gerçek denemede çıktı sınırına ulaştı. Codex ve OpenCode Zen gerçek proje turlarını tamamladı.

Eski özellik haritasında kalan yönlendirilmiş giriş, çoklu endpoint profilleri, kalıcı hedef/bellek/ilişkili alt görevler, ürün otomasyonu, uzak çalışma alanı, medya, güncelleme ve gerçek eski veri göçü işleri açık. Tam bilgisayar kullanımı izin/kabulü de açık. Bu nedenle paket henüz Codex'i tamamen bırakma tavsiyesi değildir.

Kanıtlar: `/Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B09/package-receipt.json`.

Detaylı kapsam: `docs/rebuild-2026-09-04/LEGACY_FEATURE_MAP_2026-09-06.md`. Bu çalışma için tekrarlayan otomasyon kurulmadı.
