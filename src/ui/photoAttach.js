// Photo attachments for feed posts: selection, client-side compression,
// Firebase Storage upload, and the image lightbox viewer.

import {
  ref,
  uploadBytes,
  getDownloadURL
} from 'https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js';
import { storage } from '../../firebase.js';

import { state } from '../state.js';
import { escapeAttr } from '../util/escape.js';
import { logError } from '../util/log.js';
import { showToast } from './toast.js';

const MAX_PHOTOS = 4;
const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.85;

// Module-local pending selection: [{ file, objectUrl }]
let pendingPhotos = [];

export const getPendingPhotoCount = function() {
  return pendingPhotos.length;
};

export const clearPhotoAttachments = function() {
  pendingPhotos.forEach(function(p) {
    URL.revokeObjectURL(p.objectUrl);
  });
  pendingPhotos = [];
  renderPhotoPreview();
};

export const initPhotoAttach = function() {
  pendingPhotos = [];
  const btn = document.getElementById('photoAttachBtn');
  const input = document.getElementById('photoFileInput');
  if (!btn || !input) return;

  btn.addEventListener('click', function() {
    input.click();
  });

  input.addEventListener('change', function() {
    handleFilesSelected(input.files);
    input.value = '';
  });
};

// Validates that the browser can decode the file (rules out HEIC and
// friends on most platforms) and yields an <img> for thumbnail + resize.
const loadImage = function(file) {
  return new Promise(function(resolve, reject) {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function() {
      resolve({ img: img, objectUrl: objectUrl });
    };
    img.onerror = function() {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('decode-failed'));
    };
    img.src = objectUrl;
  });
};

const handleFilesSelected = function(fileList) {
  const files = Array.prototype.slice.call(fileList || []);

  files.forEach(function(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      showToast('Only image files can be attached.', 'error');
      return;
    }
    if (pendingPhotos.length >= MAX_PHOTOS) {
      showToast('Up to ' + MAX_PHOTOS + ' photos per post.', 'error');
      return;
    }

    // Reserve the slot synchronously so a multi-select can't blow the cap
    // while decodes are in flight.
    const entry = { file: file, objectUrl: '' };
    pendingPhotos.push(entry);

    loadImage(file).then(function(loaded) {
      entry.objectUrl = loaded.objectUrl;
      renderPhotoPreview();
    }).catch(function() {
      pendingPhotos = pendingPhotos.filter(function(p) { return p !== entry; });
      showToast('Could not read ' + file.name + ' — that image format is not supported.', 'error');
      renderPhotoPreview();
    });
  });

  renderPhotoPreview();
};

const renderPhotoPreview = function() {
  const el = document.getElementById('photoAttachmentPreview');
  if (!el) return;

  if (!pendingPhotos.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  el.hidden = false;
  el.innerHTML = pendingPhotos.map(function(p, i) {
    const thumb = p.objectUrl
      ? '<img src="' + escapeAttr(p.objectUrl) + '" alt="" />'
      : '<span class="photo-preview-loading">&#8987;</span>';
    return '<div class="photo-preview-thumb">' +
      thumb +
      '<button type="button" class="photo-preview-remove" data-remove-photo="' + i + '" aria-label="Remove photo">&#10005;</button>' +
    '</div>';
  }).join('');

  el.querySelectorAll('[data-remove-photo]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const idx = parseInt(btn.getAttribute('data-remove-photo'), 10);
      const removed = pendingPhotos.splice(idx, 1)[0];
      if (removed && removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      renderPhotoPreview();
    });
  });
};

// Downscale to MAX_DIMENSION and re-encode as JPEG. Transparent pixels
// get a white background (JPEG has no alpha).
const compressImage = function(file) {
  return loadImage(file).then(function(loaded) {
    const img = loaded.img;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(loaded.objectUrl);

    return new Promise(function(resolve, reject) {
      canvas.toBlob(function(blob) {
        if (!blob) {
          reject(new Error('encode-failed'));
          return;
        }
        resolve({ blob: blob, w: w, h: h });
      }, 'image/jpeg', JPEG_QUALITY);
    });
  });
};

