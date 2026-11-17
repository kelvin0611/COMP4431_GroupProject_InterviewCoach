import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { STAR_ELEMENTS } from '../lib/types';
import type { ProgressPoint } from '../lib/types';

// Columns shown; older sessions stay in history but drop off the chart.
const MAX_POINTS = 10;

function shortDate(date: string) {
  return new Intl.DateTimeFormat('en-HK', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Hong_Kong',
  }).format(new Date(date));
}

/** STAR elements evidenced in each recent session, so practice shows visible progress. */
export function ProgressChart() {
  const [points, setPoints] = useState<ProgressPoint[] | null>(null);

  useEffect(() => {
    let active = true;
    api
      .progress()
      .then((data) => {
        if (active) setPoints(data);
      })
      .catch(() => {
        // The chart is supplementary: if progress cannot load, the history list still works.
        if (active) setPoints([]);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!points?.length) return null;
  const recent = points.slice(-MAX_POINTS);
  const latest = recent[recent.length - 1].covered.length;
  const best = Math.max(...recent.map((point) => point.covered.length));
  return (
    <section className="progress-chart" aria-labelledby="progress-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR GROWTH</p>
          <h2 id="progress-title">STAR coverage over time</h2>
        </div>
        <p className="progress-summary">
          Latest {latest} of 4 · Best {best} of 4
        </p>
      </div>
      <ol className="progress-columns">
        {recent.map((point) => (
          <li
            key={point.session_id}
            title={point.role_title}
            aria-label={`${shortDate(point.created_at)}: ${point.covered.length} of 4 (${
              point.covered.join(', ') || 'none'
            })`}
          >
            <div className="progress-stack">
              {[...STAR_ELEMENTS].reverse().map((element) => (
                <span
                  key={element}
                  className={`progress-cell star-${element.toLowerCase()}${
                    point.covered.includes(element) ? ' filled' : ''
                  }`}
                />
              ))}
            </div>
            <span className="progress-date">{shortDate(point.created_at)}</span>
          </li>
        ))}
      </ol>
      <div className="progress-key" aria-hidden="true">
        {STAR_ELEMENTS.map((element) => (
          <span key={element} className={`star-${element.toLowerCase()}`}>
            {element}
          </span>
        ))}
      </div>
    </section>
  );
}
