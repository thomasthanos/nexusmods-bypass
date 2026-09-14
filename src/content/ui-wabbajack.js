// Importing a Wabbajack modlist into a download deck. Loaded with zip-reader.js and wabbajack-importer.js,
// after the collection bundle it builds on, the first time the import is used.
(function () {
  'use strict';

  const kit = window.NexusExt?.UIKit;
  if (!kit?.collection || kit.wabbajack) return;

  const { svgIcon, L, openModal, nxtkAlert } = kit;
  const { createControlDeck, disposeControlDeck, deckRunIsActive } = kit.collection;

  const WABBAJACK_UNSAFE_ID = /[^A-Za-z0-9._-]+/g;

  function wabbajackCollectionId(list) {
    const base = String(list?.name || '').replace(WABBAJACK_UNSAFE_ID, '-').replace(/^-+|-+$/g, '');
    return `wj-${base || 'modlist'}`.slice(0, 128);
  }

  const SKIPPED_NAMES_SHOWN = 6;

  function skippedBucket(reason) {
    if (/^not-on-nexus:GameFileSource$/i.test(reason)) return 'game';
    if (/^not-on-nexus:Manual$/i.test(reason)) return 'manual';
    if (/^not-on-nexus/i.test(reason)) return 'other';
    return 'unreadable';
  }

  function logSkippedArchives(ndc, skipped) {
    if (!skipped?.length) return;

    const buckets = new Map();
    for (const entry of skipped) {
      const reason = String(entry?.reason || 'unknown');
      const bucket = skippedBucket(reason);
      if (!buckets.has(bucket)) buckets.set(bucket, { count: 0, names: [], reasons: new Set() });
      const group = buckets.get(bucket);
      group.count += 1;
      const name = String(entry?.name || '').trim();
      if (name) group.names.push(name);
      group.reasons.add(reason);
    }

    const detail = (group, extra = []) => {
      const shown = [...extra, ...group.names].slice(0, SKIPPED_NAMES_SHOWN);
      const rest = group.count - group.names.slice(0, SKIPPED_NAMES_SHOWN).length;
      return `${shown.join(', ')}${rest > 0 ? ` … +${rest}` : ''}`;
    };

    const say = (bucket, type, render) => {
      const group = buckets.get(bucket);
      if (group) ndc.ui?.logText?.(`· ${render(group)}`, type);
    };

    ndc.ui?.logText?.(NXTK.t('wjSkippedHeading', null,
      'Not queued here — Wabbajack gets these on its own:'), 'info');

    say('game', 'info', (group) => NXTK.t('wjSkipGameFiles', [String(group.count)],
      `${group.count} come from your game install — Wabbajack copies these itself.`));
    say('other', 'info', (group) => NXTK.t('wjSkipOtherSites', [String(group.count)],
      `${group.count} are hosted on other sites — Wabbajack downloads these itself.`));
    say('manual', 'info', (group) => NXTK.t('wjSkipManual', [String(group.count), detail(group)],
      `${group.count} will have to be downloaded by hand when Wabbajack asks: ${detail(group)}`));
    say('unreadable', 'error', (group) => {
      const reasons = [...group.reasons].slice(0, 3);
      return NXTK.t('wjSkipUnreadable', [String(group.count), detail(group, reasons)],
        `${group.count} could not be read by this version: ${detail(group, reasons)}`);
    });
  }

  function dominantGameDomain(mods) {
    const counts = new Map();
    for (const mod of mods) {
      const domain = String(mod?.file?.mod?.game?.domainName || '').trim();
      if (!domain) continue;
      counts.set(domain, (counts.get(domain) || 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [domain, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (count <= bestCount) continue;
      best = domain;
      bestCount = count;
    }
    return best;
  }

  // Where a modlist deck goes on a page with no deck for it to replace: inside the page's own content column,
  // on the page's background. The top of #mainContent is a bare strip above that column, which left the deck
  // on black on either side.
  function findDeckHost() {
    const column = document.querySelector('#mainContent .next-container');
    if (column) return { parent: column, before: null };
    const featured = document.querySelector('#section .wrap > #featured');
    if (featured) return { parent: featured.parentElement, before: featured.nextSibling };
    const wrap = document.querySelector('#section .wrap');
    if (wrap) return { parent: wrap, before: wrap.firstChild };
    const main = document.getElementById('mainContent') || document.body;
    return { parent: main, before: main.firstChild };
  }

  // A modlist is not part of the page it was imported on, so its deck can be closed again. On a collection
  // page, content/main.js then puts the collection's own deck back.
  function addCloseButton(deck) {
    const badge = deck.querySelector('.nxtk-deck-title > .nxtk-badge');
    if (!badge) return;
    const label = NXTK.t('ariaClose', null, 'Close');
    const close = document.createElement('button');
    close.type = 'button';
    close.draggable = false;
    close.className = 'nxtk-modal-close nxtk-deck-close';
    close.textContent = '×';
    close.title = label;
    close.setAttribute('aria-label', label);
    close.addEventListener('click', async () => {
      if (deckRunIsActive(deck)) {
        await nxtkAlert(NXTK.t('logAlreadyRunning', null, 'A download is already running. Please wait or stop it first.'));
        return;
      }
      disposeControlDeck(deck);
      deck.remove();
    });
    const side = document.createElement('span');
    side.className = 'nxtk-deck-title-side';
    badge.replaceWith(side);
    side.append(badge, close);
  }

  async function mountWabbajackDeck(list, mods, { title = '' } = {}) {
    const gameDomain = dominantGameDomain(mods) || mods[0].file.mod.game.domainName;
    const ndc = new NexusExt.NDC(gameDomain, wabbajackCollectionId(list));
    await ndc.initFromMods(mods);
    ndc.displayName = title || list.name || '';

    const deck = createControlDeck(ndc);
    for (const id of ['#nxtk-update-collection', '#nxtk-dl-mandatory', '#nxtk-dl-optional']) {
      deck.querySelector(id)?.remove();
    }
    addCloseButton(deck);

    // The deck is built before anything on the page changes, then swapped in at once. Removing the old deck
    // first left the page without one while the modlist loaded, and content/main.js put the collection's deck
    // back in that gap, so a collection page ended up with two.
    const [current, ...extra] = document.querySelectorAll('.nxtk-deck');
    for (const stale of extra) {
      disposeControlDeck(stale);
      stale.remove();
    }
    if (current) {
      disposeControlDeck(current);
      current.replaceWith(deck);
    } else {
      const { parent, before } = findDeckHost();
      parent.insertBefore(deck, before);
    }
    deck.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    ndc.ui?.openLogs?.();
    logSkippedArchives(ndc, list.skipped);
    ndc.ui?.logText?.(NXTK.t('wjQueueReady', null,
      'The modlist is queued. Press the download button to start.'), 'info');
    return ndc;
  }

  async function importWabbajackModlist(closeDialog) {
    const importer = NexusExt.WabbajackImporter;
    if (!importer) return;

    const refuseWhileRunning = async () => {
      if (![...document.querySelectorAll('.nxtk-deck')].some(deckRunIsActive)) return false;
      await nxtkAlert(NXTK.t('logAlreadyRunning', null, 'A download is already running. Please wait or stop it first.'));
      return true;
    };
    if (await refuseWhileRunning()) return;

    const triggers = Array.from(document.querySelectorAll('#nxtk-wj-import, #nxtk-wj-deck-import'));
    const setBusy = (busy) => triggers.forEach((button) => { button.disabled = busy; });

    const input = document.createElement('input');
    input.type = 'file';
    // The modlist is often still inside the archive it was downloaded in, and a 7z or rar
    // has to be selectable to be told apart from an archive that can actually be opened.
    input.accept = '.wabbajack,.zip,.7z,.rar';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;

      setBusy(true);
      try {
        const list = await importer.importFile(file);
        const mods = importer.toQueueMods(list);
        const title = list.name || file.name;

        const lines = [
          NXTK.t('wjImportSummary', [String(mods.length), String(list.total), title],
            `${mods.length} of the ${list.total} archives in ${title} come from Nexus and are queued.`)
        ];
        if (list.skipped.length) {
          lines.push(NXTK.t('wjImportSkipped', [String(list.skipped.length)],
            `The other ${list.skipped.length} are not Nexus downloads — Wabbajack gets those itself. The log lists them.`));
        }
        await nxtkAlert(lines.join('\n'));
        if (!mods.length) return;
        // Asked again: a run can have started while the file picker was open.
        if (await refuseWhileRunning()) return;

        closeDialog?.();
        await mountWabbajackDeck(list, mods, { title });
      } catch (cause) {
        // Needing to be extracted is an instruction, not a fault, so it is not dressed up
        // as one — there is nothing here for the user to report or retry.
        if (cause?.code === 'needs-extracting') {
          await nxtkAlert(NXTK.t('wjImportNeedsExtracting', [cause.format || '7z'],
            `A browser cannot open a ${cause.format || '7z'} archive. Extract it, then pick the`
            + ' .wabbajack file from inside it.'));
          return;
        }
        const reason = String(cause?.message || cause);
        await nxtkAlert(NXTK.t('wjImportFailed', [reason], `Could not read this modlist: ${reason}`));
      } finally {
        setBusy(false);
      }
    }, { once: true });
    input.click();
  }

  function showWabbajackInfoModal() {
    const { modal } = openModal({
      id: 'nxtk-wj-info-modal',
      className: 'nxtk-modal nxtk-modal-sm nxtk-import-modal',
      ariaLabel: NXTK.t('dlgWabbajackTitle', null, 'Wabbajack Modlist Import'),
      restoreFocus: true,
      html: `
      <div class="nxtk-modal-header">
        <div class="nxtk-modal-title">${L('dlgWabbajackTitle', 'Wabbajack Modlist Import')}</div>
        <button class="nxtk-modal-close" data-close aria-label="${L('ariaClose', 'Close')}">&times;</button>
      </div>
      <div class="nxtk-import-guide">
        <div class="nxtk-import-hero">
          <span class="nxtk-import-hero-icon">${svgIcon('importIcon')}</span>
          <div class="nxtk-import-hero-copy">
            <div class="nxtk-history-lead">${L('dlgWabbajackLead', 'Queue every Nexus file a modlist needs.')}</div>
            <div class="nxtk-history-text">${L('dlgWabbajackHelp', 'Pick the .wabbajack file you downloaded from Wabbajack. The extension reads the list inside it and queues the Nexus-hosted files, using the same pacing, history and download method a collection uses.')}</div>
          </div>
        </div>
        <div class="nxtk-import-path-card">
          <div class="nxtk-import-path-label">${L('setWabbajackImportLabel', 'Wabbajack modlist import (beta)')}</div>
          <div class="nxtk-history-text">${L('dlgWabbajackNote', 'Files hosted outside Nexus, and games this version does not recognise, cannot be fetched. They are counted and named in the summary so you can get them yourself.')}</div>
        </div>
      </div>
      <div class="nxtk-modal-footer">
        <button type="button" class="nxtk-btn nxtk-btn-primary" data-close>${L('btnGotIt', 'Got it')}</button>
      </div>
    `
    });
    modal.querySelector('[data-close]')?.focus?.({ preventScroll: true });
  }

  kit.wabbajack = { importModlist: importWabbajackModlist, showInfo: showWabbajackInfoModal };
})();
