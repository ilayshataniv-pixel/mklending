// Set this to the HTTPS address printed by Wrangler after the Worker is deployed.
const serviceOrigin = 'https://mklending.mklending.workers.dev';

const menu = document.querySelector('.mobile-navigation');
menu.querySelectorAll('a').forEach(link => link.addEventListener('click', () => { menu.open = false; }));
menu.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !menu.open) return;
  menu.open = false;
  menu.querySelector('summary').focus();
});

document.documentElement.dataset.bookingOrigin = serviceOrigin;
if (serviceOrigin) {
  document.querySelectorAll('[data-guest]').forEach(link => {
    link.href = new URL(link.getAttribute('href'), serviceOrigin).href;
  });
} else {
  document.querySelectorAll('[data-guest]').forEach(link => { link.hidden = true; });
  document.querySelector('.weekbar').hidden = true;
}
