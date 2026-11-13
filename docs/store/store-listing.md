# Store listing — ready-to-paste text

Source of truth for the Chrome Web Store and Edge Add-ons listings. Update this file when
the listing changes, so the dashboard copy can always be rebuilt from the repo.

## Name

`NexusMods Bypass` — comes from `_locales/<lang>/messages.json` → `appName`.

## Short description

Comes from the manifest (`__MSG_appDesc__`), so the store shows it **already translated**
for every locale in `_locales/`. Current English text (116 / 132 chars):

> Auto-start Nexus Mods downloads, queue whole collections to Vortex or your browser, and skip
> files you already have.

Edit it in `_locales/en/messages.json` (and the other locales), not in the dashboard.

## Detailed description

The dashboard's detailed description is **not** covered by `_locales` — it has to be pasted
per language in the store UI. Paste each block into the "Description" field of its language.

Feature names follow each locale's `messages.json` (the deck, popup and dialog labels), so the
listing reads the same as the extension. The project is source-available, not open source
(see `LICENSE`), so the listing says the source is public and never "open source".

### English (en) — default

```
NexusMods Bypass streamlines downloading on Nexus Mods. It skips the download wait on supported file pages, starts downloads automatically, and sends them to Vortex or your browser.

SINGLE FILES
• Start downloads automatically, without the wait
• Skip requirement screens
• Hide ads and premium panels

COLLECTIONS
• Download all mods, only the mandatory or optional ones, or pick exactly the files you want, with search and Mandatory/Optional tags
• Send to Vortex or Browser Download, with a live progress bar, adaptive pacing, pause and stop
• Import downloaded mods: files you already have are recognised and skipped
• Update collection: compare two revisions (Updated, Added, Removed) and download only what changed
• Download history and a run summary, so a re-run only fetches what is missing
• Import a Wabbajack modlist (beta): queues the Nexus files a .wabbajack modlist needs

Available in 13 languages: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Free to use, and the source code is public so anyone can check what it does. It runs only on nexusmods.com and keeps everything in your browser. You must be signed in to your own Nexus Mods account; it does not unlock Premium content and is not affiliated with Nexus Mods.
```

### Deutsch (de)

```
NexusMods Bypass vereinfacht das Herunterladen auf Nexus Mods. Die Erweiterung überspringt die Wartezeit auf unterstützten Dateiseiten, startet Downloads automatisch und sendet sie an Vortex oder an Ihren Browser.

EINZELNE DATEIEN
• Downloads automatisch starten, ohne Wartezeit
• Anforderungsseiten überspringen
• Werbung und Premium-Banner ausblenden

COLLECTIONS
• Alle Mods herunterladen, nur Pflicht- oder optionale Mods, oder genau die gewünschten Dateien auswählen – mit Suche und Markierungen „Pflicht“/„Optional“
• An Vortex senden oder Browser-Download, mit Live-Fortschrittsbalken, adaptivem Tempo, Pause und Stopp
• Heruntergeladene Mods importieren: Dateien, die Sie bereits haben, werden erkannt und übersprungen
• Collection aktualisieren: zwei Revisionen vergleichen (Aktualisiert, Hinzugefügt, Entfernt) und nur die Änderungen herunterladen
• Download-Verlauf und Zusammenfassung jedes Durchlaufs, damit ein erneuter Durchlauf nur Fehlendes lädt
• Wabbajack-Modliste importieren (Beta): stellt die Nexus-Dateien einer .wabbajack-Modliste in die Warteschlange

In 13 Sprachen verfügbar: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Kostenlos nutzbar, und der Quellcode ist öffentlich, sodass jeder prüfen kann, was die Erweiterung tut. Sie läuft nur auf nexusmods.com und speichert alles in Ihrem Browser. Sie müssen mit Ihrem eigenen Nexus-Mods-Konto angemeldet sein; die Erweiterung schaltet keine Premium-Inhalte frei und steht in keiner Verbindung zu Nexus Mods.
```

