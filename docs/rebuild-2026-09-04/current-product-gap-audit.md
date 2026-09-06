# Güncel ürün kapsamı denetimi

5 Eylül 2026, 03:23 UTC. Bu rapor B02 için dondurulan V2 kaynağının normal dosya yolundan yeniden okunmasına dayanır. **Çalışan çok sağlayıcılı workspace temeli var; kapsamlı plugin, otomasyon, hedef, alt ajan, bellek, medya ve uzak çalışma paritesi tamamlanmış değil.** Bu inceleme ürün kodunu değiştirmedi, uygulama/model/native test veya dış servis başlatmadı.

Kaynak: `rebuild/workspace-v2`; taban HEAD `1d5af3abe3036b15e4558697b017970f8f4766b5`. V2 değişiklikleri çalışma ağacında olduğundan HEAD tek başına incelenen kodun veya paketin kimliği değildir. B02 paket kabulü root tarafından ayrı yürütülüyor; aşağıdaki durumlar **kaynakta bulunan ürün davranışı** için verilmiştir, B02 test sonucu değildir.

## Kapsamın nereden geldiği

- [İlk plan §18.1](AKORITH_REBUILD_PLAN.md#181-mcp-skills-ve-bağlantıların-gerçek-çalışması), [G4](AKORITH_REBUILD_PLAN.md#g4--çoklu-sağlayıcı-ve-yerel-model) ve [F10](ACCEPTANCE_MATRIX.md#f-provider-yerel-model-ve-entegrasyon) küçük ama gerçek skill/MCP yönetimini v1'e dahil ediyor. Kaynak, kapsam, sağlayıcıya aktarım, gerçek araç çağrısı ve lifecycle bu vaadin parçası.
- İlk plan §7 bağlam/devri; §12 Markdown ve artifact açmayı; §18 adlandırılmış uzak Ollama profilini tanımlıyor. Bu alanlardaki eksikler doğrudan ilk planla karşılaştırılabilir.
- İlk plan §26 public marketplace, bulut senkronizasyonu ve mobil uygulamayı başlangıç önceliği dışında tutuyor. Otonom uzun işleri temel motor sağlamlaştıktan sonraya bırakıyor. Tam automation sayfası, yönetilen goal, alt ajan ilişkileri ve kullanıcı belleği daha sonraki [parite incelemesinin](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Parity Review/PARITY_REVIEW_01.md>) P23–P28 kabul hedefleridir. Bunları ilk planda açıkça vaat edilmiş tamamlanmış özellik gibi değerlendirmek doğru olmaz.
- Kullanıcının “tek uygulamaya tamamen geçebilme” hedefi bu açıkları görünür tutmayı gerektirir. Geliştirme sırasında kullanılan Codex heartbeat'i, bu alt ajan veya Codex plugin araçları Akorith ürün özelliği sayılmaz.

Karşılaştırılan [PARITY_INVENTORY.json](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-05/parity/PARITY_INVENTORY.json>) B01'e aittir: `2.0.0-alpha.1 arm64`, `app.asar` SHA-256 `373fb3e394d71ba4bf68ee73c52fe8c0baab6df535a6be4c7577ee831c68decf`. Oradaki “last-known implementation; not current reread” kaynak sınırı bu rapordaki yeniden okumayla giderildi; B01'in gözlemleri B02'ye taşınmadı. Envanter dosyası değiştirilmedi.

## Kısa durum tablosu

| Alan | Güncel kaynak sınıflandırması | Gerçek UI girişi | Tamamlanmamış ürün akışı |
|---|---|---|---|
| P18 skills/plugins/MCP | Kısmi | Settings → Skills; Settings → MCP servers | Akorith'e ait plugin paketi/sürümü/bağımlılığı; etkili tur bağlamı; MCP kapsam/auth/uzak transport |
| P23 automations | Eksik | Yok | Kalıcı zamanlama, run-now/pause/resume, çalışma geçmişi, kaçırılan çalışma politikası |
| P24 goals/plans | Kısmi, yalnız native plan sunumu | Transcript içinde açılır Codex plan aktivitesi | Kalıcı hedef/kabul ölçütü, bütçe, pause/resume ve kanıta bağlı iterasyon |
| P25 agents/subtasks | Kısmi, yalnız native araç aktivitesi | Transcript içinde `Agent · …` satırı | Parent/child ilişkisi, alt göreve gitme, sonuç birleştirme ve kontrollü toplu durdurma |
| P26 instructions/memory/wiki | Kısmi | Skills ayarları; proje AGENTS.md dosyası normal dosya panelinde açılabilir | Etkili talimat/kapsam/öncelik görünümü, yönetilen bellek, kaynaklı ve güncelliği izlenen wiki |
| P27 media | Kısmi | Ek düğmesi; Markdown/kod; yerel görsel; Files paneli | Ek açma tutarsızlığı, belge önizlemesi, yapılandırılmış artifact sonuçları, ses/görsel üretim akışı |
| P28 remote continuation | Eksik; uzak model endpoint'i ayrı mevcut alt özellik | Connections → Ollama endpoint | Akorith host eşleme/auth, görev aktarımı, uzak dosya/süreç sahipliği, yeniden bağlanma |

P23 ve P28, önceki kanıt yetersizliğinden kaynakta eksik sınıfına indirgenebilir. P24/P25 için mevcut native aktiviteyi yok saymak yerine dar kısmi destek kaydı korunmalı; yönetilen goal/agent ürünleri yine eksiktir.

## P18 — Skills, plugins ve MCP

**Kaynakta mevcut.** [SettingsDialog.tsx](../../v2/renderer/src/components/SettingsDialog.tsx) dört sekme tanımlıyor: General, Connections, Skills, MCP servers. [SkillsSettings.tsx](../../v2/renderer/src/components/settings/SkillsSettings.tsx) arama, enable/disable, kaynak etiketi ve dosya yolunu gösteriyor. [extensions.ts](../../v2/main/extensions.ts) kişisel `.agents/skills`, `.codex/skills`, kurulu Codex plugin cache'i ve her proje `.agents/skills` dizinini okuyor; proje skill'ini yalnız eşleşen proje turlarına ekliyor. Kod bu yabancı runtime dizinlerine yazmıyor.

[McpSettings.tsx](../../v2/renderer/src/components/settings/McpSettings.tsx) executable/argüman ekleme, düzenleme, kaldırma, etkinlik, probe, araç adları ve son hatayı gösteriyor. [index.ts](../../v2/main/index.ts) `skills:list`, `skills:toggle`, `mcp:save`, `mcp:probe`, `mcp:remove` komutlarını uyguluyor. Probe artık sahip olunan süreç kapanmadan `ready` dönmüyor; [extensions-lifecycle.test.ts](../../v2/tests/extensions-lifecycle.test.ts) kapanış/timeout/EPERM ve geç Store erişimlerini sınayan testleri içeriyor. Bunların varlığı, bu denetimde tekrar test veya paket kabulü anlamına gelmez.

Codex/Claude/OpenCode seçili stdio sunucularını native konfigürasyonlarına alıyor. [mcp-client.ts](../../v2/main/providers/mcp-client.ts) Ollama için discovery/call/cancel ve read/work/full davranışını uyguluyor; [ollama.ts](../../v2/main/providers/ollama.ts) başlangıçta altı araç ve araç aramasıyla sınırlı katalog kullanıyor. Native sağlayıcılar kendi katalog/izin davranışlarının sahibi. Codex'te otomatik skill talimat kataloğu kapatılıyor ve seçili içerik açıkça veriliyor; Claude/OpenCode için aynı native talimat yükleme eşdeğerliği kaynakta ayrıca ispatlanmış değil.

**Eksik.** `SkillInfo` yalnız ad, açıklama, kaynak, yol, proje ve enabled taşıyor. Plugin kimliği, manifest, sürüm, bileşen, bağımlılık, yükleme/update/uninstall kaydı yok. “Installed plugins” bir skill kaynağı etiketidir; plugin yöneticisi değildir. Tüm plugin kaynakları içinde aynı isimle gelen skill'ler `source + name` ile birleşiyor, sürüm yolu sıralanıyor; plugin kimliğini veya manifest uyumluluğunu çözmüyor. Bir skill'in tarif ettiği connector/araç kurulu değilse bunu yakalayan bağımlılık çözümü yok.

`McpServer` sadece `command/args` tabanlı; URL transport, kimlik doğrulama/OAuth durumu, gizli değişken referansı veya proje kapsamı yok. Tüm etkin sunucular sonraki turlara global ayardan aktarılıyor. UI tam araç şemasını veya seçilen sağlayıcıda fiilen yüklenen araçları göstermiyor. Local MCP sunucu kaynaklı sampling/elicitation/roots isteklerini desteklenmiyor diye reddediyor; bunlar genel MCP desteği diye sunulmamalı. Katalog probe'u ile bir aracın gerçekten başarıyla çağrılması farklı kabul adımları.

**En küçük tamamlanabilir dilimler — öneri, mevcut API değil.**

1. **Etkin bağlam/araç inceleme:** `ContextManifest {taskId, turnId?, providerId, sources:[{id,kind,scope,path,hash,included,omittedReason}], tools:[{serverId,name,availability}]}` ve `context:inspect`. Composer'da küçük “Context” açılır yüzeyi; skill kartında içerik ve kapsam. Tur kabulünde manifest sürümü kaydedilir; UI “enabled” ile gerçekten o turda aktarılanı ayırır. Kaynak değişimi ve truncation görünür olur. Dosya içeriğini sorgusuz tüm uygulamalara veya turlara aktarmak yerine mevcut görev sınırı korunur.
2. **Yerel plugin paketi:** kendi `userData/plugins` kökü, `PluginInfo {id,version,origin,components,dependencies,unsupportedFields,state}`; `plugins:inspectLocal/import/list/setEnabled/remove`. Önce seçilen yerel klasörün manifest/içerik önizlemesi, sonra yalnız Akorith'in sahip olduğu kopya. İlk kapsam skill + stdio MCP; desteklenmeyen bileşen görünür. Version update aynı id için ayrı kopyadan atomik geçiş; başka uygulamanın cache'ine dokunulmaz. Public marketplace bu dilimin şartı değildir.
3. **MCP kapsamı:** mevcut stdio yolunu `scope: global|project`, transport discriminant ve doğrulanmış şema bilgisiyle genişlet. Sonraki ayrı dilim yalnız gerçekten desteklenecek bir uzak transport ve onun auth akışı olsun; URL alanı ekleyip bütün connector'ları çalışır ilan etmek yeterli değil.

**Kabul:** iki projeli disposable fixture; yalnız A'da etkin skill'in A'nın gerçek tur bağlamına girmesi, B'ye girmemesi, disable sonrası çıkarılması. Local plugin v1→v2→disable/remove ve desteklenmeyen alanın açık görünmesi. MCP read/write araçlarının gerçek etkisi, Inspect reddi/Work onayı, timeout/Stop/normal Quit ve silinen sunucunun yeni tura yüklenmemesi. Dış hesabı olmayan yerel fixture ile ilk iki dilim tamamlanabilir.

## P23 — Uygulamaya ait automations

**Kaynak kanıtı.** [contracts.ts](../../v2/shared/contracts.ts), [storage.ts](../../v2/main/storage.ts), [index.ts](../../v2/main/index.ts), [App.tsx](../../v2/renderer/src/App.tsx) ve bütün V2 ürün dosyalarındaki zamanlama taraması automation entity, komut, scheduler veya UI göstermiyor. [engine.ts](../../v2/main/engine.ts) `send` ile kalıcı tur kabul ediyor ve `pump` hazır kuyrukları yürütüyor; saat/takvim zamanı hesaplamıyor. Aktif yerel model tekilleştirmesi ve workspace writer lease zaten var; yeniden yazılmamalı.

**En küçük dilim:** uygulama açıkken çalışan yerel, aynı göreve devam eden zamanlama. `Automation {id,taskId,prompt,schedule,timeZone,enabled,nextRunAt,executionProfile,missedPolicy,overlapPolicy}` ile `AutomationRun {id,automationId,scheduledFor,requestId,turnId?,status,error}` kalıcılaşmalı. `automations:list/save/pause/resume/runNow/remove/history` ve sakin bir liste/detay yüzeyi eklenmeli. `automationId + scheduledFor` benzersiz claim, motorun mevcut request ID kabulüne bağlanmalı; ikinci bir provider yürütücüsü kurulmamalı. Çalışma seçimi bir snapshot olmalı; scheduler mevcut task'ın provider/modelini yan etkili biçimde değiştirmemeli.

İlk politika açık olabilir: uygulama kapalıyken iş çalışmaz; açılış/uyanışta kaçırılan işler kayda `skipped` yazılır veya açıkça seçilmiş `run-once` politikası uygulanır; aynı automation aktifken overlap atlanır. Bu koşullar UI'da görünmeli. Sleep, DST ve offline durumları “başarılı çalışma” sayılmamalı. Onay/soru mevcut motor kartında bekler; hesap/bakiye sorununda başka sağlayıcıya sessiz geçilmez. Stop aktif turu, Pause gelecekteki tetikleri etkiler; ikisi ayrıdır.

**Kabul:** kontrollü saatle aynı occurrence iki kez tetiklenince tek accepted turn; create/edit/pause/restart/run-now ve geçmiş; DST ileri/geri, sleep/wake, aktif iş çakışması, auth hatası, Stop ve normal Quit. Fixture ile scheduler denenebilir; gerçek provider kabulü mevcut desteklenen bağlantıyla ayrı yapılır. İşletim sistemi arka plan servisi ve cihazı uyandırma ilk dilimde yoktur.

## P24 — Kalıcı goal ve plan

**Mevcut alt özellik.** [codex.ts](../../v2/main/providers/codex.ts) `turn/plan/updated` olayını adım işaretleriyle `Activity.kind='plan'` yapıyor. [Transcript.tsx](../../v2/renderer/src/components/Transcript.tsx) bunu açılır Markdown olarak gösteriyor; mesaj aktivitesiyle kaydediliyor. Dolayısıyla “hiç plan yok” doğru değil. Ancak adımlar bağımsız kimlikli kalıcı plan entity'si değil; genel metin alanı. Task'ta hedef, kabul ölçütü, iterasyon, bütçe veya goal durumu yok. `completed` bir tur sonucu; uzun hedefin gerçekleştiğine dair ürün kararı değil.

**İlk dilim:** görev üstünde katlanabilir `Goal {id,taskId,objective,criteria,steps,state,revision,evidenceRefs,budget}` kartı; `goals:create/read/update/pause/resume/stop`. Kullanıcı düzenlemesi CAS revision ile; provider planı `source:'provider'`, kullanıcı adımı `source:'user'` olarak ayrılır. Kabul ölçütüne mesaj/komut/checkpoint referansı bağlanır. İlk teslim yalnız kalıcı hedef takibi olabilir; bu durumda otonom devam varmış gibi gösterilmez.

**İkinci, otonom dilim:** mevcut motor üstünde açıkça başlatılmış sınırlı iterasyon. Her tur sonrası devam/blocked/completed kararı ve dayanağı kaydedilir; genel “devam et” timer'ı olmaz. Turun başarılı bitmesi goal'u kendiliğinden tamamlamaz. Kesin ölçülemeyen token/maliyet için sahte sert bütçe yerine doğrulanabilen tur/zaman sınırı uygulanır; kaynak kullanımının kapsamı görünür olur. Bütçe dolması, pause, stop, failure ve blocked birbirinden ayrılır.

**Kabul:** plan düzenle→restart→aynı sıra/durum; başarısız/iptal edilmiş tur hedefi complete yapmaz; kanıtı eksik hedef açık kalır; sınırlı iterasyon durur ve yeniden açılışta otomatik çift tur oluşmaz. Native gizli düşünce verisine erişim gerekmez; açık plan olayları ve kullanıcı hedefi yeterlidir.

## P25 — Ajanlar ve alt görevler

**Mevcut alt özellik.** Codex `collabAgentToolCall`, `Agent · tool` başlığı ve prompt ayrıntısıyla genel tool kartına dönüşüyor. Native child thread kimliği, ilişki, sonucu açma veya tek child'ı durdurma UI sözleşmesine taşınmıyor. Claude/OpenCode araç olayları da genel kartlarda. Task şeması parent/child tutmuyor; sidebar tüm task'ları proje/standalone gruplarında gösteriyor. Birden çok chat ve mevcut lease yönetimi, ürün içi alt ajan koordinasyonu değildir.

**İlk dilim:** Akorith'e ait açıkça başlatılmış iki sınırlı salt okuma alt görevi. `TaskRelation {parentTaskId,childTaskId,createdBy,scope,status,resultMessageId?}`; `tasks:delegate/listChildren/stopChild`. Parent içinde iki küçük durum satırı ve gerçek göreve gitme bağlantısı; kısmi sonuç ve hata kalıcı. Child sonucu parent'a kaynak mesaj kimliğiyle bağlanır, parent'ın başarı metni diye kopyalanmaz. Yerel model concurrency kuralı ve çalışma alanı lease'i korunur. Aynı proje yazıcıları için mevcut serialization kullanılır; gerçek worktree oluşturma ayrı Git dilimine bağlıdır.

Parent Stop davranışı açık seçim/sözleşme ister: yalnız parent veya ona ait çocuklar dahil. Toplu Stop, her child'ın gerçek cleanup sonucu gelmeden bitmiş sayılmaz. Başka kullanıcı görevi etkilenmez. Native provider alt ajanları ayrı `origin:'native'` ilişki olarak, yalnız protokolün sunduğu ölçüde gözlenebilir; Akorith-owned child kontrolü varmış gibi davranılmaz.

**Kabul:** iki read child, bir başarısız child, parent sonuç bağlantıları, restart sırasında interrupted çocuk, yalnız scoped stop, writer çakışmasının engellenmesi. Önce fake provider/host fixture; sonra desteklenen bir gerçek sağlayıcıda iki bounded iş. Otomatik persona kataloğu veya yeni bir ajan framework'ü gerekmiyor.

## P26 — Talimatlar, memory ve wiki

**Mevcut.** `extensions.context(task)` proje kökü `AGENTS.md` içeriğini ve etkin/projeye uygulanabilir skill'leri yüklüyor. Kaynak yolu metne ekleniyor; host ilgili skill dizinlerini salt okuma kökü olarak açabiliyor. `Store.continuity` önceki native turdan sonraki konuşmayı sınırlandırılmış devir metnine dönüştürüyor. Tüm native adapter'lar bu metni ayrı current request etiketiyle alıyor. Bu geçmiş aktarımıdır; kullanıcı tarafından yönetilen memory entity'si veya wiki değildir.

**Eksik.** Hangi global/proje talimatının hangi sağlayıcıda fiilen etkili olduğu, öncelik ve tur bazında içeriğin hash'i gösterilmiyor. Akorith context yükleyicisi global AGENTS/nested talimat ağacını çözmüyor; native sağlayıcının kendi yüklediği dosyalar ayrıca olabilir. Proje AGENTS.md `slice(0,40000)` ile kısalıyor ve bu kaynağa özel görünür truncation kaydı yok. Skill bütçesi `text.length` üzerinden 64000 **JS kod birimi**; eski envanterdeki “explicit byte budgets” ifadesi bu yükleyici için doğru değil. Ollama'nın sonraki context paketlemesinde gerçek UTF-8 byte bütçesi ayrı mevcut.

**İlk dilim:** P18 `ContextManifest` paylaşılmalı. “Instructions” yüzeyinde global/proje/görev kaynakları, kullanılan sürüm/hash, uygulanmama nedeni, sıralama ve truncation gösterilsin. AGENTS dosyası açık kullanıcı düzenlemesiyle mevcut CAS editöründe değiştirilebilsin; etkinlik ile native provider'ın kendi talimat yüklemesi ayrıştırılsın. Kaynak okunamadı diye sessizce tam talimat uygulanmış izlenimi verilmesin.

**İkinci dilim:** kullanıcı tarafından eklenmiş, proje/global kapsamlı `MemoryItem {id,scope,projectId?,title,content,revision,enabled,updatedAt,sourceRefs}` ve CRUD. İlk sürümde otomatik kişisel veri taraması veya sessiz memory yazımı yok. Context'e yalnız etkin ve açık kapsamlı kayıtlar dahil olur; silinen kayıt sonraki turdan çıkar. Wiki gerekiyorsa aynı kaynak modeli üstünde proje dosyası hash'i ve son doğrulama zamanı izlenir; dosya değişince “outdated” görünür. Wiki başlığı açıp boş sayfa yapmak tamamlanmış dilim değildir.

**Kabul:** bilerek çelişen fixture talimatları, Türkçe/emoji byte sınırı, eksik/taşınmış kaynak, A/B proje izolasyonu, edit/delete/restart ve native provider farkı. Konuşmada bir kelimenin hatırlanması bu kabulün yerine geçmez.

## P27 — Artifact, görüntü, belge ve ses

**Mevcut.** [Markdown.tsx](../../v2/renderer/src/components/Markdown.tsx) GFM/kod kopyalama, dosya bağlantısı ve yerel görüntü sunuyor. [files.ts](../../v2/main/host/files.ts) gerçek byte imzasıyla PNG/JPEG/GIF/WebP/AVIF için 12 MB sınırında `files:media` sağlıyor; SVG kaynak metni. [FileEditor.tsx](../../v2/renderer/src/panels/FileEditor.tsx) workspace görüntülerini ve metni açıyor. HTTP(S) görseller otomatik yüklenmek yerine dış linkle açılıyor.

Ek picker'ı 20 dosya/25 MB sınırıyla göreve ait kopya oluşturuyor. PNG/JPEG/WebP görseller adapter'a görüntü olarak veriliyor; PDF ve diğer dosyalar genel dosya referansı. Native adapter'lar görüntü girdisi taşıyor; Ollama gerçek seçili modelin vision kabiliyetini kontrol edip yoksa açık hata veriyor. [mcp-bridge.ts](../../v2/main/providers/mcp-bridge.ts) host screenshot'ını image content'e dönüştürüyor; [mcp-client.ts](../../v2/main/providers/mcp-client.ts) bir MCP sonuç görüntüsünü modele taşıyabiliyor. Bunlar görüntü üretimi veya sesli çalışma kanıtı değil.

**Somut açma kusuru.** Transcript ek chip'i `onOpenFile(attachment.path)` çağırıyor; [FilesPanel.tsx](../../v2/renderer/src/panels/FilesPanel.tsx) önce `files:read` çağırıyor. [host/index.ts](../../v2/main/host/index.ts) renderer `files:read` için yalnız workspace kökünü kabul ediyor; attachment kopyası ayrı userData kökünde. `files:media` ise o görevin attachment kökünü okuyabiliyor. Böylece desteklenen ek görüntüsünün media yolu mevcutken sağ panel açma yolu reddedilebilir. Markdown görüntüsünün “Open image” eylemi de genel dosya yoluna gidiyor. **Bu denetim anında kaynak kusuru; root ayrı B03 düzeltme dilimini yetkilendirdi, henüz bu raporda uygulanmış sayılmıyor.** Çözüm salt okunur, task-scoped attachment preview; editable workspace dosyasına dönüştürmek veya path sınırını kaldırmak değil.

**Diğer eksikler.** PDF/DOCX/XLSX/ses/video için yapılandırılmış artifact entity, yerel önizleyici ve üretim işi/cancel/progress yok. Binary file ekranında açıklama ve Finder reveal var; doğrudan “kendi uygulamasında aç” API'si yok. PDF MIME kabulü belgeyi modele native document olarak göndermiyor veya önizlemiyor. Local MCP çoklu image sonucunu reddediyor; audio content'i için ürün akışı yok. `capturesAudio=false` olan native screen capture ses kaydı değildir. `ProviderInfo.capabilities.images` görsel girdi seviyesinde; image generation/TTS/STT yeteneği tanımlamıyor.

**Dilimler:**

1. Mevcut task media API'siyle doğru ek önizlemesi; desteklenmeyen dosya için anlaşılır durum. Dosya ve ek eylemlerinin yazma/reveal yetkisi birbirine karışmasın.
2. `ArtifactRef {id,taskId,turnId,kind,mimeType,localPath?,sourceToolCallId,status}`; güvenli yerel raster + PDF önizlemesi, belge için açık dış uygulama açma. Dosya taşınmışsa broken artifact; URL'yi indirmek için otomatik yan etki yok. Provider tool sonucu binary metin dump'ı yerine artifact'e dönüşsün.
3. Yalnız doğrulanmış gerçek tool/adapter için image generation veya ses üretimi. `mediaCapabilities` model/tool bazlı; global “Images” işareti bunları kapsamasın. Ses kaydı ayrı user-start/recording/stop/cancel ve microphone izni gerektirir. Ücretli servis veya hesap bağlantısı kurulmadan çalışıyor iddiası yapılamaz.

**Kabul:** doğru görev görsel eki, yanlış görev/path reddi, büyük/bozuk görüntü, PDF/binary dürüst fallback, restart sonrası artifact referansı, görünür recording/cancel ve gerçek çağrının çıktısı. Bu denetimde medya üretilmedi veya mikrofon açılmadı.

## P28 — Uzak cihaz ve aktarım

**Mevcut ve ayrı.** [ConnectionsSettings.tsx](../../v2/renderer/src/components/settings/ConnectionsSettings.tsx) tek Ollama endpoint'ini düzenliyor; [ollama.ts](../../v2/main/providers/ollama.ts) loopback dışını `Remote Ollama` diye etiketliyor. Model başka cihazda üretebilir; Akorith task dosyaları ve host araçları yine bu Mac'tedir. OpenCode'un `type:'remote'` MCP tanımı da aynı Mac'teki bearer korumalı loopback host bridge'idir. İkisi uzak Akorith workspace kontrolü değildir.

**Eksik.** Host kimliği/auth, pairing/revoke, remote workspace eşlemesi, görev/ek transferi, reconnect/cursor, tek yürütme sahibi veya uzaktan UI yok. `Task` yalnız yerel `projectId`, `Store` yerel DB, `RunRequest` yerel cwd tutuyor. Tek global Ollama URL'si, ilk plandaki adlandırılmış endpoint profili de değildir; kuyruk kabulünde endpoint kimliği snapshot'ı kaydedilmiyor, execute sırasında ayardan okunuyor.

**En küçük bağımsız dilim:** `ModelEndpointProfile {id,name,url,location,authRef?}` ve task/turn'de seçilen profile snapshot'ı; bağlantı etiketi composer'da görünür. Bu, uzak model kullanımı dilimini kapatır; P28 görev aktarımı tamamlandı sayılmaz.

**Gerçek P28 için ilk anlamlı dilim:** iki açıkça yapılandırılmış Akorith host arasında tek disposable read görevi. `RemoteHost`, `RemoteWorkspace`, `ExecutionOwner`, yetkili dar komut RPC'si, kalıcı request ID/cursor ve reconnect; yerel ayrıcaklı preload dışarı sunulmaz. Daha sonra açık kullanıcı aktarımı: task/history/artifact manifest'i, hedef workspace mapping, içerik hash'leri, credential hariç tutma, transfer yarıda kalırsa source/destination tek owner korunması. Canlı agent devrinde iki tarafta birden yazıcı çalıştırmak kabul edilemez.

**Kabul:** iki yetkilendirilmiş host, yanlış auth/revoke, offline/reconnect, duplicate request, mapping/path escape, yarım transfer, secret exclusion ve yazıcı sahipliği. İkinci host/erişim kurulmadan bu test tamamlanamaz. Yerel günlük v1'in dışında koşullu alan olarak açık kalmalı; dekoratif “Remote” sekmesi eklenmemeli.

## Uygulama sırası ve sözleşme borcu

1. B02/B03 güvenilirlik ve gerçek günlük akış kapılarını bitir; bu rapor mevcut paket doğrulamasını bölmek için değildir.
2. P27 ek açma gibi mevcut yüzeydeki gerçek aksaklıkları düzelt; P18/P26 ortak etkili bağlam modelini getir. Kullanıcı “hangi skill/tool gerçekten var?” sorusunun yanıtını uygulamada görebilmeli.
3. Yerel plugin import/version/disable/remove; proje kapsamlı MCP. Sadece mevcut Codex cache'ini listelemek zengin plugin ürünü yerine geçmez.
4. Aynı motor üzerinde P23 yerel automation; P24 kalıcı hedef takibi ve ardından sınırlı iterasyon; P25 bağlı read alt görevleri. Her biri restart/Stop/cleanup kanıtı olmadan otonom yetenek sayılmamalı.
5. Kullanıcı kontrollü memory, belge artifact'i ve gerçek yeteneğe bağlı medya; uzak cihaz P28 koşullu ayrı dilim.

[shared/IPC.md](../../v2/shared/IPC.md) gerçek dispatch'ten geride: örneğin `files:media`, `task:submissionStatus`, checkpoint, list/reorder/relocate/resume eklerinin tamamını anlatmıyor. Yeni yüzeyleri yalnız string komut adlarına dayanarak eklemek yerine güncel giriş/yanıt/error sözleşmesi ve kapsam testleri beraber yazılmalı. `contracts.ts` de çoğu komut için tipli request/response haritası taşımıyor; generic `invoke<T>` çağrısı gerçek şema doğrulaması sayılmaz.

Önceki P27 envanterindeki `v2/renderer/src/components/panels/FilesPanel.tsx` yolu güncel değil; gerçek yol `v2/renderer/src/panels/FilesPanel.tsx`. Bu raporda kaynak dosyaları bu normal yoldan okundu. Envanterdeki test sayıları, performans denemeleri, B01 Quit veya aday process-owner iddiaları yeniden yazılmadı; burada hiçbir kaynak incelemesi paket testi yerine geçirilmedi.

## Denetim sonrası ayrı düzeltme kaydı

Root'un ayrıca yetkilendirdiği dar P27 ek açma düzeltmesi bu denetimden sonra renderer'a uygulandı: [ArtifactPreview.tsx](../../v2/renderer/src/components/ArtifactPreview.tsx), [artifactPreviewState.ts](../../v2/renderer/src/components/artifactPreviewState.ts), App/Composer/Transcript/Markdown ve ilgili stil. Gönderilmiş ve taslak ekler task-scoped `files:media` ile salt okunur dialog açıyor; workspace editörüne veya yetkisiz Reveal işlemine geçmiyor. PDF/ses için önizlemenin desteklenmediği açık. Native browser için ayrı overlay bayrağı, task değişiminde kapanış ve geç yanıtı yok sayma var.

Bu dilimde renderer'ın 23 davranış/SSR testi geçti; ardından son küçük decode-error/erişilebilirlik değişikliği için yeni 6 test tekrar geçti ve TypeScript kontrolü başarılı. [Yeni testler](../../v2/renderer/tests/artifactPreview.test.tsx) task/path kapsamını, yalnız media komutu kullanılmasını, hata sonrası yetki genişletilmemesini, desteklenmeyen dosyayı ve salt okunur sunumu sınar. Gerçek tıklama/native overlay kabulü B03 paketi için root'a devredildi; burada yapılmış sayılmaz. P27'nin belge/üretim/ses eksikleri ve diğer ürün kapsamı bulguları açık kalır.
