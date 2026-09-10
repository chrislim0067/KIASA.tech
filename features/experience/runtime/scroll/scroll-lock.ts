/** Scroll lock helpers (ports of `st` and `We`). */
export const lockScroll = (): void => {
  document.body.setAttribute('data-lenis-prevent', '');
  document.body.style.overflow = 'hidden';
};

export const unlockScroll = (): void => {
  document.body.removeAttribute('data-lenis-prevent');
  document.body.style.overflow = '';
  document.body.classList.remove('autoscroll');
};
