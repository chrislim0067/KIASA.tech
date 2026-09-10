/**
 * Behaviours of the static content pages, ported from the inline scripts of the original
 * build. Each installer returns a disposer.
 */

/** Copy buttons on `.prompt-block` elements (blog articles). */
export function installCopyBlocks(root: ParentNode = document): () => void {
  const container = root.querySelector<HTMLElement>('.markdown-container');
  const copyLabel = container?.dataset.copy ?? 'Copy';
  const copiedLabel = container?.dataset.copied ?? 'Copied!';
  const cleanups: Array<() => void> = [];
  root.querySelectorAll<HTMLElement>('.prompt-block').forEach((block) => {
    if (block.querySelector('.copy-button')) return;
    const expand = (event: Event): void => {
      if (!(event.target as Element).closest('.copy-button')) block.classList.add('expanded');
    };
    block.addEventListener('click', expand);
    const button = document.createElement('button');
    button.className = 'copy-button';
    button.innerHTML = `<span class="copy-text">${copyLabel}</span><span class="copied-text">${copiedLabel}</span>`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const copy = async (event: Event): Promise<void> => {
      event.stopPropagation();
      const text = (block.textContent ?? '').replace(copyLabel, '').replace(copiedLabel, '').trim();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
      button.classList.add('copied');
      timer = setTimeout(() => button.classList.remove('copied'), 2000);
    };
    button.addEventListener('click', copy);
    block.appendChild(button);
    cleanups.push(() => {
      block.removeEventListener('click', expand);
      button.removeEventListener('click', copy);
      if (timer) clearTimeout(timer);
      button.remove();
    });
  });
  return () => cleanups.forEach((c) => c());
}

/** FAQ accordions on the landing pages (`.lp-faq`). */
export function installFaq(root: ParentNode = document): () => void {
  const cleanups: Array<() => void> = [];
  root.querySelectorAll<HTMLElement>('.lp-faq').forEach((faq) => {
    faq.querySelectorAll<HTMLElement>('[data-faq-item]').forEach((item) => {
      const btn = item.querySelector<HTMLElement>('[data-faq-toggle]');
      const answer = item.querySelector<HTMLElement>('.lp-faq__a');
      const icon = item.querySelector<HTMLElement>('.lp-faq__icon');
      if (!btn || !answer) return;
      const onClick = (): void => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          answer.style.maxHeight = `${answer.scrollHeight}px`;
          requestAnimationFrame(() => {
            answer.style.maxHeight = '0px';
          });
          btn.setAttribute('aria-expanded', 'false');
          item.classList.remove('open');
          if (icon) icon.textContent = '+';
        } else {
          answer.style.maxHeight = `${answer.scrollHeight}px`;
          btn.setAttribute('aria-expanded', 'true');
          item.classList.add('open');
          if (icon) icon.textContent = '−';
        }
      };
      const onEnd = (): void => {
        if (btn.getAttribute('aria-expanded') === 'true') answer.style.maxHeight = 'none';
      };
      item.addEventListener('click', onClick);
      answer.addEventListener('transitionend', onEnd);
      cleanups.push(() => {
        item.removeEventListener('click', onClick);
        answer.removeEventListener('transitionend', onEnd);
      });
    });
  });
  return () => cleanups.forEach((c) => c());
}

/** Parallax columns of X posts on the Osaka landing pages (`.web-x-posts`). */
export function installXPosts(): () => void {
  let disposed = false;
  let raf: number | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupScroll: (() => void) | null = null;

  const setup = (): void => {
    cleanupScroll?.();
    cleanupScroll = null;
    const root = document.querySelector<HTMLElement>('.web-x-posts');
    if (!root) return;
    const sticky = root.querySelector<HTMLElement>('.x-posts-sticky');
    const mobile = window.innerWidth < 768;
    const grid = root.querySelector<HTMLElement>(mobile ? '.x-posts--mobile' : '.x-posts--desktop');
    if (!sticky || !grid) return;
    const cols = grid.querySelectorAll<HTMLElement>('.x-posts__col');
    if (cols.length === 0) return;
    const ease = 0.08;
    interface Col {
      el: HTMLElement;
      scrollPercent: number;
      direction: string;
      maxScrollPx: number;
      currentOffset: number;
      targetOffset: number;
    }
    let state: Col[] = [];
    const measure = (): void => {
      const vh = window.innerHeight;
      state = Array.from(cols).map((el, i) => {
        const h = el.offsetHeight;
        const percent = parseFloat(el.dataset.scrollPercent ?? '100') / 100;
        const direction = el.dataset.direction ?? 'bottom-to-top';
        const prev = state[i];
        return { el, scrollPercent: percent, direction, maxScrollPx: Math.max(0, h - vh) * percent, currentOffset: prev?.currentOffset ?? 0, targetOffset: prev?.targetOffset ?? 0 };
      });
    };
    const target = (): void => {
      const rect = sticky.getBoundingClientRect();
      const total = sticky.offsetHeight - window.innerHeight;
      let p = -rect.top / total;
      p = Math.max(0, Math.min(1, p));
      state.forEach((c) => {
        c.targetOffset = c.direction === 'bottom-to-top' ? -c.maxScrollPx * (1 - p) : -c.maxScrollPx * p;
      });
    };
    const animate = (): void => {
      let moving = false;
      state.forEach((c) => {
        if (Math.abs(c.targetOffset - c.currentOffset) > 0.1) {
          c.currentOffset += (c.targetOffset - c.currentOffset) * ease;
          moving = true;
        } else c.currentOffset = c.targetOffset;
        c.el.style.transform = `translateY(${c.currentOffset}px)`;
      });
      raf = moving && !disposed ? requestAnimationFrame(animate) : null;
    };
    const onScroll = (): void => {
      target();
      if (!raf) raf = requestAnimationFrame(animate);
    };
    const images = Array.from(grid.querySelectorAll('img'));
    Promise.all(
      images.map((img) => (img.complete ? Promise.resolve() : new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      }))),
    ).then(() => {
      if (disposed) return;
      measure();
      target();
      state.forEach((c) => {
        c.currentOffset = c.targetOffset;
        c.el.style.transform = `translateY(${c.currentOffset}px)`;
      });
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    cleanupScroll = () => window.removeEventListener('scroll', onScroll);
  };

  const onResize = (): void => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setup, 100);
  };
  window.addEventListener('resize', onResize);
  setup();

  return () => {
    disposed = true;
    window.removeEventListener('resize', onResize);
    cleanupScroll?.();
    if (raf) cancelAnimationFrame(raf);
    if (resizeTimer) clearTimeout(resizeTimer);
  };
}
