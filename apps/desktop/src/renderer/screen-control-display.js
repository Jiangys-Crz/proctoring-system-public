(function () {
  const image = document.getElementById('screenControlImage');
  const loading = document.getElementById('screenControlLoading');
  const guardError = document.getElementById('screenControlGuardError');
  let display = null;
  let lastImage = '';
  let imageStartedAt = null;
  let slideTimer = 0;
  function render() {
    clearTimeout(slideTimer);
    slideTimer = 0;
    if (!display?.images?.length) return;
    const now = Date.now();
    if (imageStartedAt === null) imageStartedAt = now;
    const elapsed = Math.max(0, now - imageStartedAt);
    const interval = 5000;
    const entry = display.images[Math.floor(elapsed / interval) % display.images.length];
    if (lastImage !== entry.id) {
      lastImage = entry.id;
      image.src = entry.dataUrl;
      image.alt = entry.name || display.groupName;
      image.hidden = false;
      loading.hidden = true;
    }
    if (display.images.length > 1) slideTimer = setTimeout(render, interval - elapsed % interval);
  }
  window.screenControlDisplay.subscribe((value) => {
    const changed = display?.id !== value.id;
    display = value;
    if (guardError) {
      guardError.textContent = value.guardError || '';
      guardError.hidden = !value.guardError;
    }
    if (changed) {
      lastImage = '';
      imageStartedAt = null;
      image.hidden = true;
      image.removeAttribute('src');
      loading.hidden = false;
    }
    render();
  });
  for (const name of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel', 'dragstart', 'touchstart']) {
    window.addEventListener(name, (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true, passive: false });
  }
})();