### Ελληνικά (el)

```
Το NexusMods Bypass κάνει πιο εύκολες τις λήψεις στο Nexus Mods. Παρακάμπτει την αναμονή λήψης στις υποστηριζόμενες σελίδες αρχείων, ξεκινά αυτόματα τις λήψεις και τις στέλνει στο Vortex ή στον περιηγητή σας.

ΜΕΜΟΝΩΜΕΝΑ ΑΡΧΕΙΑ
• Αυτόματη έναρξη λήψεων, χωρίς αναμονή
• Παράλειψη οθονών requirements
• Απόκρυψη διαφημίσεων και premium banner

COLLECTIONS
• Λήψη όλων των mods, μόνο των υποχρεωτικών ή των προαιρετικών, ή επιλογή ακριβώς των αρχείων που θέλετε, με αναζήτηση και ετικέτες Υποχρεωτικό/Προαιρετικό
• Αποστολή στο Vortex ή λήψη μέσω περιηγητή, με ζωντανή μπάρα προόδου, προσαρμοστικό ρυθμό, παύση και διακοπή
• Εισαγωγή ληφθέντων mods: όσα αρχεία έχετε ήδη αναγνωρίζονται και παραλείπονται
• Ενημέρωση collection: σύγκριση δύο revisions (Ενημερωμένα, Προστέθηκαν, Αφαιρέθηκαν) και λήψη μόνο όσων άλλαξαν
• Ιστορικό λήψεων και σύνοψη κάθε εκτέλεσης, ώστε μια νέα εκτέλεση να κατεβάζει μόνο όσα λείπουν
• Εισαγωγή λίστας Wabbajack (beta): βάζει σε ουρά τα αρχεία του Nexus που χρειάζεται μια λίστα .wabbajack

Διαθέσιμο σε 13 γλώσσες: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Δωρεάν, και ο πηγαίος κώδικας είναι δημόσιος, ώστε ο καθένας να μπορεί να ελέγξει τι κάνει. Λειτουργεί μόνο στο nexusmods.com και κρατά τα πάντα στον περιηγητή σας. Πρέπει να είστε συνδεδεμένοι στον δικό σας λογαριασμό Nexus Mods· δεν ξεκλειδώνει περιεχόμενο Premium και δεν συνδέεται με τη Nexus Mods.
```

### Español (es)

```
NexusMods Bypass agiliza las descargas en Nexus Mods. Se salta la espera de descarga en las páginas de archivos compatibles, inicia las descargas automáticamente y las envía a Vortex o a tu navegador.

ARCHIVOS SUELTOS
• Iniciar descargas automáticamente, sin esperas
• Omitir pantallas de requisitos
• Ocultar anuncios y paneles premium

COLECCIONES
• Descarga todos los mods, solo los obligatorios u opcionales, o elige exactamente los archivos que quieras, con búsqueda y etiquetas Obligatorio/Opcional
• Enviar a Vortex o Descarga por navegador, con barra de progreso en directo, ritmo adaptativo, pausa y detención
• Importar mods descargados: los archivos que ya tienes se reconocen y se omiten
• Actualizar colección: compara dos revisiones (Actualizados, Añadidos, Eliminados) y descarga solo lo que cambió
• Historial de descargas y resumen de cada ejecución, para que al repetir solo se descargue lo que falta
• Importar lista de Wabbajack (beta): pone en cola los archivos de Nexus que necesita una lista .wabbajack

Disponible en 13 idiomas: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Gratis, y el código fuente es público para que cualquiera pueda comprobar lo que hace. Solo funciona en nexusmods.com y guarda todo en tu navegador. Debes haber iniciado sesión con tu propia cuenta de Nexus Mods; no desbloquea contenido Premium y no está afiliada a Nexus Mods.
```

### Français (fr)

