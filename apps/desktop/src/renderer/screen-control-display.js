(function () {
  const image = document.getElementById('screenControlImage');
  const loading = document.getElementById('screenControlLoading');
  const guardError = document.getElementById('screenControlGuardError');
  let display = null;
  let lastImage = '';
  let imageStartedAt = null;
  function render() {
    if (!display?.images.length) return;
    if (imageStartedAt === null) imageStartedAt = Date.now();
    const elapsed = Math.max(0, Date.now() - imageStartedAt);
    const entry = display.images[Math.floor(elapsed / 5000) % display.images.length];
    if (lastImage === entry.id) return;
    lastImage = entry.id;
    image.src = entry.dataUrl;
    image.alt = entry.name || display.groupName;
    image.hidden = false;
    loading.hidden = true;
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
  setInterval(render, 100);
  for (const name of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel', 'dragstart', 'touchstart']) {
    window.addEventListener(name, (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, { capture: true, passive: false });
  }
})();
