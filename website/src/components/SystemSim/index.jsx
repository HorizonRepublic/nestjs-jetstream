import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* The hero's system scene. Three.js loads only in the browser and only after
   the hero has rendered, so the copy never waits for it. */
const HeroScene = () => {
  const stageRef = useRef(null);
  const overlayRef = useRef(null);
  const logoUrl = useBaseUrl('/img/brands/nestjs.svg');
  const [stats, setStats] = useState({ published: 0, retried: 0, acked: 0 });

  useEffect(() => {
    let dispose = null;
    let cancelled = false;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    import('./scene')
      .then(({ createScene }) => {
        if (cancelled) return;

        dispose = createScene({
          container: stageRef.current,
          overlay: overlayRef.current,
          logoUrl,
          reduce,
          onStats: setStats,
        });
      })
      .catch(() => {
        /* no WebGL: the hero stands on its own */
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [logoUrl]);

  return (
    <div className="scene">
      <div className="scene-stage" ref={stageRef} aria-hidden="true" />
      <div className="scene-overlay" ref={overlayRef} aria-hidden="true" />
      <p className="scene-stats">
        published <b data-tone="deliver">{stats.published}</b> · retried{' '}
        <b data-tone="redeliver">{stats.retried}</b> · acked <b data-tone="ack">{stats.acked}</b> · lost{' '}
        <b>0</b>
      </p>
    </div>
  );
};

export default HeroScene;
