import * as THREE from './vendor/three.module.js';
import { SoftwareLogoRenderer } from './software-renderer.js';

const viewport = document.getElementById('logo-3d');
const container = document.getElementById('logo-container');
const toolbar = document.getElementById('logo-3d-toolbar');
const spin = document.getElementById('logo-3d-spin');
const reset = document.getElementById('logo-3d-reset');
const hint = document.getElementById('logo-3d-hint');
const root = document.documentElement;
const motion = matchMedia('(prefers-reduced-motion: reduce)');
let renderer, model, material, frame = 0, lastTime = 0, lastDraw = 0;
let yaw = .28, pitch = .06, targetYaw = yaw, targetPitch = pitch;
let autoRotate = false, visible = true, dirty = true, pointer;
let radius = .3, failed = false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, .005, 5);

function labels() {
  const zh = root.lang.startsWith('zh');
  viewport.setAttribute('aria-label', zh
    ? 'QUINCY 3D Logo，可拖曳旋轉，也可使用方向鍵；Home 回正面'
    : 'QUINCY 3D logo. Drag or use arrow keys to rotate; Home resets the view.');
  hint.textContent = zh ? '拖曳旋轉 · 雙擊回正' : 'Drag to rotate · Double-click to reset';
  spin.setAttribute('aria-pressed', String(autoRotate));
  spin.setAttribute('aria-label', zh ? '自動旋轉' : 'Auto-rotate');
  spin.title = zh ? (autoRotate ? '暫停旋轉' : '開始旋轉') : (autoRotate ? 'Pause rotation' : 'Start rotation');
  reset.setAttribute('aria-label', zh ? '回到正面' : 'Reset to front');
  reset.title = zh ? '回到正面' : 'Reset to front';
  toolbar.setAttribute('aria-label', zh ? '3D Logo 控制' : '3D logo controls');
}

function theme() {
  if (!material) return;
  const dark = root.classList.contains('dark');
  material.color.setRGB(...(dark ? [.55, .61, .66] : [.035, .045, .052]));
  material.metalness = dark ? .7 : .45;
  dirty = true;
}

// Read the original Studio GLB without converting its contours or back faces.
function readModel(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw Error('Invalid logo model');
  let gltf, bin;
  for (let offset = 12; offset < buffer.byteLength;) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset + 8, length)));
    if (type === 0x004e4942) bin = buffer.slice(offset + 8, offset + 8 + length);
    offset += 8 + length;
  }
  const array = id => {
    const accessor = gltf.accessors[id], bv = gltf.bufferViews[accessor.bufferView];
    const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[accessor.componentType];
    return new Type(bin, (bv.byteOffset || 0) + (accessor.byteOffset || 0), accessor.count * (accessor.type === 'VEC3' ? 3 : 1));
  };
  material = new THREE.MeshStandardMaterial({ roughness: .3, side: THREE.FrontSide });
  const group = new THREE.Group();
  for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(array(primitive.attributes.POSITION), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(array(primitive.attributes.NORMAL), 3));
    geometry.setIndex(new THREE.BufferAttribute(array(primitive.indices), 1));
    geometry.computeBoundingSphere();
    group.add(new THREE.Mesh(geometry, material));
  }
  const box = new THREE.Box3().setFromObject(group);
  group.position.sub(box.getCenter(new THREE.Vector3()));
  const size = box.getSize(new THREE.Vector3());
  radius = Math.max(size.x, size.y, size.z) / 2;
  return group;
}

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!renderer || !w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const pixelRatio = Math.min(devicePixelRatio || 1, renderer.isSoftware ? 1.25 : 2.5);
  renderer.setSize(Math.round(w * pixelRatio), Math.round(h * pixelRatio), false);
  dirty = true;
}

function useSoftware() {
  const old = renderer;
  renderer = new SoftwareLogoRenderer();
  renderer.domElement.setAttribute('aria-hidden', 'true');
  if (old?.domElement.parentNode) old.domElement.replaceWith(renderer.domElement);
  else viewport.appendChild(renderer.domElement);
  try { old?.dispose(); } catch (_) { /* Lost GPU context is already detached. */ }
  resize();
  dirty = true;
}

function restoreFront() {
  autoRotate = false;
  // Choose the nearest full turn so resetting never takes the long way around.
  targetYaw = Math.round(yaw / (2 * Math.PI)) * 2 * Math.PI;
  targetPitch = 0;
  if (motion.matches) { yaw = targetYaw; pitch = targetPitch; }
  dirty = true;
  labels();
  wake();
}

function wake() {
  if (!frame && model && visible && !document.hidden && !failed) frame = requestAnimationFrame(tick);
}

