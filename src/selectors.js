// @ts-check
// One place for every Nexus Mods page hook the content scripts find their way by. Each entry is an
// ordered list of fallbacks, newest Nexus markup first, so a site update usually costs one line here
// instead of a hunt through several files. Text matchers are lists of lowercase phrases in the
// languages Nexus serves, so a check never depends on the page being in English.
(function () {
  'use strict';

  /** @type {Readonly<Record<string, readonly string[]>>} */
  const SELECTORS = Object.freeze({
    // Strong markers prove a signed-in session even when they sit in a closed dropdown.
    signedInStrong: Object.freeze([
      'a[href*="/auth/sign_out"]',
      'a[href*="sign_out"]',
      'form[action*="sign_out"]',
      '#profile-menu',
      '[data-testid="profile-image"]',
      '[data-e2e-id="user-avatar"]'
    ]),
    // Weak markers count only when they are visible on screen.
    signedInWeak: Object.freeze([
      'a[href*="users.nexusmods.com/account"]',
      'a[href*="/users/myaccount"]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
      '[class*="user-menu"]',
      '[class*="profile-menu"]',
      'img[alt*="avatar" i]'
    ]),
    loginForm: Object.freeze(['form[action*="/auth/sign_in"]', 'form#new_user']),
    loginLink: Object.freeze(['a[href*="users.nexusmods.com/auth/sign_in"]', 'a[href*="/auth/sign_in"]']),
    downloadControl: Object.freeze(['#slowDownloadButton', '[data-download-url]', 'mod-file-download']),
    slowDownloadButton: Object.freeze(['#slowDownloadButton', 'button[data-nxtk-slow-bound]']),
    premiumBanner: Object.freeze(['.bg-nexus-premium-gradient', '[class*="premium-gradient"]']),
    collectionColumn: Object.freeze(['#mainContent .next-container', '#mainContent [class*="container"]', 'main']),
    collectionFeatured: Object.freeze(['#section .wrap > #featured', '#featured']),
    // The Vortex / mod-manager control on a file card, by id, before any text check.
    modManagerControl: Object.freeze(['#action-nmm', '#action-vortex', '[data-e2e-id*="mod-manager" i]', '[data-e2e-id*="vortex" i]']),
    // The custom elements that wrap a file's download controls (and their requirements modal).
    fileDownloadHost: Object.freeze(['mod-file-download', 'mod-download-buttons', 'mod-download-modal', 'download-modal'])
  });

  /** @type {Readonly<Record<string, readonly string[]>>} */
  const TEXT = Object.freeze({
    slowDownload: Object.freeze([
      'slow download', 'langsamer download', 'langsamer herunterladen', 'téléchargement lent',
      'descarga lenta', 'download lento', 'pobieranie wolne', 'wolne pobieranie', 'медленная загрузка',
      'yavaş indirme', 'αργή λήψη', '低速ダウンロード', '저속 다운로드', '慢速下载'
    ]),
    // A mod-manager (Vortex) download control.
    modManagerDownload: Object.freeze([
      'mod manager', 'vortex', 'mod-manager', 'modmanager', 'gestionnaire de mods', 'gestor de mods',
      'gerenciador de mods', 'menedżer modów', 'менеджер модов', 'mod yöneticisi', 'διαχειριστή mod',
      'διαχειριστής mod', 'mod マネージャー', 'モッドマネージャー', '모드 관리자', '模组管理器'
    ]),
    // A manual (browser) download control.
    manualDownload: Object.freeze([
      'manual download', 'manueller download', 'manuell herunterladen', 'téléchargement manuel',
      'descarga manual', 'download manuale', 'download manual', 'pobieranie ręczne', 'ręczne pobieranie',
      'ручная загрузка', 'ручное скачивание', 'manuel indirme', 'χειροκίνητη λήψη', '手動ダウンロード',
      '수동 다운로드', '手动下载'
    ]),
    // Any download wording, for a requirements-modal button that is neither of the two above.
    downloadWord: Object.freeze([
      'download', 'herunterladen', 'télécharger', 'descargar', 'baixar', 'scarica', 'pobierz', 'скачать',
      'загрузить', 'indir', 'λήψη', 'ダウンロード', '다운로드', '下载'
    ]),
    // Controls that dismiss a dialog. These must always reach the page untouched.
    dismissAction: Object.freeze([
      'close', 'cancel', 'dismiss', 'schließen', 'abbrechen', 'fermer', 'annuler', 'cerrar', 'cancelar',
      'fechar', 'chiudi', 'annulla', 'zamknij', 'anuluj', 'закрыть', 'отмена', 'kapat', 'iptal',
      'κλείσιμο', 'ακύρωση', '閉じる', 'キャンセル', '닫기', '취소', '关闭', '取消'
    ]),
    slowCardHint: Object.freeze([
      'wait more', 'delay before each download', 'throttled downloads'
    ])
  });

  /** @param {unknown} value */
  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * First element matching any selector in the named list, or null. Invalid selectors are skipped so a
   * browser that lacks a selector feature degrades to the next fallback instead of throwing.
   * @param {ParentNode | null | undefined} root
   * @param {string} key
   * @param {(el: Element) => boolean} [accept]
   * @returns {{ element: Element, selector: string } | null}
   */
  function find(root, key, accept) {
    const list = SELECTORS[key] || [];
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    for (const selector of list) {
      let nodes;
      try {
        nodes = root.querySelectorAll(selector);
      } catch (_) {
        continue;
      }
      for (const element of Array.from(nodes)) {
        if (!accept || accept(element)) return { element, selector };
      }
    }
    return null;
  }

  /**
   * @param {unknown} value
   * @param {string} key
   */
  function textMatches(value, key) {
    const text = normalize(value);
    return !!text && (TEXT[key] || []).some((phrase) => text.includes(phrase));
  }

  const api = Object.freeze({ SELECTORS, TEXT, find, textMatches, normalize });
  const g = /** @type {any} */ (globalThis);
  g.NexusSelectors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
