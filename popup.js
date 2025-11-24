const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const downloadBtn = document.getElementById('downloadSelected');
const selectAllBtn = document.getElementById('selectAll');


let lastCheckedIndex = null;

listEl.addEventListener('click', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'checkbox') {
    const checkboxes = Array.from(listEl.querySelectorAll('.tab-row input[type=checkbox]'));
    const currentIndex = checkboxes.indexOf(e.target);

    if (e.shiftKey && lastCheckedIndex !== null && lastCheckedIndex !== currentIndex) {
      const start = Math.min(lastCheckedIndex, currentIndex);
      const end = Math.max(lastCheckedIndex, currentIndex);

      for (let i = start; i <= end; i++) {
        if (!checkboxes[i].disabled) {
          checkboxes[i].checked = e.target.checked;
        }
      }
    }

    lastCheckedIndex = currentIndex;
  }
});

refreshBtn.addEventListener('click', refresh);
downloadBtn.addEventListener('click', downloadSelected);
selectAllBtn.addEventListener('click', selectAll);

async function refresh() {
  listEl.innerHTML = '';
  statusEl.textContent = 'Scanning tabs...';
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    // Create placeholders for all tabs first to maintain order
    const rowMap = new Map();
    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = 'tab-row';
      row.dataset.tabId = tab.id;

      // Initial loading state
      const loadingText = document.createElement('div');
      loadingText.textContent = `Scanning: ${tab.title || '...'}`;
      loadingText.style.padding = '10px';
      loadingText.style.color = '#666';
      row.appendChild(loadingText);

      listEl.appendChild(row);
      rowMap.set(tab, row);
    }

    // Process all tabs in parallel
    await Promise.all(tabs.map(async (tab) => {
      const row = rowMap.get(tab);

      // Check restricted pages
      if (!tab.url || tab.url.startsWith('chrome:') || tab.url.startsWith('edge:') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension:') || tab.url.includes('chrome.google.com/webstore')) {
        updateTabRow(row, tab, { available: false, reason: 'Restricted page' });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: getImageInfoFromPage
        });
        const res = results?.[0]?.result;
        updateTabRow(row, tab, res);
      } catch (e) {
        updateTabRow(row, tab, { available: false, reason: 'Cannot access (extension or special page)' });
      }
    }));

    statusEl.textContent = 'Scan complete.';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error: ' + err.message;
  }
}

// Updates an existing row with image info
function updateTabRow(row, tab, info) {
  row.innerHTML = ''; // Clear loading state

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = !info?.available;
  if (info?.available) checkbox.checked = false;

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.src = info?.thumb || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="%23f0f0f0"/></svg>';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = tab.title || info?.title || '(no title)';
  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = tab.url || '';

  meta.appendChild(title);
  if (info?.filename) {
    const f = document.createElement('div');
    f.style.fontSize = '12px';
    f.style.color = '#333';
    f.textContent = 'filename: ' + info.filename;
    meta.appendChild(f);
  }
  meta.appendChild(url);

  const note = document.createElement('div');
  note.style.fontSize = '12px';
  note.style.marginLeft = '6px';
  note.textContent = info?.available ? '' : (info?.reason || 'No image found');

  row.appendChild(checkbox);
  row.appendChild(thumb);
  row.appendChild(meta);
  row.appendChild(note);
}

// Select all available
function selectAll() {
  const rows = listEl.querySelectorAll('.tab-row');
  rows.forEach(r => {
    const cb = r.querySelector('input[type=checkbox]');
    if (cb && !cb.disabled) cb.checked = true;
  });
}