function tick(time) {
  frame = 0;
  if (!visible || document.hidden || failed) { lastTime = 0; return; }
  const dt = lastTime ? Math.min((time - lastTime) / 1000, .06) : 1 / 60;
  lastTime = time;
  if (autoRotate && !pointer) { targetYaw += dt * .18; dirty = true; }
  const ease = motion.matches ? 1 : 1 - Math.exp(-dt * 12);
  yaw += (targetYaw - yaw) * ease;
  pitch += (targetPitch - pitch) * ease;
  const settling = Math.abs(targetYaw - yaw) + Math.abs(targetPitch - pitch) > .0001;
  if (settling) dirty = true;
  const fov = THREE.MathUtils.degToRad(camera.fov / 2);
  const distance = radius * 1.12 / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)));
  camera.position.set(distance * Math.sin(yaw) * Math.cos(pitch), distance * Math.sin(pitch), distance * Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(0, 0, 0);
  if (dirty && time - lastDraw >= (renderer.isSoftware ? 40 : 16)) {
    try {
      renderer.render(scene, camera);
      container.classList.add('has-3d-logo');
      viewport.dataset.ready = 'true';
      viewport.dataset.angle = String(Math.round(yaw * 180 / Math.PI));
      toolbar.hidden = false;
      hint.hidden = false;
      dirty = false;
      lastDraw = time;
    } catch (error) {
      if (!renderer.isSoftware) { useSoftware(); dirty = true; }
      else { fallback(error); return; }
    }
  }
  if (autoRotate || settling || dirty) wake();
}

function fallback(error) {
  failed = true;
  cancelAnimationFrame(frame); frame = 0;
  container.classList.remove('has-3d-logo');
  viewport.dataset.ready = 'false';
  viewport.hidden = true;
  toolbar.hidden = true;
  hint.hidden = true;
  console.warn('3D logo unavailable; keeping the original logo visible.', error);
}

async function init() {
  try {
    scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x77818a, 2.4));
    for (const [color, intensity, position] of [
      [0xffffff, 4, [.25, .3, .4]], [0xc5dfff, 3.3, [-.3, .06, .12]],
      [0xffffff, 4.5, [.25, .13, -.35]], [0xe5edf8, 2.5, [-.2, -.1, -.3]],
    ]) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(...position); scene.add(light);
    }
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', stencil: false });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      viewport.appendChild(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        try { useSoftware(); wake(); } catch (error) { fallback(error); }
      });
    } catch (_) { useSoftware(); }
    const response = await fetch(new URL('./Quincy-Logo.glb', import.meta.url));
    if (!response.ok) throw Error('Logo model could not be loaded');
    model = readModel(await response.arrayBuffer());
    scene.add(model); theme(); resize(); labels();

    viewport.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.setPointerCapture(event.pointerId);
      autoRotate = false; labels();
      event.stopPropagation();
    });
    viewport.addEventListener('pointermove', event => {
      event.stopPropagation();
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      targetYaw -= dx * .015;
      if (event.pointerType !== 'touch') targetPitch = THREE.MathUtils.clamp(targetPitch + dy * .012, -1.35, 1.35);
      pointer.x = event.clientX; pointer.y = event.clientY;
      dirty = true; wake();
    });
    const release = event => {
      if (pointer?.id !== event.pointerId) return;
      pointer = null;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      wake();
    };
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, release);
    viewport.addEventListener('dblclick', restoreFront);
    viewport.addEventListener('keydown', event => {
      if (event.key === 'Home') { event.preventDefault(); restoreFront(); return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === ' ') autoRotate = !autoRotate;
      else {
        autoRotate = false;
        if (event.key === 'ArrowLeft') targetYaw -= .18;
        if (event.key === 'ArrowRight') targetYaw += .18;
        if (event.key === 'ArrowUp') targetPitch += .12;
        if (event.key === 'ArrowDown') targetPitch -= .12;
        targetPitch = THREE.MathUtils.clamp(targetPitch, -1.35, 1.35);
      }
      dirty = true; labels(); wake();
    });
    spin.addEventListener('click', () => { autoRotate = !autoRotate; labels(); wake(); });
    reset.addEventListener('click', restoreFront);
    new ResizeObserver(() => { resize(); wake(); }).observe(viewport);
    new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'class')) theme();
      labels(); wake();
    }).observe(root, { attributes: true, attributeFilter: ['class', 'lang'] });
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) { lastTime = 0; dirty = true; wake(); }
    }).observe(viewport);
    document.addEventListener('visibilitychange', () => { lastTime = 0; dirty = true; wake(); });
    motion.addEventListener('change', () => { if (motion.matches) autoRotate = false; labels(); dirty = true; wake(); });
    wake();
  } catch (error) { fallback(error); }
}

init();