// Uploads all pending photos; resolves to the post doc's images array:
// [{ url, path, w, h }]. The path is kept so the cleanupPostImages
// Cloud Function can delete the files when the post is deleted.
export const uploadPendingPhotos = function() {
  if (!pendingPhotos.length) return Promise.resolve([]);
  if (!state.user) return Promise.reject(new Error('not-signed-in'));

  const stamp = Date.now();
  return Promise.all(pendingPhotos.map(function(p, i) {
    return compressImage(p.file).then(function(out) {
      const path = 'post-images/' + state.user.uid + '/' + stamp + '-' + i + '.jpg';
      const storageRef = ref(storage, path);
      return uploadBytes(storageRef, out.blob, { contentType: 'image/jpeg' }).then(function() {
        return getDownloadURL(storageRef);
      }).then(function(url) {
        return { url: url, path: path, w: out.w, h: out.h };
      });
    });
  }));
};

// One-shot compress + upload for a single image (used by chat). Resolves
// to { url, path, w, h }.
export const uploadChatImage = function(file, pathPrefix) {
  if (!state.user) return Promise.reject(new Error('not-signed-in'));
  if (!file || !file.type || file.type.indexOf('image/') !== 0) {
    return Promise.reject(new Error('not-an-image'));
  }
  return compressImage(file).then(function(out) {
    const path = (pathPrefix || 'chat-images') + '/' + state.user.uid + '/' + Date.now() + '.jpg';
    const imageRef = ref(storage, path);
    return uploadBytes(imageRef, out.blob, { contentType: 'image/jpeg' }).then(function() {
      return getDownloadURL(imageRef);
    }).then(function(url) {
      return { url: url, path: path, w: out.w, h: out.h };
    });
  });
};

// ─── Lightbox ────────────────────────────────────────────────────────────────
export const openImageLightbox = function(images, startIndex) {
  if (!Array.isArray(images) || !images.length) return;

  const existing = document.getElementById('imageLightbox');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  let index = Math.min(Math.max(startIndex || 0, 0), images.length - 1);

  const backdrop = document.createElement('div');
  backdrop.id = 'imageLightbox';
  backdrop.className = 'lightbox-backdrop';

  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.alt = 'Photo';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightbox-btn lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = '&#10005;';

  const counter = document.createElement('div');
  counter.className = 'lightbox-count';

  const sync = function() {
    img.src = images[index].url;
    counter.textContent = (index + 1) + ' / ' + images.length;
    counter.hidden = images.length < 2;
  };

  const close = function() {
    document.removeEventListener('keydown', onKey);
    if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  };

  const step = function(delta) {
    index = (index + delta + images.length) % images.length;
    sync();
  };

  const onKey = function(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && images.length > 1) step(-1);
    else if (e.key === 'ArrowRight' && images.length > 1) step(1);
  };

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  backdrop.appendChild(img);
  backdrop.appendChild(closeBtn);
  backdrop.appendChild(counter);

  if (images.length > 1) {
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'lightbox-btn lightbox-nav lightbox-prev';
    prevBtn.setAttribute('aria-label', 'Previous photo');
    prevBtn.innerHTML = '&#8249;';
    prevBtn.addEventListener('click', function() { step(-1); });

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'lightbox-btn lightbox-nav lightbox-next';
    nextBtn.setAttribute('aria-label', 'Next photo');
    nextBtn.innerHTML = '&#8250;';
    nextBtn.addEventListener('click', function() { step(1); });

    backdrop.appendChild(prevBtn);
    backdrop.appendChild(nextBtn);
  }

  sync();
  document.body.appendChild(backdrop);
};

// Wires click-to-open on any rendered post image grid inside container.
// getImages(postId) must return the post's images array.
export const wireLightboxButtons = function(container, getImages) {
  container.querySelectorAll('[data-lightbox-post]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const images = getImages(btn.getAttribute('data-lightbox-post'));
      openImageLightbox(images, parseInt(btn.getAttribute('data-lightbox-index'), 10) || 0);
    });
  });
};

// Shared renderer for a post's image grid (used by the feed).
export const renderPostImages = function(post) {
  const images = Array.isArray(post.images) ? post.images : [];
  if (!images.length) return '';

  const count = Math.min(images.length, MAX_PHOTOS);
  return '<div class="post-images post-images-' + count + '">' +
    images.slice(0, MAX_PHOTOS).map(function(im, i) {
      return '<button type="button" class="post-image-cell" data-lightbox-post="' + escapeAttr(post.id) + '" data-lightbox-index="' + i + '" aria-label="View photo">' +
        '<img src="' + escapeAttr(im.url) + '" alt="Photo" loading="lazy" />' +
      '</button>';
    }).join('') +
  '</div>';
};
