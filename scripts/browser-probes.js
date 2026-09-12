/* eslint-env browser */
/* Injected into every page of the browser regression suite as window.__deja.
   Kept as plain browser script so Playwright can add it before any app code
   runs and it survives every navigation. */
(() => {
  const EPSILON = 1.5;
  const INTERACTIVE = 'button, a[href], select, input, textarea, [tabindex]:not([tabindex="-1"])';

  /** Nearest ancestor that can actually scroll, else the viewport itself. */
  function scrollerFor(element) {
    let node = element.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function scrollerBox(scroller) {
    if (!scroller) {
      return { top: 0, left: 0, clientWidth: window.innerWidth, clientHeight: window.innerHeight, maxScrollY: 0 };
    }
    const rect = scroller.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      clientWidth: scroller.clientWidth,
      clientHeight: scroller.clientHeight,
      maxScrollY: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    };
  }

  function describe(element) {
    const id = element.id ? `#${element.id}` : '';
    const cls = typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    const text = (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28);
    return `${element.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  }

  /**
   * Measures one element against the box a user can actually reach: any amount
   * of vertical scrolling is allowed, no horizontal scrolling is.
   */
  function measure(element) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return { label: describe(element), rendered: false };
    }
    const scroller = scrollerFor(element);
    const restoreTop = scroller ? scroller.scrollTop : 0;
    const restoreLeft = scroller ? scroller.scrollLeft : 0;
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }

    const box = scrollerBox(scroller);
    const rect = element.getBoundingClientRect();
    const top = rect.top - box.top;
    const bottom = rect.bottom - box.top;
    const left = rect.left - box.left;
    const right = rect.right - box.left;

    const result = {
      label: describe(element),
      rendered: rect.width >= 1 && rect.height >= 1,
      scroller: scroller ? describe(scroller) : '(viewport)',
      // Content above the scroll origin can never be scrolled to.
      reachableVertically: top >= -EPSILON && bottom <= box.clientHeight + box.maxScrollY + EPSILON,
      // Horizontal scrolling is never an acceptable way to reach anything here.
      withinWidth: left >= -EPSILON && right <= box.clientWidth + EPSILON,
      neededScroll: bottom > box.clientHeight + EPSILON || top < -EPSILON,
      top: Math.round(top),
      bottom: Math.round(bottom),
      left: Math.round(left),
      right: Math.round(right),
      clientHeight: box.clientHeight,
      clientWidth: box.clientWidth,
      maxScrollY: Math.round(box.maxScrollY),
    };

    if (scroller) {
      scroller.scrollTop = restoreTop;
      scroller.scrollLeft = restoreLeft;
    }

    // Occlusion only matters for things a player has to hit.
    if (result.rendered && element.matches(INTERACTIVE)) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const hitRect = element.getBoundingClientRect();
      const x = hitRect.left + hitRect.width / 2;
      const y = hitRect.top + hitRect.height / 2;
      const hit = document.elementFromPoint(x, y);
      result.occluded = !hit || !(element === hit || element.contains(hit) || hit.contains(element));
      result.occludedBy = result.occluded && hit ? describe(hit) : null;
      result.insideViewport = hitRect.top >= -EPSILON && hitRect.bottom <= window.innerHeight + EPSILON
        && hitRect.left >= -EPSILON && hitRect.right <= window.innerWidth + EPSILON;
    } else {
      result.occluded = false;
      result.insideViewport = null;
    }
    return result;
  }

  window.__deja = {
    /** The element that owns the current view: an open dialog, else the active screen. */
    activeContainer() {
      const dialog = Array.from(document.querySelectorAll('dialog')).find((node) => node.open);
      return dialog || document.querySelector('.screen.is-active');
    },

    activeName() {
      const container = window.__deja.activeContainer();
      return container ? container.id : null;
    },

    /** Horizontal overflow anywhere in the layout chain, plus the active view's scroll extent. */
    overflow() {
      const container = window.__deja.activeContainer();
      const app = document.querySelector('#app');
      const measurements = {
        documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyX: document.body.scrollWidth - document.body.clientWidth,
        appX: app ? app.scrollWidth - app.clientWidth : 0,
        containerX: container ? container.scrollWidth - container.clientWidth : 0,
        containerY: container ? container.scrollHeight - container.clientHeight : 0,
        containerScrollsY: container ? /(auto|scroll)/.test(getComputedStyle(container).overflowY) : false,
        container: container ? container.id : null,
      };
      measurements.horizontal = Math.max(
        measurements.documentX, measurements.bodyX, measurements.appX, measurements.containerX,
      );
      return measurements;
    },

    /**
     * Every match of every selector, so "all 30 cards" is a single expectation.
     * Scoped to the view on screen: the same selector can exist on several
     * screens, and only the visible one is this screen's responsibility.
     */
    inspect(selectors) {
      const container = window.__deja.activeContainer();
      const report = {};
      for (const selector of selectors) {
        const elements = container ? Array.from(container.querySelectorAll(selector)) : [];
        report[selector] = {
          count: elements.length,
          elements: elements.map(measure),
        };
      }
      return report;
    },

    /**
     * Screens cross-fade, and a half-faded screen measures as invisible. Wait
     * for the active one to finish arriving before anything is measured.
     */
    settle(timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      return new Promise((resolve) => {
        const check = () => {
          const active = document.querySelector('.screen.is-active');
          if (!active || performance.now() > deadline) { resolve(); return; }
          const style = getComputedStyle(active);
          if (style.visibility === 'visible' && Number(style.opacity) >= 0.99) {
            // One more frame so the transform has landed too.
            requestAnimationFrame(() => resolve());
            return;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
    },

    /** Force a screen for layout-only checks, without going through the app flow. */
    async showScreen(name) {
      document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
      document.querySelectorAll('.screen').forEach((screen) => {
        const active = screen.id === `screen-${name}`;
        screen.hidden = !active;
        screen.classList.toggle('is-active', active);
      });
      await window.__deja.settle();
    },

    async openDialog(id) {
      const dialog = document.querySelector(`#${id}`);
      if (!dialog.open) dialog.showModal();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return dialog.id;
    },

    closeDialogs() {
      document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    },

    /** Load a stand-in clip so intro layout can be measured without a proprietary codec. */
    async useIntroFixture(dataUrl) {
      const video = document.querySelector('#intro-video');
      video.muted = true;
      video.src = dataUrl;
      await new Promise((resolve) => {
        if (video.readyState >= 1) { resolve(); return; }
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
      return { width: video.videoWidth, height: video.videoHeight };
    },

    /** Where the frame is actually painted, given object-fit: contain. */
    introGeometry() {
      const screen = document.querySelector('#screen-intro');
      const video = document.querySelector('#intro-video');
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      const result = {
        objectFit: style.objectFit,
        natural: [video.videoWidth, video.videoHeight],
        boxWidth: rect.width,
        boxHeight: rect.height,
        screenWidth: screen.clientWidth,
        screenHeight: screen.clientHeight,
        gridTemplateRows: getComputedStyle(screen).gridTemplateRows,
        overflowY: screen.scrollHeight - screen.clientHeight,
        overflowX: screen.scrollWidth - screen.clientWidth,
      };
      if (video.videoWidth && video.videoHeight) {
        const natural = video.videoWidth / video.videoHeight;
        const boxRatio = rect.width / rect.height;
        result.drawnWidth = boxRatio > natural ? rect.height * natural : rect.width;
        result.drawnHeight = boxRatio > natural ? rect.height : rect.width / natural;
        result.drawnRatio = result.drawnWidth / result.drawnHeight;
        result.naturalRatio = natural;
      }
      return result;
    },

    /**
     * The desktop-only viewport-fit rules are gated on a precise pointer, so
     * this must stay false on every touch device.
     */
    desktopQueryMatches() {
      return matchMedia('(min-width: 760px) and (hover: hover) and (pointer: fine)').matches;
    },

    /** Board geometry: driven by CSS box maths, not by font metrics. */
    boardFingerprint() {
      const grid = document.querySelector('#card-grid');
      const card = document.querySelector('.memory-card');
      if (!grid || !card) return null;
      return {
        columns: Number(grid.getAttribute('aria-colcount')),
        rows: Number(grid.getAttribute('aria-rowcount')),
        gridWidth: Math.round(grid.getBoundingClientRect().width),
        cardWidth: Math.round(card.getBoundingClientRect().width),
        cardHeight: Math.round(card.getBoundingClientRect().height),
        // The resolved cap is the clearest signal that a mobile rule still wins.
        gridMaxWidth: getComputedStyle(grid).maxWidth,
      };
    },

    /** Menu widths: same reasoning, widths only. */
    menuFingerprint() {
      const width = (selector) => {
        const node = document.querySelector(selector);
        return node ? Math.round(node.getBoundingClientRect().width) : null;
      };
      return {
        contentWidth: width('.menu-content'),
        navWidth: width('.menu-nav'),
        buttonWidth: width('.menu-button'),
      };
    },

    dialogFingerprint(id) {
      const dialog = document.querySelector(`#${id}`);
      const rect = dialog.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        withinViewport: rect.top >= -1.5 && rect.bottom <= window.innerHeight + 1.5
          && rect.left >= -1.5 && rect.right <= window.innerWidth + 1.5,
        scrollsY: /(auto|scroll)/.test(getComputedStyle(dialog).overflowY),
      };
    },
  };
})();