```
NexusMods Bypass simplifie les téléchargements sur Nexus Mods. L'extension saute l'attente de téléchargement sur les pages de fichiers prises en charge, lance les téléchargements automatiquement et les envoie vers Vortex ou votre navigateur.

FICHIERS INDIVIDUELS
• Démarrer les téléchargements automatiquement, sans attente
• Ignorer les écrans d'exigences
• Masquer les publicités et encarts premium

COLLECTIONS
• Téléchargez tous les mods, seulement les obligatoires ou les optionnels, ou choisissez exactement les fichiers voulus, avec recherche et étiquettes Obligatoire/Optionnel
• Envoyer vers Vortex ou Téléchargement par navigateur, avec barre de progression en direct, rythme adaptatif, pause et arrêt
• Importer les mods téléchargés : les fichiers que vous avez déjà sont reconnus et ignorés
• Mettre à jour la collection : comparez deux révisions (Mis à jour, Ajoutés, Supprimés) et ne téléchargez que ce qui a changé
• Historique de téléchargement et résumé de chaque exécution, pour qu'une nouvelle exécution ne récupère que ce qui manque
• Importer une liste Wabbajack (bêta) : met en file d'attente les fichiers Nexus dont une liste .wabbajack a besoin

Disponible en 13 langues : English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Gratuite, et son code source est public pour que chacun puisse vérifier ce qu'elle fait. Elle fonctionne uniquement sur nexusmods.com et garde tout dans votre navigateur. Vous devez être connecté à votre propre compte Nexus Mods ; elle ne débloque aucun contenu Premium et n'est pas affiliée à Nexus Mods.
```

### Italiano (it)

```
NexusMods Bypass semplifica i download su Nexus Mods. Salta l'attesa di download nelle pagine dei file supportate, avvia i download automaticamente e li invia a Vortex o al tuo browser.

SINGOLI FILE
• Avvia i download automaticamente, senza attesa
• Salta le schermate dei requisiti
• Nascondi pubblicità e pannelli Premium

COLLEZIONI
• Scarica tutte le mod, solo le obbligatorie o le opzionali, oppure scegli esattamente i file che vuoi, con ricerca ed etichette Obbligatoria/Opzionale
• Invia a Vortex o Download dal browser, con barra di avanzamento in tempo reale, ritmo adattivo, pausa e stop
• Importa mod scaricate: i file che hai già vengono riconosciuti e saltati
• Aggiorna collection: confronta due revisioni (Aggiornate, Aggiunte, Rimosse) e scarica solo ciò che è cambiato
• Cronologia download e riepilogo di ogni esecuzione, così una nuova esecuzione scarica solo ciò che manca
• Importa modlist Wabbajack (beta): mette in coda i file Nexus richiesti da una modlist .wabbajack

Disponibile in 13 lingue: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Gratuita, e il codice sorgente è pubblico così chiunque può verificare cosa fa. Funziona solo su nexusmods.com e conserva tutto nel tuo browser. Devi aver effettuato l'accesso con il tuo account Nexus Mods; non sblocca contenuti Premium e non è affiliata a Nexus Mods.
```

### 日本語 (ja)