// Download selected: fetch images and zip them
async function downloadSelected() {
  const rows = Array.from(listEl.querySelectorAll('.tab-row'));
  const selected = rows.filter(r => {
    const cb = r.querySelector('input[type=checkbox]');
    return cb && cb.checked;
  });

  if (selected.length === 0) {
    statusEl.textContent = 'No tabs selected.';
    return;
  }

  statusEl.textContent = `Preparing to download ${selected.length} images...`;

  const zip = new JSZip();
  let count = 0;
  let errors = 0;

  const baseDate = new Date();
  for (let i = 0; i < selected.length; i++) {
    const r = selected[i];
    const tabId = parseInt(r.dataset.tabId, 10);
    try {
      // 1. Get image URL from page
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: getImageInfoFromPage,
        args: []
      });
      const info = results?.[0]?.result;

      if (!info || !info.available || !info.src) {
        console.warn('no image info for tab', tabId, info);
        errors++;
        continue;
      }

      // 2. Fetch image data
      statusEl.textContent = `Fetching ${i + 1}/${selected.length}: ${info.filename}`;
      try {
        const response = await fetch(info.src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();

        // 3. Add to ZIP
        // Ensure unique filename in zip
        let filename = info.filename || `image_${tabId}.jpg`;
        if (zip.file(filename)) {
          const ext = filename.split('.').pop();
          const base = filename.substring(0, filename.length - ext.length - 1);
          filename = `${base}_${tabId}.${ext}`;
        }

        // Set date sequentially (increment by 2 minutes for each file) to preserve order
        // FAT file systems have 2-second precision, so 1 second might be lost or rounded.
        // Using 2 minutes ensures clear ordering.
        const fileDate = new Date(baseDate.getTime() + i * 120000);
        zip.file(filename, blob, { date: fileDate });
        count++;
      } catch (fetchErr) {
        console.error('Fetch error for', info.src, fetchErr);
        errors++;
      }

    } catch (e) {
      console.error('Process error', e);
      errors++;
    }
  }

  if (count === 0) {
    statusEl.textContent = 'No images could be downloaded.';
    return;
  }

  statusEl.textContent = `Zipping ${count} images...`;
  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipFilename = `bulk_images_${timestamp}.zip`;

    await chrome.downloads.download({
      url: url,
      filename: zipFilename,
      saveAs: false // Avoid save dialog if possible
    });

    statusEl.textContent = `Done! Downloaded ${zipFilename} (${count} images). Errors: ${errors}`;
  } catch (zipErr) {
    console.error('Zip error', zipErr);
    statusEl.textContent = 'Error creating zip file: ' + zipErr.message;
  }
}

/**
 * This function runs inside the page (via chrome.scripting.executeScript).
 * It tries to find the main image on the page (largest <img> or background-image).
 * Returns an object { available: bool, src: string, filename: string, thumb: smallDataUrl, title: string }
 */
function getImageInfoFromPage() {
  try {
    // gather <img> elements
    const imgs = Array.from(document.getElementsByTagName('img')).filter(i => i.src);
    // choose largest by natural size (fallback to displayed size)
    let best = null;
    let bestArea = 0;
    for (const i of imgs) {
      const w = i.naturalWidth || i.width;
      const h = i.naturalHeight || i.height;
      const area = (w || 0) * (h || 0);
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }

    // If no <img>, try to inspect body background-image
    if (!best) {
      const computed = window.getComputedStyle(document.body);
      const bg = computed && computed.backgroundImage;
      if (bg && bg !== 'none') {
        // extract url("...") or url(...)
        const m = /url\\(["']?(.*?)["']?\\)/.exec(bg);
        if (m && m[1]) {
          const src = m[1];
          return {
            available: true,
            src: src,
            filename: src.split('/').pop().split('?')[0],
            thumb: null,
            title: document.title || ''
          };
        }
      }
      // also try meta og:image
      const metaOg = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
      if (metaOg && metaOg.content) {
        const src = metaOg.content;
        return {
          available: true,
          src: src,
          filename: src.split('/').pop().split('?')[0],
          thumb: null,
          title: document.title || ''
        };
      }
      return { available: false, reason: 'No image elements or background found', title: document.title || '' };
    }

    // Found best <img>
    const src = best.src;
    const filename = (best.getAttribute('alt') && best.getAttribute('alt').trim()) ? (best.getAttribute('alt').trim().replace(/[^a-z0-9_\-\.]/gi, '_') + '.' + (src.split('.').pop().split('?')[0] || 'jpg')) : src.split('/').pop().split('?')[0];

    // Build a small thumbnail (try-catch because cross-origin might block)
    let thumb = null;
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const MAX_W = 160;
      const w = best.naturalWidth || best.width || MAX_W;
      const h = best.naturalHeight || best.height || MAX_W;
      const ratio = Math.min(1, MAX_W / (w || MAX_W));
      canvas.width = Math.round((w || MAX_W) * ratio);
      canvas.height = Math.round((h || MAX_W) * ratio);
      ctx.drawImage(best, 0, 0, canvas.width, canvas.height);
      thumb = canvas.toDataURL('image/png');
    } catch (e) {
      // cross-origin draw may fail, ignore thumbnail
      thumb = null;
    }

    return {
      available: true,
      src,
      filename,
      thumb,
      title: document.title || ''
    };
  } catch (err) {
    return { available: false, reason: 'exception: ' + (err && err.message), title: document.title || '' };
  }
}

// auto-refresh on popup open
refresh();
