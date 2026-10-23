import React, { useEffect, useRef } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* The hero's system scene. Three.js loads in the browser only, and starts
   loading as soon as this module does, so the scene is ready by the time the
   hero has rendered. */
const sceneModule = typeof window === 'undefined' ? null : import('./scene');

const HeroScene = () => {
  const stageRef = useRef(null);
  const overlayRef = useRef(null);
  const logoUrl = useBaseUrl('/img/brands/nestjs.svg');
  const natsUrl = useBaseUrl('/img/brands/nats.svg');

  useEffect(() => {
    let dispose = null;
    let cancelled = false;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    sceneModule
      ?.then(({ createScene }) => {
        if (cancelled) return;

        dispose = createScene({
          container: stageRef.current,
          overlay: overlayRef.current,
          logoUrl,
          natsUrl,
          reduce,
        });
      })
      .catch((error) => {
        // without WebGL the hero stands on its own; say why, for whoever looks
        console.warn('[hero scene]', error);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [logoUrl, natsUrl]);

  return (
    <div className="scene">
      <div className="scene-stage" ref={stageRef} aria-hidden="true" />
      <div className="scene-overlay" ref={overlayRef} aria-hidden="true" />
    </div>
  );
};

export default HeroScene;
