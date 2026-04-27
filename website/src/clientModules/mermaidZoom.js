
const CONTAINER_SELECTOR = '.docusaurus-mermaid-container';
const OVERLAY_ID = 'jt-mermaid-zoom-overlay';
const OPEN_CLASS = 'jt-mermaid-zoom-open';

const buildOverlay = () => {
  const overlay = document.createElement('div');

  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Diagram preview');

  const close = document.createElement('button');

  close.type = 'button';
  close.className = 'jt-mermaid-zoom-close';
  close.setAttribute('aria-label', 'Close preview');
  close.innerHTML = `
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M3 3l10 10M13 3l-10 10" />
    </svg>
  `;

  const stage = document.createElement('div');

  stage.className = 'jt-mermaid-zoom-stage';

  overlay.appendChild(stage);
  overlay.appendChild(close);

  return { overlay, stage, close };
};

const openOverlay = (sourceContainer) => {
  const sourceSvg = sourceContainer.querySelector('svg');

  if (!sourceSvg) return;

  // If an overlay is already open, do nothing — its own listeners stay live.
  // Clicking a second diagram while the first is up would otherwise leak the
  // first overlay's keydown handler on `document`.
  if (document.getElementById(OVERLAY_ID)) return;

  const { overlay, stage, close } = buildOverlay();
  const clone = sourceSvg.cloneNode(true);

  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.style.width = '100%';
  clone.style.height = '100%';
  clone.style.maxWidth = '100%';
  clone.style.maxHeight = '100%';

  stage.appendChild(clone);
  document.body.appendChild(overlay);
  document.body.classList.add(OPEN_CLASS);

  requestAnimationFrame(() => overlay.classList.add('is-visible'));

  const dismiss = () => {
    overlay.classList.remove('is-visible');
    document.body.classList.remove(OPEN_CLASS);
    document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.remove(), 180);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') dismiss();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target === stage) dismiss();
  });
  close.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
};

const onClick = (event) => {
  const container = event.target.closest(CONTAINER_SELECTOR);

  if (!container) return;
  if (event.target.closest('.jt-mermaid-zoom-close')) return;

  openOverlay(container);
};

if (typeof document !== 'undefined') {
  document.addEventListener('click', onClick);
}

export default {};
