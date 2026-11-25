import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>Стартовый проект React + TypeScript</h1>
      <p>Счётчик: {count}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Увеличить
      </button>
    </main>
  );
}
