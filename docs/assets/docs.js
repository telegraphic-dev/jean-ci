function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('Fallback copy failed');
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  fallbackCopy(text);
}

function wireCopyButtons() {
  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-copy-target');
      const source = id ? document.getElementById(id) : null;
      if (!source) return;
      const text = source.innerText.replace(/\n$/, '');
      const original = button.textContent;
      try {
        await copyText(text);
        button.dataset.copied = 'true';
        button.textContent = 'Copied';
      } catch (error) {
        button.textContent = 'Copy failed';
        console.error(error);
      }
      window.setTimeout(() => {
        button.dataset.copied = 'false';
        button.textContent = original || 'Copy';
      }, 1600);
    });
  });
}

document.addEventListener('DOMContentLoaded', wireCopyButtons);
