import { describe, expect, it } from 'vitest';
import { errorMessage, round } from '../src/util.js';

describe('round', () => {
    it('rounds to 3 decimal places by default', () => {
        expect(round(1.23456)).toBe(1.235);
        expect(round(2)).toBe(2);
    });

    it('rounds to the given number of decimal places', () => {
        expect(round(0.123456, 4)).toBe(0.1235);
        expect(round(1 / 3, 4)).toBe(0.3333);
    });
});

describe('errorMessage', () => {
    it('returns the message of an Error', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
    });

    it('returns a thrown string as is', () => {
        expect(errorMessage('boom')).toBe('boom');
    });

    it('stringifies other thrown values', () => {
        expect(errorMessage({ code: 1 })).toBe('[object Object]');
        expect(errorMessage(undefined)).toBe('undefined');
    });
});
