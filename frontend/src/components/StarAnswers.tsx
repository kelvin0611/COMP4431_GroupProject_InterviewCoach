import { Fragment, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { STAR_ELEMENTS } from '../lib/types';
import type { AnsweredTurn } from '../lib/types';
import { ErrorNotice } from './Common';
import { PolishPanel } from './PolishPanel';

function HighlightedAnswer({ answer }: { answer: AnsweredTurn }) {
  return (
    <p className="star-transcript" lang={answer.language === 'zh-HK' ? 'zh-HK' : 'en'}>
      {answer.segments.map((segment, index) => {
        if (!segment.element) return <span key={index}>{segment.text}</span>;
        const text = segment.text.trimEnd();
        return (
          <Fragment key={index}>
            <mark
              className={`star-mark star-${segment.element.toLowerCase()}`}
              data-element={segment.element}
              title={segment.element}
            >
              {text}
            </mark>
            {segment.text.slice(text.length)}
          </Fragment>
        );
      })}
    </p>
  );
}

/** The session's answers with STAR sentences coloured, each with a "stronger version" rewrite. */
export function StarAnswers({ sessionId }: { sessionId: string }) {
  const [answers, setAnswers] = useState<AnsweredTurn[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api
      .answers(sessionId)
      .then((data) => {
        if (active) setAnswers(data);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  if (error) return <ErrorNotice message={error} />;
  if (!answers?.length) return null;
  return (
    <section className="star-answers" aria-labelledby="star-answers-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">YOUR WORDS, IN STAR</p>
          <h2 id="star-answers-title">Your answers, highlighted</h2>
        </div>
        <div className="star-key" aria-label="Colour key">
          {STAR_ELEMENTS.map((element) => (
            <span key={element} className={`star-mark star-${element.toLowerCase()}`}>
              {element}
            </span>
          ))}
        </div>
      </div>
      {answers.map((answer, index) => (
        <article className="star-answer" key={answer.turn_id}>
          <p className="star-question">
            Q{index + 1}. {answer.question}
          </p>
          <HighlightedAnswer answer={answer} />
          <PolishPanel sessionId={sessionId} turnId={answer.turn_id} />
        </article>
      ))}
    </section>
  );
}
