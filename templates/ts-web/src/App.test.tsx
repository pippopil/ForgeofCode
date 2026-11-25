import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('increments counter on button click', () => {
    render(<App />);
    const button = screen.getByRole('button', { name: 'Увеличить' });
    fireEvent.click(button);
    expect(screen.getByText('Счётчик: 1')).toBeTruthy();
  });
});
