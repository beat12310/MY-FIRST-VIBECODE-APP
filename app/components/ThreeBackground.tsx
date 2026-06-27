'use client';

import React, { useRef, useEffect } from 'react';

// ─── CSS fallback (used when WebGL unavailable or if Three.js throws) ─────────

function GradientFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background:
          'radial-gradient(ellipse 80% 60% at 20% 50%, rgba(99,102,241,0.13) 0%, transparent 60%),' +
          'radial-gradient(ellipse 60% 50% at 80% 20%, rgba(139,92,246,0.10) 0%, transparent 60%),' +
          'radial-gradient(ellipse 40% 40% at 60% 80%, rgba(59,130,246,0.07) 0%, transparent 60%)',
      }}
    />
  );
}

// ─── Error boundary so a Three.js crash never kills the parent ────────────────

class ThreeErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) {
    console.warn('[ThreeBackground] caught error — switching to CSS fallback:', err);
  }
  render() {
    return this.state.failed ? <GradientFallback /> : this.props.children;
  }
}

// ─── WebGL capability probe ───────────────────────────────────────────────────

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

// ─── Imperative Three.js scene (avoids all R3F JSX-attribute quirks) ─────────

function ThreeCanvas({ intensity }: { intensity: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (!supportsWebGL()) return;

    let frameId = 0;
    let disposed = false;

    // Dynamic import keeps Three.js out of the SSR bundle entirely
    import('three').then((THREE) => {
      if (disposed || !canvasRef.current) return;

      // ── Renderer ────────────────────────────────────────────────────────────
      const renderer = new THREE.WebGLRenderer({
        canvas: canvasRef.current,
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(window.innerWidth, window.innerHeight);

      // ── Scene / Camera ───────────────────────────────────────────────────────
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 100);
      camera.position.set(0, 0, 8);

      // ── Lights ───────────────────────────────────────────────────────────────
      scene.add(new THREE.AmbientLight(0xffffff, 0.3 * intensity));
      const pl1 = new THREE.PointLight(0x6366f1, 0.8 * intensity);
      pl1.position.set(-5, 5, 5);
      scene.add(pl1);
      const pl2 = new THREE.PointLight(0x8b5cf6, 0.5 * intensity);
      pl2.position.set(5, -5, 3);
      scene.add(pl2);

      // ── Particles (built imperatively — avoids all R3F bufferAttribute issues) ──
      const COUNT = 1400;
      const positions = new Float32Array(COUNT * 3);
      const colors    = new Float32Array(COUNT * 3);
      const palette   = [
        new THREE.Color(0x6366f1),
        new THREE.Color(0x8b5cf6),
        new THREE.Color(0xa78bfa),
        new THREE.Color(0x3b82f6),
        new THREE.Color(0x22d3a0),
      ];
      for (let i = 0; i < COUNT; i++) {
        const i3 = i * 3;
        positions[i3]     = (Math.random() - 0.5) * 24;
        positions[i3 + 1] = (Math.random() - 0.5) * 24;
        positions[i3 + 2] = (Math.random() - 0.5) * 18;
        const c = palette[i % palette.length];
        colors[i3]     = c.r;
        colors[i3 + 1] = c.g;
        colors[i3 + 2] = c.b;
      }
      const ptGeo = new THREE.BufferGeometry();
      ptGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      ptGeo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
      const ptMat = new THREE.PointsMaterial({
        size: 0.045,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        sizeAttenuation: true,
        depthWrite: false,
      });
      const points = new THREE.Points(ptGeo, ptMat);
      scene.add(points);

      // ── Grid lines ───────────────────────────────────────────────────────────
      const lineVerts: number[] = [];
      const step = 2.5;
      const half = 14;
      for (let x = -half; x <= half; x += step) {
        lineVerts.push(x, -half, -8, x, half, -8);
      }
      for (let y = -half; y <= half; y += step) {
        lineVerts.push(-half, y, -8, half, y, -8);
      }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineVerts), 3));
      const lineMat = new THREE.LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.07 });
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      scene.add(lines);

      // ── Floating orbs ────────────────────────────────────────────────────────
      const orbConfigs = [
        { pos: [-4,  2, -3] as [number, number, number], color: 0x6366f1, r: 0.9, spd: 0.4 },
        { pos: [ 5, -1, -5] as [number, number, number], color: 0x8b5cf6, r: 0.6, spd: 0.6 },
        { pos: [ 1,  3, -4] as [number, number, number], color: 0x22d3a0, r: 0.4, spd: 0.8 },
      ];
      const orbs = orbConfigs.map(cfg => {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(cfg.r, 16, 16),
          new THREE.MeshStandardMaterial({
            color: cfg.color,
            emissive: cfg.color,
            emissiveIntensity: 0.4,
            transparent: true,
            opacity: 0.15,
            roughness: 0.1,
            metalness: 0.8,
          })
        );
        mesh.position.set(...cfg.pos);
        scene.add(mesh);
        return { mesh, ...cfg };
      });

      // ── Resize handler ───────────────────────────────────────────────────────
      const onResize = () => {
        if (disposed) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      };
      window.addEventListener('resize', onResize, { passive: true });

      // ── Animation loop ───────────────────────────────────────────────────────
      const clock = new THREE.Clock();
      const animate = () => {
        if (disposed) return;
        frameId = requestAnimationFrame(animate);
        const t = clock.getElapsedTime();
        points.rotation.y = t * 0.018;
        points.rotation.x = Math.sin(t * 0.008) * 0.12;
        lineMat.opacity = 0.06 + Math.sin(t * 0.4) * 0.02;
        orbs.forEach(o => {
          o.mesh.position.y = o.pos[1] + Math.sin(t * o.spd) * 0.5;
          o.mesh.position.x = o.pos[0] + Math.cos(t * o.spd * 0.5) * 0.3;
        });
        renderer.render(scene, camera);
      };
      animate();

      // ── Cleanup ──────────────────────────────────────────────────────────────
      // Store cleanup in a closure the useEffect return can call
      (canvasRef.current as HTMLCanvasElement & { _threeDispose?: () => void })._threeDispose = () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(frameId);
        ptGeo.dispose();
        ptMat.dispose();
        lineGeo.dispose();
        lineMat.dispose();
        orbs.forEach(o => { o.mesh.geometry.dispose(); (o.mesh.material as import('three').Material).dispose(); });
        renderer.dispose();
      };
    }).catch(err => {
      console.warn('[ThreeBackground] Three.js import failed:', err);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      const el = canvasRef.current as (HTMLCanvasElement & { _threeDispose?: () => void }) | null;
      el?._threeDispose?.();
    };
  }, [intensity]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 0,
        display: 'block',
      }}
    />
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export default function ThreeBackground({ intensity = 1 }: { intensity?: number }) {
  return (
    <ThreeErrorBoundary>
      <ThreeCanvas intensity={intensity} />
    </ThreeErrorBoundary>
  );
}
