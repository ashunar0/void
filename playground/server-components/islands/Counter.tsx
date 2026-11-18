import { useState } from 'void/jsx';

export default function Counter({ start = 0, label }: { start?: number; label: string }) {
  const [count, setCount] = useState(start);
  return (
    <div class="counter">
      <span>
        {label}: {count}
      </span>{' '}
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        +1
      </button>
      <input placeholder="type before hydration" />
    </div>
  );
}
