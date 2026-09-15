// Keep fixed HUD layers and the WebGL viewport on the same visible rectangle.
// visualViewport also emits when Safari expands/collapses its address bar.
export function installViewport() {
  const update = () => {
    const view = window.visualViewport;
    const height = Math.round(view?.height || window.innerHeight);
    document.documentElement.style.setProperty('--view-h', `${height}px`);
    document.documentElement.style.setProperty('--view-top', `${view?.offsetTop || 0}px`);
    window.dispatchEvent(new Event('gameviewportchange'));
  };
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  update();
}
