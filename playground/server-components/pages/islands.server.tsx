import Counter from '../islands/Counter.tsx' with { island: 'load' };
import LazyCounter from '../islands/Counter.tsx' with { island: 'visible' };

export const prerender = false;

export default function Page() {
  return (
    <>
      <h1>Islands</h1>
      <p>Static text. Only the counters below ship JavaScript.</p>
      <Counter label="load" start={1} />
      <LazyCounter label="visible" start={10} />
    </>
  );
}