```
NexusMods Bypass は Nexus Mods でのダウンロードをシンプルにします。対応するファイルページでダウンロードの待ち時間をスキップし、ダウンロードを自動で開始して、Vortex またはブラウザーに送ります。

単体ファイル
• ダウンロードを自動的に開始（待ち時間なし）
• 必須MOD画面をスキップ
• 広告と Premium パネルを非表示

コレクション
• すべての MOD、必須のみ、任意のみをダウンロード。検索と「必須」「任意」タグで、必要なファイルだけを選ぶこともできます
• Vortex に送信、またはブラウザーでダウンロード。リアルタイムの進捗バー、自動ペース調整、一時停止と停止に対応
• ダウンロード済み MOD を取り込む：手元にあるファイルを認識してスキップします
• コレクションを更新：2 つのリビジョンを比較（更新・追加・削除）し、変更分だけをダウンロード
• ダウンロード履歴と実行結果の表示で、再実行時は足りないファイルだけを取得
• Wabbajack モッドリストを読み込む（ベータ）：.wabbajack モッドリストに必要な Nexus のファイルをキューに追加

13 言語に対応：English、Deutsch、Ελληνικά、Español、Français、Italiano、日本語、한국어、Polski、Português (Brasil)、Русский、Türkçe、简体中文

無料で使えて、ソースコードは公開されているため誰でも動作を確認できます。動作するのは nexusmods.com のみで、データはすべてブラウザー内に保存されます。ご自身の Nexus Mods アカウントへのサインインが必要です。Premium コンテンツのロックは解除されず、Nexus Mods とは無関係です。
```

### 한국어 (ko)

```
NexusMods Bypass는 Nexus Mods 다운로드를 간편하게 만들어 줍니다. 지원되는 파일 페이지에서 다운로드 대기 시간을 건너뛰고, 다운로드를 자동으로 시작해 Vortex나 브라우저로 보냅니다.

단일 파일
• 다운로드 자동 시작, 대기 없이
• 필수 항목 화면 건너뛰기
• 광고 및 Premium 패널 숨기기

컬렉션
• 모든 모드, 필수 항목만 또는 선택 항목만 다운로드하거나, 검색과 필수/선택 태그로 원하는 파일만 골라 받을 수 있습니다
• Vortex로 보내기 또는 브라우저 다운로드, 실시간 진행률 표시줄, 적응형 속도 조절, 일시 정지와 중지 지원
• 다운로드한 모드 가져오기: 이미 가진 파일은 인식해서 건너뜁니다
• 컬렉션 업데이트: 두 리비전을 비교(업데이트됨, 추가됨, 제거됨)해 바뀐 것만 다운로드
• 다운로드 기록과 실행 요약으로, 다시 실행하면 빠진 파일만 받습니다
• Wabbajack 모드리스트 가져오기(베타): .wabbajack 모드리스트에 필요한 Nexus 파일을 대기열에 추가

13개 언어 지원: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文

무료로 사용할 수 있으며, 소스 코드가 공개되어 있어 누구나 동작을 확인할 수 있습니다. nexusmods.com에서만 작동하고 모든 데이터는 브라우저 안에 보관됩니다. 본인의 Nexus Mods 계정으로 로그인해야 하며, Premium 콘텐츠를 잠금 해제하지 않고 Nexus Mods와 제휴 관계가 없습니다.
```

### Polski (pl)

```
NexusMods Bypass upraszcza pobieranie z Nexus Mods. Pomija czas oczekiwania na obsługiwanych stronach plików, automatycznie rozpoczyna pobieranie i wysyła pliki do Vortex lub do twojej przeglądarki.

POJEDYNCZE PLIKI
• Automatycznie rozpoczynaj pobieranie, bez czekania
• Pomijaj ekrany wymagań
• Ukryj reklamy i panele Premium

KOLEKCJE
• Pobierz wszystkie mody, tylko wymagane lub opcjonalne albo wybierz dokładnie te pliki, które chcesz, z wyszukiwaniem i oznaczeniami Wymagany/Opcjonalny
• Wyślij do Vortex lub pobieranie przeglądarką, z paskiem postępu na żywo, adaptacyjnym tempem, pauzą i zatrzymaniem
• Importuj pobrane mody: pliki, które już masz, są rozpoznawane i pomijane
• Aktualizuj kolekcję: porównaj dwie rewizje (Zaktualizowane, Dodane, Usunięte) i pobierz tylko zmiany
• Historia pobierania i podsumowanie każdego przebiegu, więc ponowne uruchomienie pobiera tylko brakujące pliki
• Importuj listę Wabbajack (beta): kolejkuje pliki z Nexus potrzebne liście .wabbajack

Dostępne w 13 językach: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Darmowe, a kod źródłowy jest publiczny, więc każdy może sprawdzić, co robi. Działa tylko na nexusmods.com i przechowuje wszystko w twojej przeglądarce. Musisz być zalogowany na własne konto Nexus Mods; rozszerzenie nie odblokowuje treści Premium i nie jest powiązane z Nexus Mods.
```

