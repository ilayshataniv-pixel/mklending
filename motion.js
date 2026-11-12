(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (!('IntersectionObserver' in window) || reduced.matches) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.08 });
  document.querySelectorAll('main .card, main .price, .teacher-gallery, .about-grid > div:last-child, main section > .wrap > h2').forEach((node, index) => {
    // Above-the-fold content stays visible; animation progressively enhances the rest.
    if (node.getBoundingClientRect().top < innerHeight) return;
    node.style.setProperty('--reveal-delay', `${index % 3 * 65}ms`);
    node.classList.add('has-reveal');
    observer.observe(node);
  });
  reduced.addEventListener('change', event => {
    if (!event.matches) return;
    observer.disconnect();
    document.querySelectorAll('.has-reveal').forEach(node => node.classList.add('is-visible'));
  });
})();
