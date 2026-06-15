import { describe, it, expect } from 'vitest';
import { prob, odds, edgePct } from '../types/branded.js';

describe('branded types', () => {
  describe('prob()', () => {
    it('rejects values below 0', () => {
      expect(() => prob(-0.01)).toThrow(RangeError);
    });
    it('rejects values above 1', () => {
      expect(() => prob(1.01)).toThrow(RangeError);
    });
    it('accepts 0', () => {
      expect(prob(0)).toBe(0);
    });
    it('accepts 1', () => {
      expect(prob(1)).toBe(1);
    });
    it('accepts a mid-range value', () => {
      expect(prob(0.45)).toBeCloseTo(0.45);
    });
  });

  describe('odds()', () => {
    it('rejects exactly 1.0', () => {
      expect(() => odds(1.0)).toThrow(RangeError);
    });
    it('rejects values below 1', () => {
      expect(() => odds(0.5)).toThrow(RangeError);
    });
    it('accepts minimum valid odds', () => {
      expect(odds(1.01)).toBeCloseTo(1.01);
    });
    it('accepts typical match odds', () => {
      expect(odds(2.1)).toBeCloseTo(2.1);
    });
  });

  describe('edgePct()', () => {
    it('accepts negative edge', () => {
      expect(edgePct(-5)).toBe(-5);
    });
    it('accepts positive edge', () => {
      expect(edgePct(4.5)).toBeCloseTo(4.5);
    });
    it('accepts zero', () => {
      expect(edgePct(0)).toBe(0);
    });
  });
});