### Português (pt_BR)

```
O NexusMods Bypass facilita os downloads no Nexus Mods. Ele pula a espera de download nas páginas de arquivos compatíveis, inicia os downloads automaticamente e os envia para o Vortex ou para o seu navegador.

ARQUIVOS AVULSOS
• Iniciar downloads automaticamente, sem espera
• Pular telas de requisitos
• Ocultar anúncios e painéis premium

COLEÇÕES
• Baixe todos os mods, só os obrigatórios ou os opcionais, ou escolha exatamente os arquivos que você quer, com busca e etiquetas Obrigatório/Opcional
• Enviar para o Vortex ou download pelo navegador, com barra de progresso ao vivo, ritmo adaptativo, pausa e parada
• Importar mods baixados: arquivos que você já tem são reconhecidos e pulados
• Atualizar coleção: compare duas revisões (Atualizados, Adicionados, Removidos) e baixe só o que mudou
• Histórico de downloads e resumo de cada execução, para que uma nova execução busque só o que falta
• Importar modlist do Wabbajack (beta): coloca na fila os arquivos do Nexus de que uma modlist .wabbajack precisa

Disponível em 13 idiomas: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Gratuito, e o código-fonte é público para que qualquer pessoa possa conferir o que ele faz. Funciona apenas no nexusmods.com e mantém tudo no seu navegador. Você precisa estar conectado à sua própria conta do Nexus Mods; ele não libera conteúdo Premium e não é afiliado ao Nexus Mods.
```

### Русский (ru)

```
NexusMods Bypass упрощает загрузку с Nexus Mods. Расширение пропускает ожидание загрузки на поддерживаемых страницах файлов, автоматически начинает загрузки и отправляет их в Vortex или в ваш браузер.

ОТДЕЛЬНЫЕ ФАЙЛЫ
• Автоматически начинать загрузки, без ожидания
• Пропускать экраны требований
• Скрывать рекламу и премиум-баннеры

КОЛЛЕКЦИИ
• Скачивайте все моды, только обязательные или необязательные либо выбирайте именно нужные файлы — с поиском и метками «Обязательный»/«Необязательный»
• Отправка в Vortex или загрузка через браузер, с индикатором прогресса в реальном времени, адаптивным темпом, паузой и остановкой
• Импорт скачанных модов: файлы, которые у вас уже есть, распознаются и пропускаются
• Обновление коллекции: сравните две ревизии (Обновлённые, Добавленные, Удалённые) и скачайте только изменения
• История загрузок и итоги каждого запуска, чтобы повторный запуск скачивал только недостающее
• Импорт списка Wabbajack (бета): ставит в очередь файлы Nexus, нужные списку .wabbajack

Доступно на 13 языках: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Бесплатно, а исходный код открыт для просмотра, чтобы любой мог проверить, что делает расширение. Оно работает только на nexusmods.com и хранит всё в вашем браузере. Нужно войти в свой собственный аккаунт Nexus Mods; расширение не открывает доступ к Premium-контенту и не связано с Nexus Mods.
```

### Türkçe (tr)

