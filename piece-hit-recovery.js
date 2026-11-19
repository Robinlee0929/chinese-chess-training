// F3: recover only a missed inner top-cap hit. Never enlarge a piece or choose
// the nearest screen-space centre. The normal Three.js mesh hit remains first.
const INNER_RADIUS = 0.2;
const topCache = new WeakMap();

export function intersectInnerTop(origin, direction, top, radiusTop) {
  if (![...origin, ...direction, top, radiusTop].every(Number.isFinite)
    || radiusTop <= 0 || direction[1] >= -1e-8) return null;
  const t = (top - origin[1]) / direction[1];
  if (!Number.isFinite(t) || t < 0) return null;
  const x = origin[0] + t * direction[0], z = origin[2] + t * direction[2];
  const radius = Math.min(INNER_RADIUS, radiusTop / 2);
  return x * x + z * z <= radius * radius ? { x, y: top, z, t } : null;
}

function visible(object, scene) {
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
    if (node === scene) return true;
  }
  return false;
}

function materialVisible(material) {
  return material && material.visible !== false && (!material.transparent || material.opacity > 0);
}

function actualTop(geometry) {
  const position = geometry.attributes.position;
  if (!position || !position.count) return NaN;
  let cached = topCache.get(position);
  if (!cached || cached.version !== position.version) {
    let top = -Infinity;
    for (let i = 0; i < position.count; i++) top = Math.max(top, position.getY(i));
    cached = { version: position.version, top };
    topCache.set(position, cached);
  }
  return cached.top;
}

export function recoverPieceTopHit(raycaster, pieces, scene, sourceBoard) {
  if (!sourceBoard || !raycaster.ray.origin.toArray().every(Number.isFinite)
    || !raycaster.ray.direction.toArray().every(Number.isFinite)
    || Math.abs(raycaster.ray.direction.lengthSq() - 1) > 1e-8) return null;
  let candidate = null;
  for (const mesh of pieces) {
    const { r, c, piece } = mesh.userData;
    const logical = sourceBoard[r]?.[c];
    const params = mesh.geometry?.parameters;
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 9 || c < 0 || c > 8
      || !logical || !piece || logical.type !== piece.type || logical.side !== piece.side
      || mesh.parent !== scene || !visible(mesh, scene) || !raycaster.layers.test(mesh.layers)
      || mesh.geometry.type !== 'CylinderGeometry' || params.openEnded
      || params.thetaLength !== Math.PI * 2 || params.radiusTop !== 0.4 || params.height !== 0.36
      || !materialVisible(mesh.material?.[1])) continue;
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    // Current board geometry only: fail closed for moving, tilted, scaled or
    // stale meshes. Y-axis rotation is harmless to the circular inner cap.
    if (!e.every(Number.isFinite) || Math.abs(e[12] - (c - 4)) > 1e-9
      || Math.abs(e[13] - 0.18) > 1e-9 || Math.abs(e[14] - (4.5 - r)) > 1e-9
      || Math.abs(e[1]) + Math.abs(e[4]) + Math.abs(e[6]) + Math.abs(e[9]) > 1e-9
      || Math.abs(e[5] - 1) > 1e-9 || Math.abs(mesh.matrixWorld.determinant() - 1) > 1e-9
      || Math.abs(e[0] ** 2 + e[2] ** 2 - 1) > 1e-9
      || Math.abs(e[8] ** 2 + e[10] ** 2 - 1) > 1e-9
      || Math.abs(e[0] * e[8] + e[2] * e[10]) > 1e-9) continue;
    const top = actualTop(mesh.geometry);
    if (!Number.isFinite(top) || Math.abs(top - params.height / 2) > 1e-7) continue;
    const local = raycaster.ray.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
    const hit = intersectInnerTop(local.origin.toArray(), local.direction.toArray(), top, params.radiusTop);
    if (!hit) continue;
    const point = local.origin.clone().set(hit.x, hit.y, hit.z).applyMatrix4(mesh.matrixWorld);
    const distance = point.distanceTo(raycaster.ray.origin);
    if (distance < raycaster.near || distance > raycaster.far) continue;
    // Duplicate/stale registrations are ambiguous; never break a tie by order.
    if (pieces.filter(other => other.userData.r === r && other.userData.c === c).length !== 1
      || candidate) return null;
    candidate = { mesh, distance };
  }
  if (!candidate) return null;
  // A missed cap must not see through another visible scene surface. This runs
  // only after an inner-cap candidate exists, not on ordinary mesh hits.
  scene.updateMatrixWorld(true);
  const occluded = raycaster.intersectObjects(scene.children, true).some(hit => {
    if (hit.object === candidate.mesh || hit.distance > candidate.distance
      || !visible(hit.object, scene)) return false;
    const material = Array.isArray(hit.object.material)
      ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material;
    return materialVisible(material);
  });
  return occluded ? null : candidate.mesh;
}
