export function scrollPageTop() {
  const main = document.querySelector('main');
  if (main) {
    main.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