```
NexusMods Bypass, Nexus Mods'ta indirmeyi kolaylaştırır. Desteklenen dosya sayfalarında indirme beklemesini atlar, indirmeleri otomatik başlatır ve Vortex'e ya da tarayıcınıza gönderir.

TEK DOSYALAR
• İndirmeleri otomatik başlat, beklemeden
• Gereksinim ekranlarını atla
• Reklamları ve Premium panellerini gizle

KOLEKSİYONLAR
• Tüm modları, yalnızca zorunlu ya da isteğe bağlı olanları indirin veya arama ve Zorunlu/İsteğe bağlı etiketleriyle tam istediğiniz dosyaları seçin
• Vortex'e gönder veya tarayıcıyla indir; canlı ilerleme çubuğu, uyarlanabilir hız, duraklatma ve durdurma ile
• İndirilmiş modları içe aktar: zaten sahip olduğunuz dosyalar tanınır ve atlanır
• Koleksiyonu güncelle: iki revizyonu karşılaştırın (Güncellenenler, Eklenenler, Kaldırılanlar) ve yalnızca değişenleri indirin
• İndirme geçmişi ve her çalışmanın özeti sayesinde yeniden çalıştırma yalnızca eksikleri indirir
• Wabbajack mod listesi içe aktar (beta): bir .wabbajack mod listesinin ihtiyaç duyduğu Nexus dosyalarını sıraya ekler

13 dilde kullanılabilir: English, Deutsch, Ελληνικά, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文.

Ücretsizdir ve kaynak kodu herkese açıktır; böylece herkes ne yaptığını kontrol edebilir. Yalnızca nexusmods.com üzerinde çalışır ve her şeyi tarayıcınızda tutar. Kendi Nexus Mods hesabınızla oturum açmış olmanız gerekir; Premium içeriğin kilidini açmaz ve Nexus Mods ile bağlantılı değildir.
```

### 简体中文 (zh_CN)

```
NexusMods Bypass 让 Nexus Mods 的下载更轻松。它会在受支持的文件页面跳过下载等待，自动开始下载，并发送到 Vortex 或你的浏览器。

单个文件
• 自动开始下载，无需等待
• 跳过前置要求页面
• 隐藏广告和高级版推广

合集
• 下载全部模组、仅必需项或仅可选项，或借助搜索和“必需/可选”标签精确挑选需要的文件
• 发送到 Vortex 或浏览器下载，提供实时进度条、自适应节奏、暂停和停止
• 导入已下载的模组：识别并跳过你已有的文件
• 更新合集：比较两个修订版本（已更新、新增、已移除），只下载有变化的部分
• 下载历史和每次运行的摘要，再次运行时只获取缺少的文件
• 导入 Wabbajack 模组列表（测试版）：将 .wabbajack 模组列表所需的 Nexus 文件加入队列

支持 13 种语言：English、Deutsch、Ελληνικά、Español、Français、Italiano、日本語、한국어、Polski、Português (Brasil)、Русский、Türkçe、简体中文

免费使用，源代码公开，任何人都可以查看它的具体行为。它只在 nexusmods.com 上运行，所有数据都保存在你的浏览器中。你需要登录自己的 Nexus Mods 账户；它不会解锁高级版内容，也与 Nexus Mods 无关。
```

## What's new — 3.0.0

Dashboard-only field, not covered by `_locales`. Paste as-is:

```
Major update: more reliable downloads, official Nexus API integration, responsive panels and redesigned diagnostics.

Collection queues download the smallest files first, avoid duplicate starts, retry recoverable interruptions and keep downloads tied to the selected file. Removed mods are skipped with a clear reason. Large runs ask for confirmation.

The official Nexus API supplies collection and file details, with revision/update badges, optional curator update policies and click-only Endorse/Track controls. Wabbajack imports can identify local archives by MD5.

Panels fit smaller screens through 4K, with keyboard-friendly controls and themed scrollbars. The redesigned report page includes reproduction steps and an exact redacted diagnostic preview, plus copy/save and GitHub fallbacks. An opt-in live debug-log page adds search, filters and export. All 13 interface languages are supported.
```

Keep this honest and specific. The setting caused support confusion precisely because the
symptom was untraceable; a vague "bug fixes and improvements" line would repeat that.

