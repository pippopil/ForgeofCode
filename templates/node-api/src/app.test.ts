import { describe, it, expect } from 'vitest';
import { createApp } from './app.js';

describe('node-api app', () => {
  it('creates an express application instance', () => {
    const app = createApp();
    expect(typeof app.use).toBe('function');
  });
});
