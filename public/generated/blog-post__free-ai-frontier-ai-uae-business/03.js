
const fadeEls = document.querySelectorAll('.fade-up');
const fadeIO = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); fadeIO.unobserve(e.target); } });
}, { threshold: 0.15 });
fadeEls.forEach(el => fadeIO.observe(el));

const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
const mobileClose = document.getElementById('mobileClose');
function toggleMobileMenu(open) {
    const isOpen = open !== undefined ? open : !mobileMenu.classList.contains('open');
    mobileMenu.classList.toggle('open', isOpen);
    hamburger.classList.toggle('open', isOpen);
    document.body.classList.toggle('menu-open', isOpen);
    document.documentElement.style.overflowY = isOpen ? 'hidden' : '';  // lock the real scroller
}
hamburger.addEventListener('click', () => toggleMobileMenu());
mobileClose.addEventListener('click', () => toggleMobileMenu(false));
document.querySelectorAll('.m-link').forEach(l => l.addEventListener('click', () => toggleMobileMenu(false)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobileMenu.classList.contains('open')) toggleMobileMenu(false); });