## Category

Productivity → Workflow & Planning

## Search keywords woven into the copy

Nexus Mods, Vortex, mod manager, collection downloader, auto download, skip wait, download
helper, Skyrim, Fallout, modding

## Assets — all present beside this file in `docs/store/`

| Asset | Size | File |
|---|---|---|
| Screenshots | 1280×800 | `1280.png`, `1280_1.png` … `1280_4.png` |
| Small promo tile | 440×280 | `canvas-440x280.png` |
| Marquee | 1400×560 | `marquee-1400x560.png` |

## Privacy tab answers

- **Single purpose:** This extension improves the Nexus Mods download workflow: it automates the supported download steps, starts downloads on supported file pages, and downloads full collections (or Wabbajack modlists' Nexus files) as a paced queue. It runs only on nexusmods.com.
- **Data collected:** none — all storage is local. Link
  <a href="https://github.com/thomasthanos/nexusmods-bypass/blob/main/PRIVACY.md"><kbd>PRIVACY.md</kbd></a>
  as the privacy policy URL. It lives at the repo root, not under `nexus.mods.bypass/` —
  the old path 404s, and the store will not approve a dead privacy policy link.
- **Permissions justification:**

| Permission | Justification |
|---|---|
| `storage` | Storage keeps the user's data locally in the browser: settings (auto-download behaviour, queue pacing, download method, download folder, language), the collection download history so re-runs skip files already downloaded, the state of a running download queue so it survives the service worker being suspended, a download counter, and a small local error log the user can attach to a bug report. Nothing is sent off the device. |
| `downloads` | The downloads permission is essential to the extension's single purpose. After the user starts a Nexus Mods file, collection or modlist download, the extension starts the browser download, gives it a safe filename inside the configured Downloads subfolder, and follows it until it completes or is interrupted, checking the finished size, so a collection queue can continue or resume. It cancels only the queue downloads it started, when the user selects Stop. Downloads stay in the browser's download history. |
| `scripting` | The scripting permission injects the extension's own packaged scripts into a nexusmods.com tab only when that page needs them: the collection downloader on a collection page, the settings dialog when the user opens it, the bug-report builder when an error dialog is shown, and the Wabbajack importer when the user uses it. This keeps the script loaded on every Nexus Mods page small. Only files inside the extension package are injected, only into the frame that asked, and only on the host the extension already has access to. No remote code is used. |
| `alarms` | The alarms permission schedules one-time wake-ups for an active browser-mode download queue only: to start the next file after the pause between downloads and to resume after a Nexus Mods rate-limit cooldown. A Manifest V3 service worker cannot keep a timer while suspended, so this lets the queue continue after browser suspension or device sleep. It is not used for notifications, analytics, advertising or unrelated periodic work. |
| `https://www.nexusmods.com/*` | Access to https://www.nexusmods.com/* is required because the extension works only on Nexus Mods. It needs this host to add its interface to Nexus Mods pages, recognise supported download pages, request the download links for the files the user asks for, and run collection downloads. The extension does not run on or read any other website. |

## Before each submission

- [ ] Version bumped in `manifest.json` — it is the only place the version lives
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] `node tools/build-zip.mjs` passes and writes `dist/nexus.mods.bypass-<version>.zip`
- [ ] That zip is the one uploaded — never a hand-made archive

The build script gates on `check-locales.mjs` and every regression suite in `tools/`, packages from an explicit allowlist, and
fails if the manifest references a file the package does not carry. It replaces the manual
"zip everything except…" step, which is how `docs/`, `README.md` and `PRIVACY.md` ended up
published inside the 2.4.2 package.

## Release history worth remembering

The 2.4.2 upload shipped this very file inside the extension. Anyone who unpacked the CRX
could read the listing notes. Fixed in 2.4.3 by the allowlist in `tools/build-zip.mjs` —
do not go back to packaging by hand.
